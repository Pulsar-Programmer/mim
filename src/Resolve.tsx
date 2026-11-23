import { useEffect, useMemo, useState } from "react";
import { api, OptionsSource } from "./api";
import { compare, mergeText, sameValue } from "./compare";
import { plural } from "./LinkEditor";
import { LineDiff, TEXT } from "./LinkWizard";
import { Modal } from "./Modal";
import { labelOf, show } from "./OptionsView";
import { stdScope } from "./Places";

/** One real file, and every place that uses it through a link. */
interface Side {
  keys: string[];
  label: string;
  users: string[];
  path: string;
  text: string;
}

const keyOf = (s: OptionsSource) => (s.kind === "base" ? "" : s.kind === "standard" ? stdScope(s.label) : s.label);
/** The place key for a standard, as `into` / `from` expect. */
export const stdKey = (s: { name: string; builtin: boolean }) => (s.builtin ? "" : stdScope(s.name));
export const canDiff = (name: string) => TEXT.test(name);

async function loadSides(dest: string): Promise<Side[]> {
  const byFile = new Map<string, OptionsSource[]>();
  for (const s of await api.diffSources(dest))
    if (s.exists) byFile.set(s.target, [...(byFile.get(s.target) ?? []), s]);
  const sides = await Promise.all(
    [...byFile.values()].map(async (group) => {
      // a standard names a shared file better than an installation linked to it
      const owner = group.find((s) => s.kind !== "installation") ?? group[0];
      try {
        return {
          keys: group.map(keyOf),
          label: owner.kind === "base" ? "Shared" : owner.label,
          users: group.filter((s) => s !== owner && s.kind === "installation").map((s) => s.label),
          path: owner.path,
          text: await api.readConfig(owner.path),
        };
      } catch {
        return null; // too big or not text: nothing to compare
      }
    })
  );
  return sides.filter((s): s is Side => !!s);
}

/** A resolved file waiting for the caller's own confirm step. Nothing is on disk yet. */
export interface ResolveDraft {
  path: string;
  otherPath: string;
  choice: Record<string, Choice>;
  whole: boolean;
  text: string;
  changes: number;
}

/** Which file's value a setting takes; null: not set, so it's removed. */
type Choice = 0 | 1 | null;

/**
 * A file's differences in one list: click the value to keep on each row.
 * Never writes: it hands back a draft for the caller's last step to save.
 */
