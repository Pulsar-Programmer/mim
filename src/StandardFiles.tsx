import { useEffect, useMemo, useRef, useState } from "react";
import { api, Installation, Standard } from "./api";
import { buildTree, CARET, DIR, FILE, leaves, plural, TreeNode } from "./LinkEditor";
import { Modal } from "./Modal";
import { StandardAvatar } from "./Places";
import { canDiff, ResolveDialog, ResolveDraft, stdKey } from "./Resolve";

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
  onRemove,
  onAdd,
  onView,
}: {
  s: Standard;
  onRemove: (s: Standard, rels: string[]) => void;
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
            <RemoveButton s={s} name={n.name} rels={[n.entry.rel_path]} onRemove={onRemove} />
          </span>
        ) : (
          <button key={n.path} className="std-file std-folder" title={`Edit ${n.name}/`} onClick={onView}>
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
  name,
  rels,
  onRemove,
}: {
  s: Standard;
  name: string;
  rels: string[];
  onRemove: (s: Standard, rels: string[]) => void;
}) {
  return (
    <button
      className="std-file-x"
      aria-label={`Remove ${name} from ${s.name}`}
      title="Remove…"
      onClick={() => onRemove(s, rels)}
    >
      ×
    </button>
  );
}

/** Spells out what removing items does before doing it. */
export function RemoveFromStandard({
  s,
  rels,
  notify,
  onClose,
  onDone,
}: {
  s: Standard;
  rels: string[];
  notify: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const names = s.entries.filter((e) => rels.includes(e.rel_path)).map((e) => e.name);
  const users = Object.entries(s.linked)
    .filter(([, linked]) => linked.some((r) => rels.includes(r)))
    .map(([n]) => n)
    .sort((a, b) => a.localeCompare(b));
  const what = names.length === 1 ? names[0] : plural(names.length, "item");
  const them = names.length === 1 ? "it" : "them";
  const dropsLinks = users.length > 0 && !keep;

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api.removeFromStandard(s.name, rels, keep);
      notify(
        `Removed ${what} from ${s.name}` +
          (users.length ? (keep ? " · installations kept copies" : ` · gone from ${plural(users.length, "installation")}`) : "")
      );
      onDone();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Modal className="share-dialog le-dialog" label={`Remove from ${s.name}`} locked={busy} onClose={onClose}>
      <div className="share-body">
        <header className="share-head">
          <div>
            <h2>Remove {what} from {s.name}?</h2>
            <p className="hint">
              {s.builtin
                ? `The original stays in the Minecraft folder. It just stops being shared.`
                : `${s.name}'s ${names.length === 1 ? "copy goes" : "copies go"} to the Trash, so you can put ${them} back.`}
            </p>
          </div>
        </header>
        <div className="le-review">
          <section className={`le-sec ${s.builtin && !dropsLinks ? "" : "trash"}`}>
            <h3>{plural(names.length, "item")}</h3>
            <span className="le-list">
              {names.slice(0, 8).map((n) => (
                <code key={n}>{n}</code>
              ))}
              {names.length > 8 && <code>+{names.length - 8} more</code>}
            </span>
          </section>
          {users.length > 0 ? (
            <section className={`le-sec drop ${keep ? "" : "trash"}`}>
              <h3>Linked in {plural(users.length, "installation")}</h3>
              <span className="le-list">
                {users.map((u) => (
                  <code key={u}>{u}</code>
                ))}
              </span>
              <div className="le-seg" role="radiogroup" aria-label="What happens in these installations">
                <button role="radio" aria-checked={keep} className={keep ? "on" : ""} onClick={() => setKeep(true)}>
                  Leave copies there
                </button>
                <button role="radio" aria-checked={!keep} className={keep ? "" : "on"} onClick={() => setKeep(false)}>
                  Delete there too
                </button>
              </div>
              <p>
                {keep
                  ? `Each one keeps its own separate copy, no longer tied to ${s.name}.`
                  : s.builtin
                    ? `They lose ${them}. Only the Minecraft folder still has ${them}.`
                    : `They lose ${them}. The Trash holds the only copy.`}
              </p>
            </section>
          ) : (
            <p className="hint">No installation links {names.length === 1 ? "this" : "these"}.</p>
          )}
          {error && (
            <p className="sf-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="share-foot le-foot">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${s.builtin && !dropsLinks ? "primary" : "danger solid"}`}
            onClick={remove}
            disabled={busy}
          >
            {busy ? "Working…" : s.builtin ? "Remove" : "Move to Trash"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}

/** Everything in every standard, by folder, and which installations link each file. */
export function StandardFiles({
  standards,
  installations,
  initial,
  onRemove,
  onAdd,
  onEdit,
  notify,
  onDone,
  onClose,
}: {
  standards: Standard[];
  installations: Installation[];
  /** the standard to open on; null for all of them */
  initial: string | null;
  onRemove: (s: Standard, rels: string[]) => void;
  onAdd: (s: Standard) => void;
  onEdit: (s: Standard, i: Installation) => void;
  notify: (m: string) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const [sel, setSel] = useState(initial);
  const [instName, setInstName] = useState("");
  const [q, setQ] = useState("");
  // folders start open at the top level and closed below; this holds the ones toggled
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [diffing, setDiffing] = useState<{ s: Standard; rel: string; dest: string } | null>(null);
  // resolved files, keyed by rel_path; only the Save bar writes them
  const [drafts, setDrafts] = useState<Record<string, ResolveDraft>>({});
  const [saving, setSaving] = useState(false);
  const needle = q.trim().toLowerCase();
  const pending = Object.entries(drafts).filter(([r]) => standards.some((s) => s.entries.some((e) => e.rel_path === r)));

  async function saveDrafts() {
    setSaving(true);
    try {
      for (const [r, d] of pending) {
        await api.writeMerged(d);
        setDrafts(({ [r]: _, ...rest }) => rest);
      }
      notify(`Saved ${plural(pending.length, "resolved file")} · old versions in Trash`);
    } catch (e) {
      notify(String(e));
    }
    setSaving(false);
    onDone();
  }

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
          <div className="sf-folder-row">
            <button className="le-row folder sf-folder" style={pad} aria-expanded={open} onClick={() => toggle(key)}>
              <span className={`le-caret ${open ? "open" : ""}`}>{CARET}</span>
              <span className="le-ico dir">{DIR}</span>
              <span className="le-name">{n.name}/</span>
              <span className="le-count">
                {plural(ls.length, "file")} · {linkedIn ? `in ${plural(linkedIn, "installation")}` : "not linked"}
              </span>
            </button>
            <RemoveButton s={s} name={`${n.name}/`} rels={ls} onRemove={onRemove} />
          </div>
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
        {!e.is_dir && !e.missing && canDiff(e.name) && (
          <button
            className={`btn small sf-diff ${drafts[e.rel_path] ? "primary" : ""}`}
            aria-label={`Resolve ${e.name}`}
            onClick={() => setDiffing({ s, rel: e.rel_path, dest: e.name })}
          >
            {drafts[e.rel_path] ? `Resolved · ${drafts[e.rel_path].changes}` : "Resolve"}
          </button>
        )}
        <RemoveButton s={s} name={e.name} rels={[e.rel_path]} onRemove={onRemove} />
      </div>
    );
  };

  return (
    <>
    <dialog
      ref={ref}
      className="share-dialog sf-dialog"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && !saving && ref.current.close()}
    >
      <div className="share-body">
        <header className="sf-head">
          <h2>Edit files</h2>
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
                      {s.name} <span className="le-count">{plural(count, "item")}</span>{" "}
                      <button className="linklike" onClick={() => onAdd(s)}>
                        add files
                      </button>
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
        {pending.length > 0 && (
          <footer className="share-foot le-foot">
            <span className="hint">
              {plural(pending.length, "resolved file")} not saved yet. Close to throw {pending.length === 1 ? "it" : "them"} away.
            </span>
            <button className="btn" onClick={() => setDrafts({})} disabled={saving}>
              Discard
            </button>
            <button className="btn primary" onClick={saveDrafts} disabled={saving}>
              {saving ? "Saving…" : `Save ${plural(pending.length, "file")}`}
            </button>
          </footer>
        )}
      </div>
    </dialog>
    {diffing && (
      <ResolveDialog
        dest={diffing.dest}
        into={stdKey(diffing.s)}
        onClose={() => setDiffing(null)}
        draft={drafts[diffing.rel]}
        onStage={(d) => {
          const { [diffing.rel]: _, ...rest } = drafts;
          setDrafts(d ? { ...rest, [diffing.rel]: d } : rest);
        }}
      />
    )}
    </>
  );
}
