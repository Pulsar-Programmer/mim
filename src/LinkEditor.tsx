import { useEffect, useMemo, useState } from "react";
import { api, entriesFor, Installation, LinkState, Standard, StandardEntry } from "./api";
import { Modal } from "./Modal";
import { Avatar, StandardAvatar } from "./Places";
import { canDiff, ResolveDialog, ResolveDraft, stdKey } from "./Resolve";

export const DIR = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
    <path
      d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
      fill="currentColor"
    />
  </svg>
);
export const CARET = (
  <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden><path d="M3.5 1.5 7 5 3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const FILE = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
    <path d="M4 1.5h5l3.5 3.5v8.5a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" fill="currentColor" />
  </svg>
);

/** config/ files come in one by one ("config/fabric/x.toml"): fold them into folders. */
export interface TreeNode {
  name: string;
  path: string;
  entry?: StandardEntry;
  kids: TreeNode[];
}

export function buildTree(entries: StandardEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kids: [] };
  for (const e of entries) {
    const parts = e.name.split("/");
    let at = root;
    parts.slice(0, -1).forEach((p, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let f = at.kids.find((k) => !k.entry && k.path === path);
      if (!f) at.kids.push((f = { name: p, path, kids: [] }));
      at = f;
    });
    at.kids.push({ name: parts[parts.length - 1], path: e.rel_path, entry: e, kids: [] });
  }
  return root.kids;
}

export const leaves = (n: TreeNode): string[] => (n.entry ? [n.entry.rel_path] : n.kids.flatMap(leaves));
const foldersOf = (nodes: TreeNode[]): TreeNode[] =>
  nodes.filter((n) => !n.entry).flatMap((n) => [n, ...foldersOf(n.kids)]);
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Pick what of a standard is linked into one installation. Nothing changes
 * until Confirm; anything that deletes or unlinks is spelled out first.
 */