export function ResolveDialog({
  dest,
  into,
  from,
  onClose,
  draft,
  onStage,
}: {
  dest: string;
  /** place keys: "" for Shared, a standard's scope, or an installation's name */
  into?: string;
  from?: string;
  onClose: () => void;
  /** the earlier draft to reopen */
  draft?: ResolveDraft;
  /** keeps the result as a draft; null clears it */
  onStage: (d: ResolveDraft | null) => void;
}) {
  const [sides, setSides] = useState<Side[] | null>(null);
  const [pair, setPair] = useState<[number, number]>([0, 1]);
  const [choice, setChoice] = useState<Record<string, Choice>>(draft?.choice ?? {});
  const [whole, setWhole] = useState(draft?.whole ?? false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadSides(dest)
      .then((list) => {
        const found = list.findIndex((s) => into !== undefined && s.keys.includes(into));
        // a draft must never land in a different file than the one it's for
        if (found < 0) return setSides([]);
        const a = Math.max(0, found);
        const named = list.findIndex(
          (s, i) => i !== a && (draft ? s.path === draft.otherPath : from !== undefined && s.keys.includes(from))
        );
        const differing = list.findIndex((s, i) => i !== a && s.text !== list[a]?.text);
        setSides(list);
        setPair([a, named >= 0 ? named : differing >= 0 ? differing : a === 0 ? 1 : 0]);
      })
      .catch((e) => setError(String(e)));
    // only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const a = sides?.[pair[0]];
  const b = sides?.[pair[1]];
  const cmp = useMemo(() => (a && b ? compare([a.text, b.text], dest) : null), [a, b, dest]);
  const keys = cmp?.keys ?? [];
  const isOptions = dest === "options.txt";
  const allKeys = useMemo(
    () =>
      cmp
        ? [...new Set(cmp.maps.flatMap((m) => [...m.keys()]))].filter((k) => !(isOptions && k === "version"))
        : [],
    [cmp, isOptions]
  );
  const rows = showAll ? allKeys : keys;
  // what's already in the saved file stays; settings only the other has come along
  const chosen = (k: string): Choice => {
    const c = k in choice ? choice[k] : cmp!.maps[0].has(k) ? 0 : 1;
    return c !== null && cmp!.maps[c].has(k) ? c : null;
  };
  const changed = (k: string) => {
    const c = chosen(k);
    const mine = cmp!.maps[0].get(k);
    return c === null ? mine !== undefined : c === 1 && !sameValue(mine, cmp!.maps[1].get(k));
  };
  const changes = cmp?.mergeable ? allKeys.filter(changed).length : whole ? 1 : 0;
  const value = (k: string, v?: string) => (isOptions ? show(k, v) : (v ?? "not set"));

  function choosePair(next: [number, number]) {
    setPair(next);
    setChoice({});
    setWhole(false);
    setError("");
  }

  function save() {
    if (!a || !b || !cmp) return;
    if (!changes) {
      if (draft) {
        onStage(null);
        onClose();
      }
      return;
    }
    setError("");
    try {
      const picks = Object.fromEntries(allKeys.filter((k) => changed(k) && chosen(k) === 1).map((k) => [k, 1]));
      const skip = new Set(allKeys.filter((k) => chosen(k) === null));
      const text = whole ? b.text : mergeText([a.text, b.text], cmp, dest, 0, picks, skip);
      if (text == null) throw new Error("This file can't be merged");
      onStage({ path: a.path, otherPath: b.path, choice, whole, text, changes });
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  const column = (at: 0 | 1) => (
    <div className="rs-col">
      <select
        aria-label={at === 0 ? "File to save to" : "File to compare with"}
        value={pair[at]}
        disabled={at === 0}
        onChange={(e) => choosePair(at === 0 ? [+e.target.value, pair[1]] : [pair[0], +e.target.value])}
      >
        {sides!.map((s, i) => (
          <option key={s.path} value={i} disabled={i === pair[at === 0 ? 1 : 0]}>
            {s.label}
            {s.users.length ? ` (+${s.users.length} linked)` : ""}
          </option>
        ))}
      </select>
      {cmp?.mergeable && rows.length > 1 && (
        <button
          className="linklike"
          onClick={() => setChoice({ ...choice, ...Object.fromEntries(rows.map((k) => [k, at])) })}
        >
          use all
        </button>
      )}
    </div>
  );

  return (
    <Modal
      className="share-dialog rs-dialog"
      label={`Resolve ${dest}`}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
        e.stopPropagation(); // the screen behind has its own Cmd+Enter
        save();
      }}
    >
      <div className="share-body">
        <header className="rs-head">
          <h2>{dest}</h2>
          {cmp && (
            <span className="rs-head-side">
              {cmp.kind !== "same" && cmp.kind !== "unknown" && (
                <span className="le-count">{plural(keys.length, "difference")}</span>
              )}
              <button className="btn small" aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>
                {showAll ? "Only differences" : cmp.kind === "unknown" ? "Show full files" : `Show all ${allKeys.length}`}
              </button>
            </span>
          )}
        </header>

        {!sides ? (
          error ? <p className="sf-error" role="alert">{error}</p> : <div className="le-row skeleton" />
        ) : sides.length < 2 || !a || !b || !cmp ? (
          <p className="le-empty">Only one copy of this file exists, so there's nothing to compare.</p>
        ) : (
          <>
            <div className="rs-grid rs-columns">
              <span className="rs-saves">"Not saved yet"</span>
              {column(0)}
              {column(1)}
              <span />
            </div>
            <div className="rs-list">
              {cmp.kind === "same" && !showAll ? (
                <p className="le-empty">These two match.</p>
              ) : cmp.kind === "unknown" && showAll ? (
                <div className="rs-files">
                  <pre className="lw-pre">{a.text}</pre>
                  <pre className="lw-pre">{b.text}</pre>
                </div>
              ) : cmp.kind === "unknown" ? (
                <div className="rs-lines">
                  <LineDiff versions={[{ hash: "a" }, { hash: "b" }]} keeper={0} texts={[a.text, b.text]} />
                </div>
              ) : (
                rows.map((k) => {
                  const c = chosen(k);
                  const both = cmp.maps[0].has(k) && cmp.maps[1].has(k);
                  return (
                  <div key={k} className={`rs-grid rs-row ${keys.includes(k) ? "" : "same"}`}>
                    <span className="rs-key" title={k}>
                      {isOptions ? labelOf(k) : k}
                    </span>
                    {([0, 1] as const).map((at) => {
                      const v = cmp.maps[at].get(k);
                      const on = v === undefined ? c === null : c !== null && sameValue(v, cmp.maps[c].get(k));
                      return (
                        <button
                          key={at}
                          className={`rs-value ${v === undefined ? "unset" : ""}`}
                          aria-pressed={cmp.mergeable ? on : undefined}
                          aria-label={`${k}: use ${at ? b.label : a.label}'s ${value(k, v)}`}
                          title={v}
                          disabled={!cmp.mergeable}
                          onClick={() => setChoice({ ...choice, [k]: at })}
                        >
                          {value(k, v)}
                        </button>
                      );
                    })}
                    {both && cmp.mergeable ? (
                      <button
                        className="rs-value rs-unset unset"
                        aria-pressed={c === null}
                        aria-label={`${k}: not set`}
                        title="Remove this setting"
                        onClick={() => setChoice({ ...choice, [k]: null })}
                      >
                        Not set
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                  );
                })
              )}
            </div>
            {!cmp.mergeable && cmp.kind !== "same" && (
              <label className="rs-whole">
                <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
                This format can't be mixed. Replace {a.label}'s file with {b.label}'s
              </label>
            )}
            {a.users.length > 0 && changes > 0 && (
              <p className="hint rs-note">Also changes it for {a.users.join(", ")}.</p>
            )}
            {error && <p className="sf-error" role="alert">{error}</p>}
          </>
        )}

        <footer className="share-foot le-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          {a && b && cmp && (cmp.kind !== "same" || showAll || !!draft) && (
            <button className="btn primary" onClick={save} disabled={!changes && !draft}>
              {changes ? `Use ${plural(changes, "change")}` : draft ? "Clear changes" : "No changes"}
            </button>
          )}
        </footer>
      </div>
    </Modal>
  );
}
