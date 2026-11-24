import { useEffect, useMemo, useRef, useState } from "react";
import { api, Installation, Standard } from "./api";
import { canDiff, ResolveDialog, ResolveDraft, stdKey } from "./Resolve";

/** The + on a standard: pick what's in a game folder, or type a path. */
export function AddToStandard({
  std,
  installations,
  notify,
  onClose,
  onDone,
}: {
  std: Standard;
  installations: Installation[];
  notify: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const [from, setFrom] = useState(""); // "": the Minecraft folder
  const [items, setItems] = useState<[string, boolean][] | null>(null);
  const [want, setWant] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState("");
  const [find, setFind] = useState("");
  const [clash, setClash] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [diffing, setDiffing] = useState<string | null>(null);
  // resolved clashes; written only once the add has gone through
  const [drafts, setDrafts] = useState<Record<string, ResolveDraft>>({});

  useEffect(() => {
    setItems(null);
    setWant(new Set());
    setClash([]);
    setDrafts({});
    api
      .listItems(from || null)
      .then(setItems)
      .catch((e) => {
        notify(String(e));
        setItems([]);
      });
    // notify can change identity between renders; only a new source should reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

  const have = useMemo(() => new Set(std.entries.map((e) => e.name)), [std]);
  const shown = (items ?? []).filter(([n]) => !have.has(n) && n.toLowerCase().includes(find.toLowerCase()));
  const path = typed.trim().replace(/^\/+|\/+$/g, "");
  const names = [...want, ...(path && !want.has(path) ? [path] : [])];
  const isDir = (n: string) => items?.some(([x, d]) => x === n && d) ?? false;
  const source = from || "the Minecraft folder";
  const fromFolderToShared = std.builtin && !from;
  const resolved = Object.values(drafts);
  const allResolved = clash.length > 0 && clash.every((n) => drafts[n]);

  async function add(replace = false, merge = false) {
    if (!names.length || busy) return;
    setBusy(true);
    try {
      const inWay = await api.addToStandard(std.name, from || null, names, replace, merge);
      if (inWay.length && !replace) {
        setClash(inWay);
      } else {
        // after the add: replacing copies the source over the standard's file
        for (const d of resolved) await api.writeMerged(d);
        notify(
          `Added ${names.length === 1 ? names[0] : `${names.length} items`} to ${std.name}` +
            (from ? ` · ${from} now links to it` : "") +
            (resolved.length ? ` · ${resolved.length} resolved` : "")
        );
        onDone();
        ref.current?.close();
      }
    } catch (e) {
      notify(String(e));
    }
    setBusy(false);
  }

  const toggle = (n: string) => {
    const next = new Set(want);
    next.has(n) ? next.delete(n) : next.add(n);
    setWant(next);
    setClash([]);
    setDrafts({});
  };

  return (
    <>
    <dialog
      ref={ref}
      className="share-dialog le-dialog"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && !busy && ref.current.close()}
    >
      <div className="share-body">
        <header className="share-head">
          <div>
            <h2>Add to {std.name}</h2>
            <p className="hint">
              {from
                ? `Moves it into ${std.name}, then links it back into ${from}.`
                : fromFolderToShared
                  ? "It stays where it is and becomes linkable into any installation."
                  : `Copies it into ${std.name}.`}
            </p>
          </div>
        </header>

        <label className="add-from">
          Take it from
          <select value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy}>
            <option value="">Minecraft folder</option>
            {installations.map((i) => (
              <option key={i.name} value={i.name}>
                {i.name}
              </option>
            ))}
          </select>
        </label>

        {(items?.length ?? 0) > 8 && (
          <input className="search" placeholder="Find…" value={find} onChange={(e) => setFind(e.target.value)} />
        )}
        <div className="share-files le-files">
          {!items ? (
            <div className="le-row skeleton" />
          ) : shown.length === 0 ? (
            <p className="le-empty">Nothing else to add from {source}.</p>
          ) : (
            shown.map(([n, dir]) => (
              <label key={n} className="le-row">
                <input type="checkbox" checked={want.has(n)} onChange={() => toggle(n)} />
                <span className="le-name">
                  {n}
                  {dir ? "/" : ""}
                </span>
                {n === "config" && <span className="le-pill idle">file by file</span>}
              </label>
            ))
          )}
        </div>

        <label className="add-path">
          Or type a path
          <input
            value={typed}
            placeholder="journeymap  ·  config/sodium.json"
            spellCheck={false}
            onChange={(e) => {
              setTyped(e.target.value);
              setClash([]);
              setDrafts({});
            }}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </label>

        {clash.length > 0 && (
          <div className="std-ask warn">
            <p>
              {std.name} already has <code>{clash.join(", ")}</code>.
            </p>
            <div className="row-inline">
              {clash.filter((n) => !isDir(n) && canDiff(n)).map((n) => (
                <button
                  key={n}
                  className={`btn small ${drafts[n] ? "primary" : ""}`}
                  disabled={busy}
                  onClick={() => setDiffing(n)}
                >
                  {drafts[n] ? `${n} resolved · ${drafts[n].changes}` : `Resolve ${n}`}
                </button>
              ))}
              {from && clash.some(isDir) && (
                <button className="btn small primary" disabled={busy} onClick={() => add(false, true)}>
                  Merge folders, keep both
                </button>
              )}
              {!allResolved && (
                <button className="btn small danger" disabled={busy} onClick={() => add(true)}>
                  {from ? `Use ${std.name}'s, Trash ${from}'s` : `Replace ${std.name}'s`}
                </button>
              )}
            </div>
            {resolved.length > 0 && <p className="hint">Resolved files aren't saved until you finish adding.</p>}
          </div>
        )}

        <footer className="share-foot le-foot">
          <button className="btn" onClick={() => ref.current?.close()} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => add(allResolved)} disabled={!names.length || busy}>
            {busy ? "Working…" : allResolved ? `Add and save ${resolved.length} resolved` : names.length ? `Add ${names.length}` : "Add"}
          </button>
        </footer>
      </div>
    </dialog>
    {diffing && (
      <ResolveDialog
        dest={diffing}
        into={stdKey(std)}
        from={from}
        onClose={() => setDiffing(null)}
        draft={drafts[diffing]}
        onStage={(d) => {
          const { [diffing]: _, ...rest } = drafts;
          setDrafts(d ? { ...rest, [diffing]: d } : rest);
        }}
      />
    )}
    </>
  );
}