export function LinkEditor({
  std,
  inst,
  notify,
  onClose,
  onDone,
}: {
  std: Standard;
  inst: Installation;
  notify: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const entries = useMemo(() => entriesFor(std, inst.game_version), [std, inst]);
  const rels = entries.map((e) => e.rel_path);
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [states, setStates] = useState<Record<string, LinkState> | null>(null);
  const [want, setWant] = useState<Set<string>>(new Set());
  // what a ticked row does; unset means link for folders, copy for files
  const [modes, setModes] = useState<Record<string, "link" | "copy">>({});
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [review, setReview] = useState(false);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  // folders that are (or will be) one link instead of a link per file
  const [wholeNow, setWholeNow] = useState<Set<string>>(new Set());
  const [wantWhole, setWantWhole] = useState<Set<string>>(new Set());
  const [canWhole, setCanWhole] = useState<Set<string>>(new Set());
  const [inWay, setInWay] = useState<string[]>([]);
  const [diffing, setDiffing] = useState<string | null>(null);
  // resolved files by rel_path: written only by Apply, dropped when unticked or on leaving
  const [drafts, setDrafts] = useState<Record<string, ResolveDraft>>({});

  const nameOf = useMemo(() => new Map(entries.map((e) => [e.rel_path, e.name])), [entries]);
  const inFolder = (r: string, f: string) => nameOf.get(r)?.startsWith(`${f}/`) ?? false;
  const covered = (r: string) => [...wantWhole].some((f) => inFolder(r, f));
  const relsIn = (f: string) => rels.filter((r) => inFolder(r, f));

  const st = (r: string) => states?.[r]?.state;
  const linkedNow = rels.filter((r) => st(r) === "linked");

  useEffect(() => {
    const folders = foldersOf(tree).map((f): [string, string[]] => [f.path, leaves(f)]);
    Promise.all([
      api.linkStates(std.name, inst.name, rels),
      api.folderLinks(std.name, inst.name, folders),
    ])
      .then(([list, flinks]) => {
        const whole = new Set(flinks.filter((f) => f.whole).map((f) => f.folder));
        setCanWhole(new Set(flinks.map((f) => f.folder)));
        setWholeNow(whole);
        setWantWhole(whole);
        const map = Object.fromEntries(rels.map((r, k) => [r, list[k]]));
        setStates(map);
        const linked = rels.filter((r) => map[r].state === "linked");
        // first link: everything ticked, except what would cost the installation its own copy
        setWant(new Set(linked.length ? linked : rels.filter((r) => map[r].state !== "own")));
      })
      .catch((e) => {
        notify(String(e));
        onClose();
      });
    // only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isDir = (r: string) => entries.find((e) => e.rel_path === r)?.is_dir ?? false;
  // an old version-folder entry isn't the file at the standard's top level
  const diffable = (r: string) =>
    !isDir(r) && canDiff(nameOf.get(r) ?? "") && entries.find((e) => e.rel_path === r)?.scope === "global";
  const canResolve = (r: string) => want.has(r) && !covered(r) && (st(r) === "own" || st(r) === "other") && diffable(r);
  const draftList = Object.entries(drafts);

  useEffect(() => {
    setDrafts((d) => {
      const kept = Object.entries(d).filter(([r]) => canResolve(r));
      return kept.length === Object.keys(d).length ? d : Object.fromEntries(kept);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, wantWhole, states]);
  const modeOf = (r: string) => modes[r] ?? (st(r) === "linked" || isDir(r) ? "link" : "copy");
  const toLink = rels.filter((r) => want.has(r) && !covered(r) && modeOf(r) === "link" && st(r) !== "linked");
  const toCopy = rels.filter((r) => want.has(r) && !covered(r) && modeOf(r) === "copy");
  const toUnlink = linkedNow.filter((r) => !want.has(r) && !covered(r));
  const toWhole = [...wantWhole].filter((f) => !wholeNow.has(f));
  const toSplit = [...wholeNow].filter((f) => !wantWhole.has(f));
  // Shared folders the installation has its own of get merged in; the rest are replaced
  const merge = std.builtin ? toLink.filter((r) => st(r) === "own" && isDir(r)) : [];
  const trash = [...toLink, ...toCopy].filter((r) => st(r) === "own" && !merge.includes(r));
  const swap = [...toLink, ...toCopy].filter((r) => st(r) === "other");
  const changed = toLink.length + toCopy.length + toUnlink.length + toWhole.length + toSplit.length > 0;
  const risky = trash.length > 0 || inWay.length > 0 || (toUnlink.length > 0 && !keep);

  function flip(rs: string[], on: boolean) {
    const next = new Set(want);
    for (const r of rs) on ? next.add(r) : next.delete(r);
    setWant(next);
  }

  /** A folder as one link, a link per file, or the installation's own copy. */
  function setFolderMode(f: string, m: "whole" | "files" | "copy") {
    const next = new Set([...wantWhole].filter((x) => x !== f && !x.startsWith(`${f}/`)));
    if (m === "whole") next.add(f);
    setWantWhole(next);
    setWant(new Set([...want, ...relsIn(f)]));
    setModes({ ...modes, ...Object.fromEntries(relsIn(f).map((r) => [r, m === "copy" ? "copy" : "link"])) });
  }

  const label = (r: string) => {
    const e = entries.find((x) => x.rel_path === r)!;
    return e.name + (e.is_dir ? "/" : "");
  };
  const list = (rs: string[]) => (
    <span className="le-list">
      {rs.map((r) => (
        <code key={r}>{label(r)}</code>
      ))}
    </span>
  );

  async function confirm() {
    if (!changed || busy) return;
    if (toWhole.length) {
      try {
        const found = await api.folderLinks(std.name, inst.name, toWhole.map((f) => [f, relsIn(f)]));
        setInWay(found.flatMap((f) => f.in_way));
        setReview(true);
      } catch (e) {
        notify(String(e));
      }
      return;
    }
    setInWay([]);
    if (trash.length || toUnlink.length || draftList.length) setReview(true);
    else apply();
  }

  async function apply() {
    if (busy) return;
    setBusy(true);
    try {
      // first, so links and copies below carry the resolved version
      for (const [, d] of draftList) await api.writeMerged(d);
      let renamed: string[] = [];
      if (merge.length) renamed = await api.mergeShared(inst.name, merge.map((r) => r.split("/")[1]));
      // every file first, so unticked ones can still keep a copy below
      const split = rels.filter((r) => toSplit.some((f) => inFolder(r, f)));
      if (split.length) await api.linkStandard(std.name, inst.name, split, true);
      for (const f of toWhole) await api.linkFolder(std.name, inst.name, f, relsIn(f), true);
      // the whole wanted set, so already-linked items stay put
      const links = rels.filter((r) => want.has(r) && !covered(r) && modeOf(r) === "link");
      if (links.length) await api.linkStandard(std.name, inst.name, links, true);
      if (toCopy.length) await api.copyStandard(std.name, inst.name, toCopy);
      if (toUnlink.length) await api.unlinkStandard(std.name, inst.name, keep, toUnlink);
      notify(
        [
          draftList.length && `Resolved ${plural(draftList.length, "file")}`,
          toWhole.length && `Linked ${toWhole.map((f) => `${f}/`).join(", ")} as a whole into ${inst.name}`,
          toSplit.length && `${toSplit.map((f) => `${f}/`).join(", ")} now linked file by file`,
          toLink.length && `Linked ${plural(toLink.length, "item")} from "${std.name}" into ${inst.name}`,
          toCopy.length && `copied ${plural(toCopy.length, "item")}`,
          toUnlink.length && `unlinked ${toUnlink.length}${keep ? ", kept copies" : ""}`,
          trash.length + inWay.length > 0 && `${trash.length + inWay.length} moved to Trash`,
          merge.length && `${inst.name}'s own merged into Shared`,
          renamed.length && `kept both of ${renamed.join(", ")}`,
        ]
          .filter(Boolean)
          .join(" · ")
          .replace(/^u/, "U")
      );
      onDone();
      onClose();
    } catch (e) {
      notify(String(e));
      setBusy(false);
    }
  }

  // what a row will be after Confirm, in a word or two
  function pill(r: string): [string, string] {
    const s = states?.[r];
    const on = want.has(r);
    if (!s) return ["idle", "…"];
    if (covered(r)) return s.state === "linked" ? ["linked", "Via folder"] : ["add", "Via folder"];
    if (s.state === "linked")
      return !on ? ["drop", "Will unlink"] : modeOf(r) === "copy" ? ["add", "Becomes its own copy"] : ["linked", "Linked"];
    if (on) {
      const verb = modeOf(r) === "link" ? "link" : "copy";
      return s.state === "own"
        ? std.builtin && isDir(r) && verb === "link"
          ? ["add", "Merges its own in"]
          : ["trash", "Replaces its own"]
        : s.state === "other"
          ? ["add", s.from ? `Will ${verb} · was ${s.from}` : `Will ${verb} · replaces a link`]
          : ["add", `Will ${verb}`];
    }
    return s.state === "own"
      ? ["idle", "Its own copy"]
      : s.state === "other"
        ? ["idle", s.from ? `From ${s.from}` : "Linked elsewhere"]
        : ["idle", "Not linked"];
  }

  const row = (n: TreeNode, depth: number) => {
    const ls = leaves(n);
    const k = ls.filter((r) => want.has(r)).length;
    const pad = { paddingLeft: 12 + depth * 20 };
    if (!n.entry) {
      const open = !closed.has(n.path);
      const parentWhole = [...wantWhole].some((f) => n.path.startsWith(`${f}/`));
      return (
        <div key={n.path} className="le-group">
          <div className="le-row folder" style={pad}>
            <button
              className={`le-caret ${open ? "open" : ""}`}
              aria-label={open ? "Collapse" : "Expand"}
              onClick={() => {
                const next = new Set(closed);
                open ? next.add(n.path) : next.delete(n.path);
                setClosed(next);
              }}
            >
              {CARET}
            </button>
            <label className="le-main">
              <input
                type="checkbox"
                checked={k === ls.length}
                disabled={ls.some(covered)}
                title={ls.some(covered) ? "Linked as a folder. Switch to Files to choose." : undefined}
                ref={(el) => {
                  if (el) el.indeterminate = k > 0 && k < ls.length;
                }}
                onChange={() => flip(ls, k < ls.length)}
              />
              <span className="le-ico dir">{DIR}</span>
              <span className="le-name">{n.name}/</span>
            </label>
            {!parentWhole && (
              <span className="le-mode" role="radiogroup" aria-label={`How ${n.name}/ is shared`}>
                {(
                  [
                    ...(canWhole.has(n.path)
                      ? ([["whole", "Link folder", "One link for the whole folder: new files are shared too, and it replaces everything in this installation's folder"]] as const)
                      : []),
                    ["files", "Link files", "A link per file: the installation keeps its other files"],
                    ["copy", "Copy", "This installation gets its own copy of every file here"],
                  ] as const
                ).map(([m, text, tip]) => {
                  const isWhole = wantWhole.has(n.path);
                  const on =
                    m === "whole"
                      ? isWhole
                      : !isWhole && ls.every((r) => want.has(r) && modeOf(r) === (m === "copy" ? "copy" : "link"));
                  return (
                    <button
                      key={m}
                      role="radio"
                      aria-checked={on}
                      className={on ? "on" : ""}
                      title={tip}
                      onClick={() => setFolderMode(n.path, m)}
                    >
                      {text}
                    </button>
                  );
                })}
              </span>
            )}
            <span className="le-count">
              {k} of {ls.length}
            </span>
          </div>
          {open && n.kids.map((c) => row(c, depth + 1))}
        </div>
      );
    }
    const e = n.entry;
    const [kind, text] = pill(e.rel_path);
    return (
      <label key={e.rel_path} className={`le-row ${kind}`} style={pad}>
        <span className="le-caret-gap" />
        <input
          type="checkbox"
          checked={want.has(e.rel_path)}
          disabled={covered(e.rel_path)}
          onChange={() => flip([e.rel_path], !want.has(e.rel_path))}
        />
        <span className={`le-ico ${e.is_dir ? "dir" : ""}`}>{e.is_dir ? DIR : FILE}</span>
        <span className="le-name">
          {n.name}
          {e.is_dir ? "/" : ""}
        </span>
        {/* version-only items: see entriesFor */}
        {want.has(e.rel_path) && !covered(e.rel_path) && (
          <span className="le-mode" role="radiogroup" aria-label={`How ${n.name} is shared`}>
            {(["link", "copy"] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={modeOf(e.rel_path) === m}
                className={modeOf(e.rel_path) === m ? "on" : ""}
                title={m === "link" ? "One shared item: changes show up everywhere" : "This installation gets its own copy"}
                onClick={(ev) => {
                  ev.preventDefault();
                  setModes({ ...modes, [e.rel_path]: m });
                }}
              >
                {m === "link" ? "Link" : "Copy"}
              </button>
            ))}
          </span>
        )}
        {canResolve(e.rel_path) && (
          <button
            className={`btn small ${drafts[e.rel_path] ? "primary" : ""}`}
            aria-label={`Resolve ${n.name}`}
            onClick={(ev) => {
              ev.preventDefault();
              setDiffing(e.rel_path);
            }}
          >
            {drafts[e.rel_path] ? `Resolved · ${drafts[e.rel_path].changes}` : "Resolve"}
          </button>
        )}
        <span className={`le-pill ${kind}`}>{text}</span>
      </label>
    );
  };

  const others = std.entries.length - entries.length;

  return (
    <>
    <Modal
      className="share-dialog le-dialog"
      label={`Link ${std.name} to ${inst.name}`}
      locked={busy}
      onClose={onClose}
      onEscape={review ? () => setReview(false) : undefined} // Esc steps back first
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) review ? apply() : confirm();
      }}
    >
      <div className="share-body">
        <header className="share-head">
          <span className="le-pair">
            <StandardAvatar s={std} />
            <span className="le-arrow">→</span>
            <Avatar inst={inst} />
          </span>
          <div>
            <h2>{review ? "Review changes" : `Link ${std.name} → ${inst.name}`}</h2>
            <p className="hint">
              {review ? (
                `What happens to ${inst.name} when you apply. Esc to go back.`
              ) : (
                <>
                  <b>Link</b> shares one item, so changes show up everywhere. <b>Copy</b> gives{" "}
                  {inst.name} its own.
                </>
              )}
            </p>
          </div>
        </header>

        {!review ? (
          <>
            <div className="share-label">
              <span>
                {states ? `${linkedNow.length} of ${rels.length} linked now` : "Checking…"}
              </span>
              {rels.length > 1 && states && (
                <span className="le-quick">
                  <button className="linklike" onClick={() => setWant(new Set(rels))}>
                    all
                  </button>
                  <button
                    className="linklike"
                    onClick={() => {
                      setWant(new Set());
                      setWantWhole(new Set());
                    }}
                  >
                    none
                  </button>
                  <button
                    className="linklike"
                    disabled={!changed}
                    onClick={() => {
                      setWant(new Set(linkedNow));
                      setWantWhole(wholeNow);
                    }}
                  >
                    reset
                  </button>
                </span>
              )}
            </div>
            <div className="share-files le-files">
              {rels.length === 0 ? (
                <p className="le-empty">
                  {std.name} has nothing yet —{" "}
                  <button className="linklike" onClick={() => api.revealPath(std.path, false)}>
                    open it
                  </button>{" "}
                  and drop files in.
                </p>
              ) : states ? (
                tree.map((n) => row(n, 0))
              ) : (
                rels.map((r) => <div key={r} className="le-row skeleton" />)
              )}
            </div>
            {others > 0 && (
              <p className="hint le-others">
                + {plural(others, "item")} only for other versions
              </p>
            )}
          </>
        ) : (
          <div className="le-review">
            {draftList.length > 0 && (
              <section className="le-sec add">
                <h3>Save {plural(draftList.length, "resolved file")} to {std.name}</h3>
                <span className="le-list">
                  {draftList.map(([r, d]) => (
                    <code key={r}>
                      {label(r)} · {d.whole ? "replaced" : plural(d.changes, "change")}
                    </code>
                  ))}
                </span>
                <p>Not saved yet. Untick a file or leave this menu to throw its changes away.</p>
              </section>
            )}
            {toWhole.length > 0 && (
              <section className="le-sec add">
                <h3>Link {plural(toWhole.length, "whole folder")}</h3>
                <span className="le-list">
                  {toWhole.map((f) => (
                    <code key={f}>{f}/</code>
                  ))}
                </span>
                <p>New files mods create there go into {std.name} and reach every installation linking it.</p>
              </section>
            )}
            {inWay.length > 0 && (
              <section className="le-sec trash">
                <h3>Move {plural(inWay.length, "item")} to the Trash</h3>
                <span className="le-list">
                  {inWay.slice(0, 8).map((f) => (
                    <code key={f}>{f}</code>
                  ))}
                  {inWay.length > 8 && <code>+{inWay.length - 8} more</code>}
                </span>
                <p>
                  {inst.name} has these in the folder and {std.name} doesn't supply them through this link. You can put
                  real files back from the Trash.
                </p>
              </section>
            )}
            {toLink.length > 0 && (
              <section className="le-sec add">
                <h3>Link {plural(toLink.length, "item")}</h3>
                {list(toLink)}
              </section>
            )}
            {toCopy.length > 0 && (
              <section className="le-sec add">
                <h3>Copy {plural(toCopy.length, "item")}</h3>
                {list(toCopy)}
                <p>{inst.name} gets its own, separate from {std.name}.</p>
              </section>
            )}
            {trash.length > 0 && (
              <section className="le-sec trash">
                <h3>Move {trash.length === 1 ? "1 item" : `${trash.length} items`} to the Trash</h3>
                {list(trash)}
                {trash.some(canResolve) && (
                  <span className="le-quick rs-import">
                    {trash.filter(canResolve).map((r) => (
                      <button key={r} className={`btn small ${drafts[r] ? "primary" : ""}`} onClick={() => setDiffing(r)}>
                        {drafts[r] ? "Resolved" : "Resolve"} {nameOf.get(r)}
                      </button>
                    ))}
                  </span>
                )}
                <p>
                  {inst.name} has its own {trash.length === 1 ? "copy" : "copies"}. To link{" "}
                  {std.name}'s, MIM moves {trash.length === 1 ? "it" : "them"} to the Trash — you
                  can put {trash.length === 1 ? "it" : "them"} back from there.
                </p>
              </section>
            )}
            {merge.length > 0 && (
              <section className="le-sec add">
                <h3>Merge {plural(merge.length, "folder")} into Shared</h3>
                {list(merge)}
                <p>
                  {inst.name}'s own move into the Shared {merge.length === 1 ? "one" : "ones"} and get
                  linked back. Where both have the same name, both are kept.
                </p>
              </section>
            )}
            {swap.length > 0 && (
              <section className="le-sec">
                <h3>Switch {plural(swap.length, "link")}</h3>
                {list(swap)}
                <p>Linked from somewhere else now; they'll come from {std.name}. Nothing is deleted.</p>
              </section>
            )}
            {toUnlink.length > 0 && (
              <section className={`le-sec drop ${keep ? "" : "trash"}`}>
                <h3>Unlink {plural(toUnlink.length, "item")}</h3>
                {list(toUnlink)}
                <div className="le-seg" role="radiogroup">
                  <button role="radio" aria-checked={keep} className={keep ? "on" : ""} onClick={() => setKeep(true)}>
                    Keep a copy in {inst.name}
                  </button>
                  <button role="radio" aria-checked={!keep} className={keep ? "" : "on"} onClick={() => setKeep(false)}>
                    Remove from {inst.name}
                  </button>
                </div>
                <p>Nothing in {std.name} is deleted either way.</p>
              </section>
            )}
          </div>
        )}

        <footer className="share-foot le-foot">
          {!review && changed && (
            <span className="le-sum">
              {toLink.length + toCopy.length > 0 && <b className="add">+{toLink.length + toCopy.length}</b>}
              {toWhole.length > 0 && <b className="add">{plural(toWhole.length, "whole folder")}</b>}
              {toUnlink.length > 0 && <b className="drop">−{toUnlink.length}</b>}
              {trash.length > 0 && <b className="trash">{trash.length} to Trash</b>}
            </span>
          )}
          {review ? (
            <>
              <button className="btn" onClick={() => setReview(false)} disabled={busy}>
                Back
              </button>
              <button className={`btn ${risky ? "danger solid" : "primary"}`} onClick={apply} disabled={busy}>
                {busy ? "Working…" : trash.length || inWay.length ? "Move to Trash & link" : "Apply"}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={confirm} disabled={!changed || busy}>
                {busy ? "Working…" : changed ? "Confirm" : "No changes"}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
    {/* beside the Modal: its Cmd+Enter must not reach this one's */}
    {diffing && (
      <ResolveDialog
        dest={nameOf.get(diffing)!}
        into={stdKey(std)}
        from={inst.name}
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
