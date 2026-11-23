import { useEffect, useMemo, useRef, useState } from "react";
import { Installation, Standard, StandardEntry } from "./api";
import { buildTree, CARET, DIR, FILE, leaves, plural, TreeNode } from "./LinkEditor";
import { StandardAvatar } from "./Places";

/** How many top-level items a standard's card shows before "+N more". */
const CARD_ITEMS = 8;

/** Folders first, then by name. */
function sorted(nodes: TreeNode[]): TreeNode[] {
  for (const n of nodes) n.kids = sorted(n.kids);
  return [...nodes].sort(
    (a, b) => Number(!!a.entry) - Number(!!b.entry) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

const who = (names: string[]) =>
  names.length === 0
    ? "Not linked"
    : names.length <= 2
      ? names.join(", ")
      : `${names[0]}, ${names[1]} +${names.length - 2}`;

/** A standard's card: its top-level items, with folders folded into a count. */
export function StandardSummary({
  s,
  armed,
  onRemove,
  onAdd,
  onView,
}: {
  s: Standard;
  armed: string | null;
  onRemove: (s: Standard, e: StandardEntry) => void;
  onAdd: () => void;
  onView: () => void;
}) {
  const top = useMemo(() => sorted(buildTree(s.entries)), [s.entries]);
  return (
    <div className={`std-files ${s.entries.length ? "" : "empty-list"}`}>
      {top.slice(0, CARD_ITEMS).map((n) =>
        n.entry ? (
          <span
            key={n.path}
            className={`std-file ${n.entry.missing ? "missing" : ""}`}
            title={n.entry.missing ? "Not in the Minecraft folder yet" : undefined}
          >
            {n.name}
            {n.entry.is_dir ? "/" : ""}
            <RemoveButton s={s} e={n.entry} armed={armed} onRemove={onRemove} />
          </span>
        ) : (
          <button key={n.path} className="std-file std-folder" title={`View ${n.name}/`} onClick={onView}>
            {n.name}/ <span className="std-file-n">{leaves(n).length}</span>
          </button>
        )
      )}
      {top.length > CARD_ITEMS && (
        <button className="std-file std-folder" onClick={onView}>
          +{top.length - CARD_ITEMS} more
        </button>
      )}
      <button className="std-add-btn" aria-label={`Add to ${s.name}`} title="Add a file or folder" onClick={onAdd}>
        +{s.entries.length === 0 && " Add files or folders"}
      </button>
    </div>
  );
}

function RemoveButton({
  s,
  e,
  armed,
  onRemove,
}: {
  s: Standard;
  e: StandardEntry;
  armed: string | null;
  onRemove: (s: Standard, e: StandardEntry) => void;
}) {
  const isArmed = armed === `rm:${e.rel_path}`;
  return (
    <button
      className={`std-file-x ${isArmed ? "armed" : ""}`}
      aria-label={s.builtin ? `Take ${e.name} off Shared` : `Remove ${e.name} from ${s.name}`}
      title={s.builtin ? "Take off the list — its files stay" : "Move to Trash — installations using it keep their own copy"}
      onClick={() => onRemove(s, e)}
    >
      {isArmed ? "Sure?" : "×"}
    </button>
  );
}

/** Everything in every standard, by folder, and which installations link each file. */
export function StandardFiles({
  standards,
  installations,
  initial,
  armed,
  onRemove,
  onAdd,
  onEdit,
  onClose,
}: {
  standards: Standard[];
  installations: Installation[];
  /** the standard to open on; null for all of them */
  initial: string | null;
  armed: string | null;
  onRemove: (s: Standard, e: StandardEntry) => void;
  onAdd: (s: Standard) => void;
  onEdit: (s: Standard, i: Installation) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const [sel, setSel] = useState(initial);
  const [instName, setInstName] = useState("");
  const [q, setQ] = useState("");
  // folders start open at the top level and closed below; this holds the ones toggled
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const needle = q.trim().toLowerCase();

  const current = standards.find((s) => s.name === sel);
  const inst = installations.find((i) => i.name === instName);

  // rel_path starts with the standard's name, so it's unique across standards
  const users = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of standards)
      for (const [name, rels] of Object.entries(s.linked))
        for (const r of rels) m.set(r, [...(m.get(r) ?? []), name]);
    for (const names of m.values()) names.sort((a, b) => a.localeCompare(b));
    return m;
  }, [standards]);

  const groups = useMemo(
    () =>
      (current ? [current] : standards).flatMap((s) => {
        const live = instName ? new Set(s.linked[instName] ?? []) : null;
        const entries = s.entries.filter(
          (e) => (!live || live.has(e.rel_path)) && (!needle || e.name.toLowerCase().includes(needle))
        );
        return entries.length ? [{ s, count: entries.length, tree: sorted(buildTree(entries)) }] : [];
      }),
    [standards, current, instName, needle]
  );
  const total = groups.reduce((n, g) => n + g.count, 0);

  function toggle(key: string) {
    const next = new Set(toggled);
    next.has(key) ? next.delete(key) : next.add(key);
    setToggled(next);
  }

  const row = (s: Standard, n: TreeNode, depth: number) => {
    const pad = { paddingLeft: 12 + depth * 18 };
    if (!n.entry) {
      const key = `${s.name}:${n.path}`;
      const open = !!needle || (depth === 0) !== toggled.has(key);
      const ls = leaves(n);
      const linkedIn = new Set(ls.flatMap((r) => users.get(r) ?? [])).size;
      return (
        <div key={key} className="le-group">
          <button className="le-row folder sf-folder" style={pad} aria-expanded={open} onClick={() => toggle(key)}>
            <span className={`le-caret ${open ? "open" : ""}`}>{CARET}</span>
            <span className="le-ico dir">{DIR}</span>
            <span className="le-name">{n.name}/</span>
            <span className="le-count">
              {plural(ls.length, "file")} · {linkedIn ? `in ${plural(linkedIn, "installation")}` : "not linked"}
            </span>
          </button>
          {open && n.kids.map((c) => row(s, c, depth + 1))}
        </div>
      );
    }
    const e = n.entry;
    const names = users.get(e.rel_path) ?? [];
    return (
      <div
        key={e.rel_path}
        className={`le-row sf-row ${e.missing ? "missing" : ""}`}
        style={pad}
        title={e.missing ? "Not in the Minecraft folder yet" : undefined}
      >
        <span className="le-caret-gap" />
        <span className={`le-ico ${e.is_dir ? "dir" : ""}`}>{e.is_dir ? DIR : FILE}</span>
        <span className="le-name" title={e.name}>
          {n.name}
          {e.is_dir ? "/" : ""}
        </span>
        {e.scope !== "global" && <span className="chip">{e.scope}</span>}
        <span className={`sf-who ${names.length ? "" : "none"}`} title={names.join(", ") || undefined}>
          {who(names)}
        </span>
        <RemoveButton s={s} e={e} armed={armed} onRemove={onRemove} />
      </div>
    );
  };

  return (
    <dialog
      ref={ref}
      className="share-dialog sf-dialog"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}
    >
      <div className="share-body">
        <header className="sf-head">
          <h2>Files</h2>
          <input
            className="search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a file…"
            aria-label="Find a file"
          />
          <select
            className="search sf-inst"
            value={instName}
            onChange={(e) => setInstName(e.target.value)}
            aria-label="Show what's linked in an installation"
          >
            <option value="">All installations</option>
            {installations.map((i) => (
              <option key={i.name} value={i.name}>
                {i.name}
              </option>
            ))}
          </select>
          <button className="linklike" onClick={() => ref.current?.close()}>
            close
          </button>
        </header>

        <div className="sf-layout">
          <nav className="sf-side" aria-label="Standards">
            <button className={`sf-std ${sel === null ? "on" : ""}`} onClick={() => setSel(null)}>
              <span className="le-name">All standards</span>
              <span className="le-count">{standards.reduce((n, s) => n + s.entries.length, 0)}</span>
            </button>
            {standards.map((s) => (
              <button key={s.name} className={`sf-std ${sel === s.name ? "on" : ""}`} onClick={() => setSel(s.name)}>
                <StandardAvatar s={s} />
                <span className="le-name">{s.name}</span>
                <span className="le-count">{s.entries.length}</span>
              </button>
            ))}
          </nav>

          <div className="sf-main">
            <div className="share-label">
              <span>{plural(total, "item")}{inst ? ` linked in ${inst.name}` : ""}</span>
              {current && (
                <span className="le-quick">
                  <button className="linklike" onClick={() => onAdd(current)}>
                    add files
                  </button>
                  {inst && (
                    <button className="linklike" onClick={() => onEdit(current, inst)}>
                      edit links
                    </button>
                  )}
                </span>
              )}
            </div>
            <div className="share-files le-files sf-tree">
              {groups.map(({ s, count, tree }) => (
                <section key={s.name}>
                  {!current && (
                    <h3 className="sf-group">
                      {s.name} <span className="le-count">{plural(count, "item")}</span>
                    </h3>
                  )}
                  {tree.map((n) => row(s, n, 0))}
                </section>
              ))}
              {groups.length === 0 && (
                <p className="le-empty">
                  {needle ? `No files match "${q.trim()}".` : inst ? `Nothing here is linked in ${inst.name}.` : "No files yet."}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
