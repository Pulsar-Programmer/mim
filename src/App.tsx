import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  formatBytes,
  timeAgo,
  Installation,
  GameVersion,
  LoaderVersion,
  Standards,
  PacksOverview,
  LogEntry,
  FolderItem,
  FolderCategory,
} from "./api";
import { useCached, useConfirm } from "./hooks";
import { SavesView } from "./SavesView";
import { OptionsView } from "./OptionsView";
import { ServersView } from "./ServersView";
import { ModsView } from "./ModsView";
import { ScreenshotsView } from "./ScreenshotsView";
import { SettingsView } from "./SettingsView";
import { Settings, applySettings, loadSettings, saveSettings } from "./settings";
import "./App.css";

type View =
  | "installations"
  | "new"
  | "standards"
  | "packs"
  | "folder"
  | "saves"
  | "servers"
  | "screenshots"
  | "mods"
  | "options"
  | "logs"
  | "settings";

const NAV: [string, [View, string][]][] = [
  [
    "Library",
    [
      ["installations", "Installations"],
      ["new", "New Install"],
      ["standards", "Standards"],
      ["mods", "Mods"],
      ["packs", "Resource Packs"],
    ],
  ],
  [
    "Minecraft Folder",
    [
      ["folder", "Overview"],
      ["saves", "Saves"],
      ["servers", "Servers"],
      ["screenshots", "Screenshots"],
      ["options", "Options"],
      ["logs", "Logs"],
    ],
  ],
];

