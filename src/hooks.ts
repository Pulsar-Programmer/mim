import { useCallback, useEffect, useState } from "react";

const cache = new Map<string, unknown>();

/**
 * Stale-while-revalidate: shows the last result for `key` instantly when a
 * view remounts, then refreshes in the background.
 */
export function useCached<T>(
  key: string,
  fetch: () => Promise<T>,
  onError: (m: string) => void
): [T | undefined, () => void] {
  const [state, setState] = useState<{ key: string; data?: T }>(() => ({
    key,
    data: cache.get(key) as T | undefined,
  }));
  const reload = useCallback(() => {
    fetch()
      .then((d) => {
        cache.set(key, d);
        setState({ key, data: d });
      })
      .catch((e) => onError(String(e)));
    // fetch is an inline closure; the key identifies it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, onError]);
  useEffect(reload, [reload]);
  // on a key switch, show that key's cached value rather than the previous key's
  const data = state.key === key ? state.data : (cache.get(key) as T | undefined);
  return [data, reload];
}

/** Two-click guard: first click arms `key` for 3s, the second runs it. */
export function useConfirm(notify: (m: string) => void, after: () => void) {
  const [armed, setArmed] = useState<string | null>(null);
  async function confirm(key: string, run: () => Promise<string>) {
    if (armed !== key) {
      setArmed(key);
      setTimeout(() => setArmed((c) => (c === key ? null : c)), 3000);
      return;
    }
    setArmed(null);
    try {
      notify(await run());
    } catch (e) {
      notify(String(e));
    }
    after();
  }
  return { armed, confirm };
}
