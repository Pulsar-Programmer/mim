import { useEffect, useMemo, useRef, useState } from "react";
import { api, entriesFor, Installation, LinkState, Standard, StandardEntry } from "./api";
import { Avatar, StandardAvatar } from "./Places";

const DIR = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
    <path
      d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
      fill="currentColor"
    />
  </svg>
);
const FILE = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
    <path d="M4 1.5h5l3.5 3.5v8.5a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" fill="currentColor" />
  </svg>
);

/** config/ files come in one by one ("config/fabric/x.toml"): fold them into folders. */
interface Node {
  name: string;
  path: string;
  entry?: StandardEntry;
  kids: Node[];
}

function buildTree(entries: StandardEntry[]): Node[] {
  const root: Node = { name: "", path: "", kids: [] };
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

const leaves = (n: Node): string[] => (n.entry ? [n.entry.rel_path] : n.kids.flatMap(leaves));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

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
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const entries = useMemo(() => entriesFor(std, inst.game_version), [std, inst]);
  const rels = entries.map((e) => e.rel_path);
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [states, setStates] = useState<Record<string, LinkState> | null>(null);
  const [want, setWant] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [review, setReview] = useState(false);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);

  const st = (r: string) => states?.[r]?.state;
  const linkedNow = rels.filter((r) => st(r) === "linked");

  useEffect(() => {
    api
      .linkStates(std.name, inst.name, rels)
      .then((list) => {
        const map = Object.fromEntries(rels.map((r, k) => [r, list[k]]));
        setStates(map);
        const linked = rels.filter((r) => map[r].state === "linked");
        // first link: everything ticked, except what would cost the installation its own copy
        setWant(new Set(linked.length ? linked : rels.filter((r) => map[r].state !== "own")));
      })
      .catch((e) => {
        notify(String(e));
        ref.current?.close();
      });
    // only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toLink = rels.filter((r) => want.has(r) && st(r) !== "linked");
  const toUnlink = linkedNow.filter((r) => !want.has(r));
  // Shared folders the installation has its own of get merged in, not trashed
  const own = toLink.filter((r) => st(r) === "own");
  const trash = std.builtin ? [] : own;
  const merge = std.builtin ? own : [];
  const swap = toLink.filter((r) => st(r) === "other");
  const changed = toLink.length + toUnlink.length > 0;
  const risky = trash.length > 0 || (toUnlink.length > 0 && !keep);

  function flip(rs: string[], on: boolean) {
    const next = new Set(want);
    for (const r of rs) on ? next.add(r) : next.delete(r);
    setWant(next);
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

  function confirm() {
    if (!changed || busy) return;
    if (trash.length || toUnlink.length) setReview(true);
    else apply();
  }

  async function apply() {
    if (busy) return;
    setBusy(true);
    try {
      let renamed: string[] = [];
      if (std.builtin) {
        if (toLink.length) renamed = await api.mergeShared(inst.name, toLink.map((r) => r.split("/")[1]));
      } else if (want.size) {
        // the whole wanted set, so already-linked items stay put (and old whole-folder links split up)
        await api.linkStandard(std.name, inst.name, rels.filter((r) => want.has(r)), true);
      }
      if (toUnlink.length) await api.unlinkStandard(std.name, inst.name, keep, toUnlink);
      notify(
        [
          toLink.length && `Linked ${plural(toLink.length, "item")} from "${std.name}" into ${inst.name}`,
          toUnlink.length && `unlinked ${toUnlink.length}${keep ? ", kept copies" : ""}`,
          trash.length && `${trash.length} moved to Trash`,
          merge.length && `${inst.name}'s own merged into Shared`,
          renamed.length && `kept both of ${renamed.join(", ")}`,
        ]
          .filter(Boolean)
          .join(" · ")
          .replace(/^u/, "U")
      );
      onDone();
      ref.current?.close();
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
    if (s.state === "linked") return on ? ["linked", "Linked"] : ["drop", "Will unlink"];
    if (on)
      return s.state === "own"
        ? std.builtin
          ? ["add", "Merges its own in"]
          : ["trash", "Replaces its own"]
        : s.state === "other"
          ? ["add", s.from ? `Will link · was ${s.from}` : "Will link · replaces a link"]
          : ["add", "Will link"];
    return s.state === "own"
      ? ["idle", "Its own copy"]
      : s.state === "other"
        ? ["idle", s.from ? `From ${s.from}` : "Linked elsewhere"]
        : ["idle", "Not linked"];
  }

  const row = (n: Node, depth: number) => {
    const ls = leaves(n);
    const k = ls.filter((r) => want.has(r)).length;
    const pad = { paddingLeft: 12 + depth * 20 };
    if (!n.entry) {
      const open = !closed.has(n.path);
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
              ›
            </button>
            <label className="le-main">
              <input
                type="checkbox"
                checked={k === ls.length}
                ref={(el) => {
                  if (el) el.indeterminate = k > 0 && k < ls.length;
                }}
                onChange={() => flip(ls, k < ls.length)}
              />
              <span className="le-ico dir">{DIR}</span>
              <span className="le-name">{n.name}/</span>
            </label>
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
          onChange={() => flip([e.rel_path], !want.has(e.rel_path))}
        />
        <span className={`le-ico ${e.is_dir ? "dir" : ""}`}>{e.is_dir ? DIR : FILE}</span>
        <span className="le-name">
          {n.name}
          {e.is_dir ? "/" : ""}
        </span>
        {e.scope !== "global" && <span className="chip">{e.scope}</span>}
        <span className={`le-pill ${kind}`}>{text}</span>
      </label>
    );
  };

  const others = std.entries.length - entries.length;

  return (
    <dialog
      ref={ref}
      className="share-dialog le-dialog"
      onClose={onClose}
      onCancel={(e) => {
        if (review && !busy) {
          e.preventDefault(); // Esc steps back first
          setReview(false);
        }
      }}
      onClick={(e) => e.target === ref.current && !busy && ref.current.close()}
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
                  Ticked items use {std.name}'s copy
                  <span className="more">
                    {" "}
                    — a change on either side shows up in both. Unticked ones stay {inst.name}'s own.
                  </span>
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
                  <button className="linklike" onClick={() => setWant(new Set())}>
                    none
                  </button>
                  <button
                    className="linklike"
                    disabled={!changed}
                    onClick={() => setWant(new Set(linkedNow))}
                  >
                    reset
                  </button>
                </span>
              )}
            </div>
            <div className="share-files le-files">
              {rels.length === 0 ? (
                <p className="le-empty">
                  {std.name} has nothing for {inst.game_version ?? "this version"} yet —{" "}
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
            {toLink.length > 0 && (
              <section className="le-sec add">
                <h3>Link {plural(toLink.length, "item")}</h3>
                {list(toLink)}
              </section>
            )}
            {trash.length > 0 && (
              <section className="le-sec trash">
                <h3>Move {trash.length === 1 ? "1 item" : `${trash.length} items`} to the Trash</h3>
                {list(trash)}
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
              {toLink.length > 0 && <b className="add">+{toLink.length}</b>}
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
                {busy ? "Working…" : trash.length ? "Move to Trash & link" : "Apply"}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => ref.current?.close()} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={confirm} disabled={!changed || busy}>
                {busy ? "Working…" : changed ? "Confirm" : "No changes"}
              </button>
            </>
          )}
        </footer>
      </div>
    </dialog>
  );
}