// deterministic soft gradient for cards without a custom image
function nameGradient(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 32% 88%), hsl(${(h + 40) % 360} 38% 78%))`;
}

function App() {
  const [view, setView] = useState<View>("installations");
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [mcDir, setMcDir] = useState<{ path: string; sample: boolean } | null>(null);
  const toastTimer = useRef<number>(undefined);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  useEffect(() => applySettings(settings), [settings]);
  const changeSettings = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
  };

  const notify = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current); // a newer toast gets its full time
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    api.minecraftDir().then(setMcDir);
  }, []);

  const refresh = useCallback(() => {
    api.listInstallations().then(setInstallations).catch((e) => notify(String(e)));
  }, [notify]);

  useEffect(refresh, [refresh]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="titlebar" data-tauri-drag-region />
        <div className="wordmark" data-tauri-drag-region>MIM</div>
        <div className="tagline">installation manager</div>
        <nav>
          {NAV.map(([section, items]) => (
            <div key={section} className="nav-section">
              <div className="nav-heading">{section}</div>
              {items.map(([v, label]) => (
                <button
                  key={v}
                  className={`nav-item ${view === v ? "active" : ""}`}
                  onClick={() => setView(v)}
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          {mcDir?.sample && (
            <div className="sample-badge" title={mcDir.path}>
              sample folder
            </div>
          )}
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
          >
            Settings
          </button>
          <button className="btn ghost" onClick={() => api.openLauncher()}>
            Open Launcher ↗
          </button>
        </div>
      </aside>

      <main className="content" key={view}>
        <div className="topbar" data-tauri-drag-region />
        {view === "installations" && (
          <InstallationsView
            installations={installations}
            refresh={refresh}
            notify={notify}
            onNew={() => setView("new")}
          />
        )}
        {view === "new" && (
          <NewInstallView
            notify={notify}
            onDone={() => {
              refresh();
              setView("installations");
            }}
          />
        )}
        {view === "standards" && <StandardsView notify={notify} />}
        {view === "packs" && <PacksView notify={notify} />}
        {view === "folder" && (
          <FolderView
            notify={notify}
            root={mcDir?.path ?? ""}
            go={(v: View) => setView(v)}
          />
        )}
        {view === "saves" && <SavesView notify={notify} />}
        {view === "options" && <OptionsView notify={notify} />}
        {view === "logs" && <LogsView notify={notify} installations={installations} />}
        {view === "servers" && <ServersView notify={notify} />}
        {view === "screenshots" && <ScreenshotsView notify={notify} />}
        {view === "mods" && (
          <ModsView notify={notify} installations={installations} onChanged={refresh} />
        )}
        {view === "settings" && (
          <SettingsView settings={settings} onChange={changeSettings} mcDir={mcDir} />
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function InstallationsView({
  installations,
  refresh,
  notify,
  onNew,
}: {
  installations: Installation[];
  refresh: () => void;
  notify: (m: string) => void;
  onNew: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);

  async function pickImage(inst: Installation) {
    const path = await openDialog({
      title: `Image for ${inst.name}`,
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof path !== "string") return;
    try {
      await api.setCustomIcon(inst.name, path);
      refresh();
    } catch (e) {
      notify(String(e));
    }
  }

  async function remove(inst: Installation) {
    if (confirming !== inst.name) {
      setConfirming(inst.name);
      setTimeout(() => setConfirming((c) => (c === inst.name ? null : c)), 3000);
      return;
    }
    setConfirming(null);
    try {
      await api.deleteInstallation(inst.name, true);
      notify(`Moved "${inst.name}" to Trash`);
      refresh();
    } catch (e) {
      notify(String(e));
    }
  }

  async function link(inst: Installation) {
    try {
      const [linked, skipped] = await api.linkInstallation(inst.name);
      notify(
        linked.length
          ? `Linked ${linked.join(", ")}${skipped.length ? ` · kept local: ${skipped.join(", ")}` : ""}`
          : "Nothing to link — folders already exist"
      );
      refresh();
    } catch (e) {
      notify(String(e));
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Installations</h1>
          <p className="sub">
            {installations.length} in&nbsp;
            <code>minecraft/installations</code>
          </p>
        </div>
        <button className="btn primary" onClick={onNew}>
          + New Install
        </button>
      </header>

      <div className="grid">
        {installations.map((inst) => (
          <div className="card" key={inst.path}>
            <div
              className="card-art"
              style={
                inst.icon?.startsWith("data:")
                  ? { backgroundImage: `url(${inst.icon})` }
                  : { background: nameGradient(inst.name) }
              }
            >
              {!inst.icon?.startsWith("data:") && (
                <span className="card-initial">{inst.name[0]}</span>
              )}
              {inst.loader === "fabric" && <span className="chip on-art">fabric</span>}
            </div>
            <div className="card-body">
              <div className="card-name" title={inst.name}>
                {inst.name}
              </div>
              <div className="card-meta">
                {inst.game_version && <code>{inst.game_version}</code>}
                {inst.mods_count > 0 && <span>{inst.mods_count} mods</span>}
                <span>{timeAgo(inst.last_used)}</span>
              </div>
              <div className="card-links" title="shared folders symlinked">
                {["resourcepacks", "saves", "screenshots"].map((d) => (
                  <span
                    key={d}
                    className={`dot ${inst.linked.includes(d) ? "linked" : ""}`}
                  >
                    {d.replace("resourcepacks", "packs")}
                  </span>
                ))}
              </div>
              <div className="card-actions">
                <button onClick={() => api.revealPath(inst.path, false)}>Open</button>
                <button onClick={() => pickImage(inst)}>Image</button>
                {inst.linked.length < 3 && (
                  <button onClick={() => link(inst)}>Link</button>
                )}
                <button className="danger" onClick={() => remove(inst)}>
                  {confirming === inst.name ? "Sure?" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        ))}
        {installations.length === 0 && (
          <div className="empty">
            No installations yet. <button className="linklike" onClick={onNew}>Create one</button>.
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function NewInstallView({
  notify,
  onDone,
}: {
  notify: (m: string) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [versions = []] = useCached<GameVersion[]>(
    "game-versions",
    api.listGameVersions,
    notify
  );
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [gameVersion, setGameVersion] = useState("");
  const [fabric, setFabric] = useState(true);
  const [loaders, setLoaders] = useState<LoaderVersion[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [standards] = useCached<Standards>("standards", api.listStandards, notify);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (gameVersion) return;
    const latest = versions.find((x) => x.type === "release");
    if (latest) setGameVersion(latest.id);
  }, [versions, gameVersion]);

  useEffect(() => {
    if (!fabric || !gameVersion) return;
    setLoaders([]);
    setLoaderVersion("");
    api
      .listLoaderVersions(gameVersion)
      .then((l) => {
        setLoaders(l);
        const stable = l.find((x) => x.stable) ?? l[0];
        if (stable) setLoaderVersion(stable.version);
      })
      .catch(() => setLoaders([]));
  }, [fabric, gameVersion]);

  const visibleVersions = useMemo(
    () => versions.filter((v) => showSnapshots || v.type === "release"),
    [versions, showSnapshots]
  );

  const relevantStandards = useMemo(
    () =>
      standards?.entries.filter(
        (e) => e.scope === "global" || e.scope === gameVersion
      ) ?? [],
    [standards, gameVersion]
  );

  function toggle(rel: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(rel) ? next.delete(rel) : next.add(rel);
      return next;
    });
  }

  async function install() {
    if (!name.trim()) return notify("Give it a name first");
    if (!gameVersion) return notify("Pick a version");
    setBusy("Installing…");
    try {
      await api.createInstallation({
        name: name.trim(),
        game_version: gameVersion,
        fabric,
        loader_version: fabric && loaderVersion ? loaderVersion : null,
        standards: [...picked],
      });
      if (imagePath) {
        await api.setCustomIcon(name.trim(), imagePath).catch(() => {});
      }
      notify(`Installed "${name.trim()}" — it's in your launcher`);
      onDone();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>New Install</h1>
          <p className="sub">registers in the official launcher, Essential-style</p>
        </div>
      </header>

      <div className="form">
        <label>
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Hypixel 1.21.10"
            autoFocus
          />
        </label>

        <label>
          <span>
            Version
            <label className="inline-check">
              <input
                type="checkbox"
                checked={showSnapshots}
                onChange={(e) => setShowSnapshots(e.target.checked)}
              />
              snapshots
            </label>
          </span>
          <select value={gameVersion} onChange={(e) => setGameVersion(e.target.value)}>
            {visibleVersions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Loader</span>
          <div className="segmented">
            <button className={!fabric ? "active" : ""} onClick={() => setFabric(false)}>
              Vanilla
            </button>
            <button className={fabric ? "active" : ""} onClick={() => setFabric(true)}>
              Fabric
            </button>
          </div>
        </label>

        {fabric && (
          <label>
            <span>Fabric loader</span>
            <select
              value={loaderVersion}
              onChange={(e) => setLoaderVersion(e.target.value)}
              disabled={loaders.length === 0}
            >
              {loaders.length === 0 && <option>no loader for this version</option>}
              {loaders.map((l) => (
                <option key={l.version} value={l.version}>
                  {l.version}
                  {l.stable ? "" : " (beta)"}
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          <span>Image</span>
          <div className="row-inline">
            <button
              className="btn"
              onClick={async () => {
                const p = await openDialog({
                  multiple: false,
                  filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
                });
                if (typeof p === "string") setImagePath(p);
              }}
            >
              {imagePath ? imagePath.split("/").pop() : "Choose image…"}
            </button>
            {imagePath && (
              <button className="linklike" onClick={() => setImagePath(null)}>
                clear
              </button>
            )}
          </div>
        </label>

        <label>
          <span>Standards</span>
          {relevantStandards.length > 0 ? (
            <div className="standards-list">
              {relevantStandards.map((e) => (
                <label className="check-row" key={e.rel_path}>
                  <input
                    type="checkbox"
                    checked={picked.has(e.rel_path)}
                    onChange={() => toggle(e.rel_path)}
                  />
                  <span className="check-name">
                    {e.name}
                    {e.is_dir ? "/" : ""}
                  </span>
                  <span className="chip">{e.scope}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="hint">
              Nothing in <code>minecraft/standards</code> for this version — drop an
              options.txt, resource packs, or mod configs there and they'll show up
              here on install.
            </p>
          )}
        </label>

        <button className="btn primary big" onClick={install} disabled={!!busy}>
          {busy ?? "Install"}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function StandardsView({ notify }: { notify: (m: string) => void }) {
  const [standards, load] = useCached<Standards>("standards", api.listStandards, notify);

  const groups = useMemo(() => {
    const entries = standards?.entries ?? [];
    const map = new Map<string, typeof entries>();
    for (const e of entries) {
      if (!map.has(e.scope)) map.set(e.scope, []);
      map.get(e.scope)!.push(e);
    }
    return [...map.entries()].sort(([a], [b]) =>
      a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)
    );
  }, [standards]);

  async function openFolder() {
    const path = await api.ensureStandardsDir();
    await api.revealPath(path, false);
    load();
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Standards</h1>
          <p className="sub">
            your defaults — imported by checkbox on every install
          </p>
        </div>
        <button className="btn" onClick={openFolder}>
          Open Folder
        </button>
      </header>

      <p className="hint wide">
        Top-level files and folders in <code>minecraft/standards</code> apply to every
        version. A subfolder named like a version (<code>1.21.10/</code>) only shows up
        when installing that version. Put an <code>options.txt</code>, resource packs,
        or mod <code>config/</code> folders in there.
      </p>

      {groups.map(([scope, entries]) => (
        <section key={scope} className="std-group">
          <h2>{scope}</h2>
          <ul className="std-list">
            {entries.map((e) => (
              <li key={e.rel_path}>
                <span className="std-name">
                  {e.name}
                  {e.is_dir ? "/" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {(standards?.entries.length ?? 0) === 0 && (
        <div className="empty">
          The standards folder is empty{standards?.exists ? "" : " (doesn't exist yet)"}.{" "}
          <button className="linklike" onClick={openFolder}>
            Open it
          </button>{" "}
          and drop files in.
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function PacksView({ notify }: { notify: (m: string) => void }) {
  const [packs] = useCached<PacksOverview>("packs", api.listResourcepacks, notify);

  if (!packs) return null;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Resource Packs</h1>
          <p className="sub">
            shared across {packs.linked_installations.length} linked installation
            {packs.linked_installations.length === 1 ? "" : "s"}
          </p>
        </div>
        <button className="btn" onClick={() => api.revealPath(packs.shared_path, false)}>
          Open Folder
        </button>
      </header>

      <ul className="pack-list">
        {packs.shared.map((p) => (
          <li key={p.name}>
            <span className="pack-name">
              {p.name}
              {p.is_dir ? "/" : ""}
            </span>
            <span className="pack-size">{formatBytes(p.size_bytes)}</span>
          </li>
        ))}
        {packs.shared.length === 0 && (
          <div className="empty">Shared resourcepacks folder is empty.</div>
        )}
      </ul>

      {packs.local.map((l) => (
        <section key={l.installation} className="std-group">
          <h2>
            {l.installation} <span className="chip">not linked</span>
          </h2>
          <ul className="pack-list">
            {l.packs.map((p) => (
              <li key={p.name}>
                <span className="pack-name">
                  {p.name}
                  {p.is_dir ? "/" : ""}
                </span>
                <span className="pack-size">{formatBytes(p.size_bytes)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

const purgeLogs = async (installation: string | null = null) =>
  `Moved ${await api.purgeLogs(installation)} log items to Trash`;
const purgeCache = async () => `Moved ${await api.purgeCache()} cache items to Trash`;

const CATEGORIES: [FolderCategory, string, string][] = [
  ["logs", "Logs", "Text records of what the game and launcher did. Useful for debugging crashes, safe to delete."],
  ["cache", "Cache", "Temporary downloads and caches. Safe to delete — the launcher and game rebuild them."],
  ["yours", "Your stuff", "Worlds, packs, screenshots, mods and settings. MIM never touches these."],
  ["game", "Game files", "Downloaded by the launcher. Deleting them just forces a big re-download."],
  ["launcher", "Launcher", "Launcher accounts, profiles and settings. Leave these alone."],
  ["other", "Other", "Mod data and anything MIM doesn't recognize."],
];

const NOTES: Record<string, string> = {
  logs: "game session logs",
  "crash-reports": "crash reports from the game",
  debug: "disconnect & profiler dumps",
  webcache: "launcher web cache (old)",
  webcache2: "launcher web cache",
  downloads: "temporary launcher downloads",
  "server-resource-packs": "packs downloaded from servers",
  ".fabric": "Fabric's remapped jar cache",
  "updateSourceCache.json": "launcher update cache",
  "usercache.json": "player name lookups",
  assets: "sounds, textures, languages",
  libraries: "Java libraries the game needs",
  versions: "game & loader versions",
  runtime: "bundled Java runtimes",
  bin: "native libraries",
  saves: "your worlds",
  resourcepacks: "shared resource packs",
  shaderpacks: "shader packs",
  screenshots: "your screenshots",
  mods: "root-folder mods",
  config: "mod settings",
  installations: "MIM / Essential installations",
  standards: "MIM install defaults",
  "servers.dat": "multiplayer server list",
  "hotbar.nbt": "saved creative hotbars",
  "options.txt": "game settings",
  launcher: "launcher app files",
  "launcher_profiles.json": "launcher installations list",
  "launcher_accounts.json": "signed-in accounts",
  "launcher_msa_credentials.bin": "Microsoft sign-in",
  quickPlay: "quick play history",
};

function noteFor(item: FolderItem): string {
  if (NOTES[item.name]) return NOTES[item.name];
  if (item.name.startsWith("hs_err_pid")) return "Java crash dump — Sort Logs moves it";
  if (item.category === "logs") return "stray log — Sort Logs moves it";
  return "";
}

function FolderView({
  notify,
  root,
  go,
}: {
  notify: (m: string) => void;
  root: string;
  go: (v: View) => void;
}) {
  const [items, load] = useCached<FolderItem[]>("folder", api.folderOverview, notify);
  const { armed, confirm } = useConfirm(notify, load);
  const [open, setOpen] = useState<Set<FolderCategory>>(new Set());

  const toggle = (cat: FolderCategory) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });

  const groups = useMemo(
    () =>
      CATEGORIES.map(([cat, title, blurb]) => {
        const group = (items ?? []).filter((i) => i.category === cat);
        return { cat, title, blurb, group, size: group.reduce((n, i) => n + i.size_bytes, 0) };
      }).filter((g) => g.group.length > 0),
    [items]
  );
  const total = groups.reduce((n, g) => n + g.size, 0);

  // buttons inside a clickable header shouldn't also toggle it
  const act = (f: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    f();
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Minecraft Folder</h1>
          <p className="sub">
            {items ? `${items.length} items · ${formatBytes(total)}` : "measuring…"}
          </p>
        </div>
        <button className="btn" onClick={() => api.revealPath(root, false)} disabled={!root}>
          Open Folder
        </button>
      </header>

      {total > 0 && (
        <div className="size-map">
          <div className="size-bar">
            {groups.map((g) => (
              <span
                key={g.cat}
                className={`seg cat-${g.cat}`}
                style={{ flexGrow: g.size }}
                title={`${g.title} · ${formatBytes(g.size)}`}
              />
            ))}
          </div>
          <div className="size-legend">
            {groups.map((g) => (
              <button key={g.cat} onClick={() => toggle(g.cat)}>
                <span className={`swatch cat-${g.cat}`} />
                {g.title}
                <span className="pack-size">{formatBytes(g.size)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {groups.map(({ cat, title, blurb, group, size }) => {
        const isOpen = open.has(cat);
        return (
          <section key={cat} className={`folder-group ${isOpen ? "open" : ""}`}>
            <div
              className="folder-head"
              role="button"
              aria-expanded={isOpen}
              tabIndex={0}
              onClick={() => toggle(cat)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(cat)}
            >
              <span className="chevron">›</span>
              <span className={`swatch cat-${cat}`} />
              <div className="folder-title">
                <h2>
                  {title}
                  <span className="folder-count">
                    {group.length} item{group.length === 1 ? "" : "s"}
                  </span>
                </h2>
                <p className="hint">{blurb}</p>
              </div>
              <span className="pack-size">{formatBytes(size)}</span>
              {cat === "logs" && (
                <div className="row-inline">
                  <button className="btn small" onClick={act(() => go("logs"))}>
                    Browse
                  </button>
                  <button
                    className="btn small danger"
                    onClick={act(() => confirm("logs", () => purgeLogs()))}
                  >
                    {armed === "logs" ? "Sure?" : "Purge"}
                  </button>
                </div>
              )}
              {cat === "cache" && (
                <button
                  className="btn small danger"
                  onClick={act(() => confirm("cache", purgeCache))}
                >
                  {armed === "cache" ? "Sure?" : "Purge"}
                </button>
              )}
              {cat === "yours" && (
                <button className="btn small" onClick={act(() => go("saves"))}>
                  Saves
                </button>
              )}
            </div>
            {isOpen && (
              <ul className="pack-list folder-list">
                {group.map((i) => (
                  <li
                    key={i.name}
                    className="log-row"
                    title="Show in Finder"
                    onClick={() => api.revealPath(i.path)}
                  >
                    <span className="folder-name">
                      {i.name}
                      {i.is_dir ? "/" : ""}
                    </span>
                    <span className="folder-note">{noteFor(i)}</span>
                    <span className="pack-size">{formatBytes(i.size_bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {items && (
        <p className="hint wide folder-foot">
          Close the launcher and game before purging. Purged items go to the Trash.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

const LOG_KINDS = ["all", "game", "crash", "launcher", "updater", "debug"] as const;

function LogsView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [scope, setScope] = useState<string | null>(null);
  const [logs = [], load] = useCached<LogEntry[]>(
    `logs:${scope}`,
    () => api.listLogs(scope),
    notify
  );
  const [kind, setKind] = useState<(typeof LOG_KINDS)[number]>("all");
  const [open, setOpen] = useState<{ entry: LogEntry; text: string } | null>(null);

  const { armed, confirm } = useConfirm(notify, load);

  async function sort() {
    try {
      const n = await api.sortLogs(scope);
      notify(n ? `Sorted ${n} stray log${n === 1 ? "" : "s"} into logs/` : "Already tidy");
    } catch (e) {
      notify(String(e));
    }
    load();
  }

  async function view(entry: LogEntry) {
    try {
      setOpen({ entry, text: await api.readLog(entry.path) });
    } catch (e) {
      notify(String(e));
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: logs.length };
    for (const l of logs) c[l.kind] = (c[l.kind] ?? 0) + 1;
    return c;
  }, [logs]);

  const days = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const l of logs) {
      if (kind !== "all" && l.kind !== kind) continue;
      const day = l.modified
        ? new Date(l.modified).toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "Undated";
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(l);
    }
    return [...map.entries()];
  }, [logs, kind]);

  const unsorted = logs.filter((l) => !l.sorted).length;
  const logBytes = logs.reduce((n, l) => n + l.size_bytes, 0);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Logs</h1>
          <p className="sub">
            {logs.length} logs · {formatBytes(logBytes)}
            {unsorted > 0 && ` · ${unsorted} unsorted`}
          </p>
        </div>
        <div className="row-inline">
          <button className="btn primary" onClick={sort}>
            Sort Logs
          </button>
          <button
            className="btn danger"
            onClick={() => confirm(`logs:${scope}`, () => purgeLogs(scope))}
          >
            {armed === `logs:${scope}` ? "Sure?" : "Purge Logs"}
          </button>
        </div>
      </header>

      <div className="scope-tabs">
        {[null, ...installations.map((i) => i.name)].map((name) => (
          <button
            key={name ?? "main"}
            className={scope === name ? "active" : ""}
            onClick={() => {
              setScope(name);
              setKind("all");
            }}
          >
            {name ?? "Main folder"}
          </button>
        ))}
      </div>

      <p className="hint wide">
        Each installation is its own game folder, so the game writes its logs and crash
        reports there; the launcher's own logs only live in the main folder.{" "}
        From <code>logs/</code>, <code>crash-reports/</code>, <code>debug/</code> and stray
        files in the folder root. Sorting moves <code>hs_err_pid</code> crash dumps to{" "}
        <code>logs/old</code>, launcher logs to <code>logs/launcher</code>, and updater logs
        to <code>logs/updater</code>.
      </p>

      <div className="segmented kinds">
        {LOG_KINDS.filter((k) => k === "all" || counts[k]).map((k) => (
          <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
            {k} <span className="count">{counts[k] ?? 0}</span>
          </button>
        ))}
      </div>

      {days.map(([day, entries]) => (
        <section key={day} className="log-day">
          <h3>{day}</h3>
          <ul className="pack-list">
            {entries.map((l) => (
              <li key={l.path} className="log-row" onClick={() => view(l)}>
                <span className="log-time">
                  {l.modified
                    ? new Date(l.modified).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : ""}
                </span>
                <span className={`chip kind-${l.kind}`}>{l.kind}</span>
                <span className="log-name" title={l.rel}>
                  {l.name}
                </span>
                {!l.sorted && <span className="chip">unsorted</span>}
                <span className="pack-size">{formatBytes(l.size_bytes)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {logs.length === 0 && <div className="empty">No logs. Squeaky clean.</div>}

      {open && (
        <div className="viewer-backdrop" onClick={() => setOpen(null)}>
          <div className="viewer" onClick={(e) => e.stopPropagation()}>
            <div className="viewer-head">
              <span className={`chip kind-${open.entry.kind}`}>{open.entry.kind}</span>
              <code>{open.entry.rel}</code>
              <span className="viewer-actions">
                <button className="linklike" onClick={() => api.revealPath(open.entry.path)}>
                  reveal
                </button>
                <button className="linklike" onClick={() => setOpen(null)}>
                  close
                </button>
              </span>
            </div>
            <pre className="viewer-body">{open.text || "(empty)"}</pre>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
