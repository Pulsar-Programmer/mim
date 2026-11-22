import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, formatBytes, Installation, Mod } from "./api";
import { useCached, useConfirm } from "./hooks";

export function ModsView({
  notify,
  installations,
  onChanged,
}: {
  notify: (m: string) => void;
  installations: Installation[];
  onChanged: () => void;
}) {
  // installations with mods first, the main folder last
  const scopes = useMemo(
    () => [
      ...[...installations]
        .sort((a, b) => b.mods_count - a.mods_count)
        .map((i) => ({ key: i.name, label: i.name, count: i.mods_count, loader: i.loader })),
      { key: null, label: "Main folder", count: null, loader: null },
    ],
    [installations]
  );
  const [scope, setScope] = useState<string | null | undefined>(undefined);
  const current = scope === undefined ? scopes[0]?.key ?? null : scope;

  const [mods = [], reload] = useCached<Mod[]>(
    `mods:${current}`,
    () => api.listMods(current),
    notify
  );
  const refresh = () => {
    reload();
    onChanged();
  };
  const { armed, confirm } = useConfirm(notify, refresh);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");

  const shown = mods.filter((m) => {
    if (filter === "on" && !m.enabled) return false;
    if (filter === "off" && m.enabled) return false;
    const q = query.toLowerCase();
    return (
      !q ||
      m.name.toLowerCase().includes(q) ||
      m.file.toLowerCase().includes(q) ||
      (m.id ?? "").includes(q)
    );
  });
  const disabled = mods.filter((m) => !m.enabled).length;

  async function toggle(m: Mod) {
    try {
      await api.toggleMod(m.path);
      reload();
    } catch (e) {
      notify(String(e));
    }
  }

  async function add() {
    const files = await openDialog({
      multiple: true,
      title: "Add mods",
      filters: [{ name: "Mod", extensions: ["jar"] }],
    });
    if (!files || files.length === 0) return;
    try {
      const n = await api.addMods(current, files as string[]);
      notify(`Added ${n} mod${n === 1 ? "" : "s"}`);
      refresh();
    } catch (e) {
      notify(String(e));
    }
  }

  const folder = current
    ? installations.find((i) => i.name === current)?.path + "/mods"
    : null;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Mods</h1>
          <p className="sub">
            {mods.length} mod{mods.length === 1 ? "" : "s"}
            {disabled > 0 && ` · ${disabled} disabled`}
          </p>
        </div>
        <div className="row-inline">
          {folder && (
            <button className="btn" onClick={() => api.revealPath(folder, false)}>
              Open Folder
            </button>
          )}
          <button className="btn primary" onClick={add}>
            + Add Mods
          </button>
        </div>
      </header>

      <div className="options-layout">
        <aside className="sources">
          {scopes.map((s) => (
            <button
              key={s.label}
              className={`source ${s.key === current ? "active" : ""}`}
              onClick={() => setScope(s.key)}
            >
              <span className="source-label">
                {s.label}
                {s.loader === "fabric" && <span className="chip">fabric</span>}
              </span>
              <span className="source-sub">
                {s.count == null ? "root mods folder" : `${s.count} mod${s.count === 1 ? "" : "s"}`}
              </span>
            </button>
          ))}
          <p className="hint sources-hint">
            Disabling renames a mod to <code>.jar.disabled</code>, the same trick the
            launcher and mod managers use — the game skips it.
          </p>
        </aside>

        <section className="options-editor">
          <div className="options-toolbar">
            <input
              className="search"
              placeholder="Search mods…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="segmented kinds">
              {(["all", "on", "off"] as const).map((f) => (
                <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "on" ? "Enabled" : "Disabled"}
                </button>
              ))}
            </div>
          </div>

          <ul className="mod-list">
            {shown.map((m) => (
              <li key={m.path} className={`mod ${m.enabled ? "" : "off"}`}>
                <div
                  className="mod-icon"
                  style={m.icon ? { backgroundImage: `url(${m.icon})` } : undefined}
                >
                  {!m.icon && m.name[0]}
                </div>
                <div className="mod-main">
                  <div className="mod-top">
                    <span className="mod-name">{m.name}</span>
                    {m.version && <code>{m.version}</code>}
                    {m.loader && <span className={`chip loader-${m.loader}`}>{m.loader}</span>}
                  </div>
                  {m.description && <p className="mod-desc">{m.description}</p>}
                  <div className="mod-meta">
                    {m.authors.length > 0 && <span>by {m.authors.slice(0, 3).join(", ")}</span>}
                    <span className="mod-file" title={m.file}>
                      {m.file}
                    </span>
                    <span>{formatBytes(m.size_bytes)}</span>
                  </div>
                </div>
                <div className="mod-actions">
                  <button
                    className={`switch ${m.enabled ? "on" : ""}`}
                    role="switch"
                    aria-checked={m.enabled}
                    title={m.enabled ? "Disable" : "Enable"}
                    onClick={() => toggle(m)}
                  >
                    <span />
                  </button>
                  <button
                    className="linklike danger-link"
                    onClick={() =>
                      confirm(m.path, async () => {
                        await api.trashItem(m.path);
                        return `Moved ${m.name} to Trash`;
                      })
                    }
                  >
                    {armed === m.path ? "sure?" : "remove"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {mods.length === 0 && (
            <div className="empty">
              No mods in this folder.{" "}
              <button className="linklike" onClick={add}>
                Add some
              </button>
              .
            </div>
          )}
          {mods.length > 0 && shown.length === 0 && <div className="empty">Nothing matches.</div>}
        </section>
      </div>
    </>
  );
}
