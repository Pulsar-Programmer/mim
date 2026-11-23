import { useEffect, useState } from "react";
import { entriesFor, Installation, Standard, StandardEntry } from "./api";
import { buildTree, LinkEditor } from "./LinkEditor";
import { Avatar, StandardAvatar } from "./Places";
import { brief } from "./settings";

/** config/ holds its files one by one, so name only the top-level items. */
const topNames = (entries: StandardEntry[]) => {
  const names = buildTree(entries).map((n) => (n.entry ? n.name : `${n.name}/`));
  return names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "");
};

/** Every standard one installation can use; each opens the link editor. */
export function LinksDrawer({
  inst,
  standards,
  notify,
  onChanged,
  onClose,
  onManage,
}: {
  inst: Installation;
  standards: Standard[];
  notify: (m: string) => void;
  onChanged: () => void;
  onClose: () => void;
  onManage: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const editingStd = standards.find((s) => s.name === editing);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !editing && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, editing]);

  const rows = standards.map((s) => ({ s, entries: entriesFor(s, inst.game_version) }));
  const shown = rows.filter((r) => r.entries.length > 0);
  const hidden = rows.length - shown.length;

  return (
    <div className="viewer-backdrop drawer-backdrop" onClick={onClose}>
      <aside className="drawer links-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-hero">
          <Avatar inst={inst} />
          <div className="links-title">
            <h2 className="drawer-title">{inst.name}</h2>
            <span className="place-sub">
              {[inst.game_version, inst.loader].filter(Boolean).join(" · ") || "links"}
            </span>
          </div>
          <button className="linklike drawer-close" onClick={onClose}>
            close
          </button>
        </div>

        <p className="hint links-intro">
          {brief("Linked items stay in sync everywhere. Copied items become this installation's own.")}
        </p>

        <div className="based-list">
          {shown.map(({ s, entries }) => {
            const live = new Set(s.linked[inst.name] ?? []);
            const n = entries.filter((e) => live.has(e.rel_path)).length;
            return (
              <button key={s.name} className={`based link-row ${n ? "on" : ""}`} onClick={() => setEditing(s.name)}>
                <StandardAvatar s={s} />
                <span className="place-text">
                  <span className="place-label">{s.name}</span>
                  <span className="place-sub">
                    {n === 0 ? "nothing linked" : `${n} of ${entries.length} linked`}
                    {" · "}
                    {topNames(entries)}
                  </span>
                </span>
                <span className="link-row-go">Choose ›</span>
              </button>
            );
          })}
        </div>

        {hidden > 0 && (
          <p className="hint links-intro">
            {hidden} {hidden === 1 ? "standard is" : "standards are"} still empty.
          </p>
        )}

        <div className="drawer-actions">
          <button className="btn" onClick={onManage}>
            {standards.length === 1 ? "Create a standard →" : "Manage standards →"}
          </button>
        </div>
      </aside>
      {editingStd && (
        <span onClick={(e) => e.stopPropagation()}>
          <LinkEditor
            std={editingStd}
            inst={inst}
            notify={notify}
            onClose={() => setEditing(null)}
            onDone={onChanged}
          />
        </span>
      )}
    </div>
  );
}
