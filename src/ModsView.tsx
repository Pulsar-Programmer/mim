import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  formatBytes,
  ImportReport,
  Installation,
  Mod,
  okToChangeShared,
  reportSummary,
  splitLinks,
  timeAgo,
} from "./api";
import { ProgressBar, useProgress } from "./Progress";
import { brief } from "./settings";
import { useCached, useConfirm } from "./hooks";
import { PlacePicker } from "./Places";

interface ModScope {
  key: string | null;
  label: string;
  inst?: Installation;
  sub: string;
  members: Installation[];
}

export function ModsView({
  notify,
  installations,
  onChanged,
}: {
  notify: (m: string) => void;
  installations: Installation[];
  onChanged: () => void;
}) {
  // installations with mods first, the main folder last. Installations linking
  // the same mods folder are one section, since they have the same mods.
  const scopes = useMemo<ModScope[]>(() => {
    const sorted = [...installations].sort((a, b) => b.mods_count - a.mods_count);
    const sharing = (i: Installation) => sorted.filter((o) => o.mods_link?.dir === i.mods_link?.dir);
    const places = sorted.flatMap<ModScope>((i) => {
      const count = `${i.mods_count} mod${i.mods_count === 1 ? "" : "s"}`;
      if (!i.mods_link) return [{ key: i.name, label: i.name, inst: i, sub: count, members: [] }];
      if (i.mods_link.from === "Shared") return [];
      const group = sharing(i);
      if (group[0] !== i) return [];
      return group.length > 1
        ? [{ key: i.name, label: i.mods_link.from, inst: undefined, sub: `${count} · ${group.length} linked`, members: group }]
        : [{ key: i.name, label: i.name, inst: i, sub: `${count} · from ${i.mods_link.from}`, members: [] }];
    });
    const inRoot = sorted.filter((i) => i.mods_link?.from === "Shared");
    return [
      ...places,
      {
        key: null,
        label: "Minecraft folder",
        inst: undefined,
        sub: inRoot.length ? `${inRoot.length} linked` : "root mods folder",
        members: inRoot,
      },
    ];
  }, [installations]);
  const [scope, setScope] = useState<string | null | undefined>(undefined);
  // a picked installation that now shares a folder lands on that section
  const picked = scopes.find((s) => s.key === scope || s.members.some((m) => m.name === scope));
  const current = picked ? picked.key : scopes[0]?.key ?? null;

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
  const [hideLibs, setHideLibs] = useState(false);
  const [sort, setSort] = useState<"name" | "newest" | "size">("name");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<"import" | "update" | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const progress = useProgress(!!busy);

  const libs = mods.filter((m) => m.library).length;
  const shown = mods.filter((m) => {
    if (filter === "on" && !m.enabled) return false;
    if (filter === "off" && m.enabled) return false;
    if (hideLibs && m.library) return false;
    const q = query.toLowerCase();
    return (
      !q ||
      m.name.toLowerCase().includes(q) ||
      m.file.toLowerCase().includes(q) ||
      (m.id ?? "").includes(q)
    );
  });
  if (sort === "newest") shown.sort((a, b) => b.modified - a.modified);
  if (sort === "size") shown.sort((a, b) => b.size_bytes - a.size_bytes);
  const disabled = mods.filter((m) => !m.enabled).length;

  async function toggle(m: Mod) {
    try {
      if (!(await okToChangeShared([m.path], `Turning ${m.name} ${m.enabled ? "off" : "on"}`, true))) return;
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

  async function fromModrinth(kind: "import" | "update") {
    if (!current) return;
    setBusy(kind);
    setReport(null);
    try {
      const r =
        kind === "import"
          ? await api.importLinks(splitLinks(link), current)
          : await api.updateMods(current);
      notify(reportSummary(r, kind === "import" ? "Added" : "Updated"));
      if (r.skipped.length) setReport(r);
      if (kind === "import") setLink("");
      refresh();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(null);
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
          {current && (
            <button
              className="btn"
              onClick={() => fromModrinth("update")}
              disabled={!!busy}
              title={brief("Swap every mod Modrinth knows for its newest build for this version — old jars go to the Trash")}
            >
              {busy === "update" ? "Updating…" : "Update All"}
            </button>
          )}
          <button className="btn primary" onClick={add}>
            + Add Mods
          </button>
        </div>
      </header>

      <p className="hint wide more">
            Disabling renames a mod to <code>.jar.disabled</code>, the same trick the
            launcher and mod managers use — the game skips it.
          </p>

      <PlacePicker
        places={scopes.map((s) => ({
          key: s.key ?? "",
          label: s.label,
          kind: s.key == null ? ("root" as const) : undefined,
          inst: s.inst,
          sub: s.sub,
          members: s.members,
        }))}
        value={current ?? ""}
        onChange={(k) => setScope(k || null)}
      />
      <div className="options-layout">

        <section className="options-editor">
          {current ? (
            <form
              className="options-toolbar import-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (link.trim()) fromModrinth("import");
              }}
            >
              <input
                className="search"
                placeholder={brief("Paste Modrinth or CurseForge links — mods, collections or modpacks")}
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <button className="btn" disabled={!link.trim() || !!busy}>
                {busy === "import" ? "Importing…" : "Import"}
              </button>
            </form>
          ) : (
            <p className="hint">
              Pick an installation to import from Modrinth
              <span className="more"> — the Minecraft folder has no fixed version to match mods to.</span>
            </p>
          )}
          {busy && (
            <ProgressBar
              p={progress}
              fallback={busy === "import" ? "Looking up links…" : "Checking for updates…"}
            />
          )}
          {report && (
            <p className="hint wide">
              Skipped: {report.skipped.join(" · ")}{" "}
              <button className="linklike" onClick={() => setReport(null)}>
                dismiss
              </button>
            </p>
          )}

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
            {libs > 0 && (
              <label
                className="inline-check"
                title={brief("Libraries are mods other mods need — Fabric API, Cloth Config and the like")}
              >
                <input
                  type="checkbox"
                  checked={hideLibs}
                  onChange={(e) => setHideLibs(e.target.checked)}
                />
                hide libraries <span className="count">{libs}</span>
              </label>
            )}
            <select
              className="sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              title="Sort"
            >
              <option value="name">A–Z</option>
              <option value="newest">Newest</option>
              <option value="size">Largest</option>
            </select>
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
                    {m.library && <span className="chip lib">library</span>}
                  </div>
                  {m.description && <p className="mod-desc">{m.description}</p>}
                  <div className="mod-meta">
                    {m.authors.length > 0 && <span>by {m.authors.slice(0, 3).join(", ")}</span>}
                    <span className="mod-file" title={m.file}>
                      {m.file}
                    </span>
                    <span>{formatBytes(m.size_bytes)}</span>
                    {sort === "newest" && (
                      <span>added {timeAgo(new Date(m.modified * 1000).toISOString())}</span>
                    )}
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
                        if (!(await okToChangeShared([m.path], `Removing ${m.name}`))) return `Kept ${m.name}`;
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
