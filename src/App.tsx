import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  api,
  formatBytes,
  timeAgo,
  Installation,
  LinkInfo,
  Loader,
  reportSummary,
  GameVersion,
  LoaderVersion,
  Standard,
  entriesFor,
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
import { ProfilesView } from "./ProfilesView";
import { PlaceChip, PlacePicker, StandardAvatar, nameGradient } from "./Places";
import { ProgressBar, useProgress } from "./Progress";
import { PacksView } from "./PacksView";
import { UpdateButton } from "./UpdateButton";
import { ConfigView } from "./ConfigView";
import { Settings, applySettings, brief, loadSettings, saveSettings } from "./settings";
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
  | "config"
  | "logs"
  | "profiles"
  | "settings";

// Library: things you own and control. Minecraft Folder: housekeeping.
const NAV: [string, [View, string][]][] = [
  [
    "Library",
    [
      ["installations", "Installations"],
      ["standards", "Standards"],
      ["saves", "Saves"],
      ["mods", "Mods"],
      ["packs", "Resource Packs"],
      ["options", "Options"],
      ["config", "Config"],
      ["servers", "Servers"],
      ["screenshots", "Screenshots"],
    ],
  ],
  [
    "Minecraft Folder",
    [
      ["folder", "Overview"],
      ["logs", "Logs"],
      ["profiles", "Launcher Profiles"],
    ],
  ],
];

const COLLAPSED_KEY = "mim.sidebarCollapsed";

function App() {
  const [view, setView] = useState<View>("installations");
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [mcDir, setMcDir] = useState<{ path: string; sample: boolean } | null>(null);
  const toastTimer = useRef<number>(undefined);
  // applied before render (not in an effect) so brief() text matches on that render
  const [settings, setSettings] = useState<Settings>(() => {
    const s = loadSettings();
    applySettings(s);
    return s;
  });
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        // storage off — just won't be remembered
      }
      return !c;
    });
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "\\") toggleSidebar();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggleSidebar]);
  const changeSettings = (s: Settings) => {
    applySettings(s);
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
    <div className={`app ${collapsed ? "collapsed" : ""}`}>
      <button
        className="sidebar-toggle"
        onClick={toggleSidebar}
        title={collapsed ? "Show sidebar (⌘\\)" : "Hide sidebar (⌘\\)"}
        aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <aside className="sidebar">
        <div className="titlebar" data-tauri-drag-region />
        <div className="wordmark" data-tauri-drag-region>MIM</div>
        <div className="tagline">installation manager</div>
        <button
          className={`nav-new ${view === "new" ? "active" : ""}`}
          onClick={() => setView("new")}
        >
          <span className="plus">+</span> New Install
        </button>
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
          <div className="foot-row">
            <button
              className={`nav-item ${view === "settings" ? "active" : ""}`}
              onClick={() => setView("settings")}
            >
              Settings
            </button>
            <UpdateButton notify={notify} />
          </div>
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
            installations={installations}
            onDone={() => {
              refresh();
              setView("installations");
            }}
          />
        )}
        {view === "standards" && (
          <StandardsView notify={notify} installations={installations} />
        )}
        {view === "packs" && <PacksView notify={notify} installations={installations} />}
        {view === "folder" && (
          <FolderView
            notify={notify}
            root={mcDir?.path ?? ""}
            go={(v: View) => setView(v)}
          />
        )}
        {view === "saves" && <SavesView notify={notify} installations={installations} />}
        {view === "options" && <OptionsView notify={notify} installations={installations} />}
        {view === "config" && <ConfigView notify={notify} installations={installations} />}
        {view === "logs" && <LogsView notify={notify} installations={installations} />}
        {view === "servers" && <ServersView notify={notify} installations={installations} />}
        {view === "screenshots" && (
          <ScreenshotsView notify={notify} installations={installations} />
        )}
        {view === "mods" && (
          <ModsView notify={notify} installations={installations} onChanged={refresh} />
        )}
        {view === "profiles" && <ProfilesView notify={notify} onChanged={refresh} />}
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
          : brief("Nothing to link — folders already exist")
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
              {inst.loader && inst.loader !== "vanilla" && (
                <span className="chip on-art">{inst.loader}</span>
              )}
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
  installations,
  onDone,
}: {
  notify: (m: string) => void;
  installations: Installation[];
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
  const [loader, setLoader] = useState<Loader>("fabric");
  const [loaders, setLoaders] = useState<LoaderVersion[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [standards = []] = useCached<Standard[]>("standards", api.listStandards, notify);
  // null until the user touches it: then the built-in Shared folders are on by default
  const [touched, setPicked] = useState<Set<string> | null>(null);
  const picked = useMemo(
    () =>
      touched ??
      new Set(standards.filter((s) => s.builtin).flatMap((s) => s.entries.map((e) => e.rel_path))),
    [touched, standards]
  );
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // standards show as one checkbox each; expanding one lets you pick single files
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // optional Modrinth/CurseForge links imported right after installing
  const [links, setLinks] = useState<string[]>([""]);
  const [automodpack, setAutomodpack] = useState(false);
  const [modsOpen, setModsOpen] = useState(false);
  const progress = useProgress(!!busy);
  const wanted = [...links.filter((l) => l.trim()), ...(automodpack ? ["automodpack"] : [])];

  /** A pasted mod or pack picks its newest game version and a loader it supports. */
  function matchLink(info: LinkInfo, only: boolean) {
    if (info.kind === "modpack" || only) {
      const v = versions.find((x) => info.game_versions.includes(x.id));
      if (v) {
        if (v.type !== "release") setShowSnapshots(true);
        setGameVersion(v.id);
      }
    }
    if (info.loaders.length && !info.loaders.includes(loader)) {
      const fit = (["fabric", "neoforge", "forge"] as const).find((l) => info.loaders.includes(l));
      if (fit) setLoader(fit);
    }
    if (info.kind === "modpack" || info.kind === "collection") setName((n) => n || info.title);
  }

  // pictures already in use on installations, plus any dropped into a standard
  const images = useMemo(
    () => [
      ...installations
        .filter((i) => i.icon?.startsWith("data:"))
        .map((i) => ({ path: `${i.path}/.mim/icon.png`, src: i.icon!, label: `from ${i.name}` })),
      ...standards.flatMap((s) =>
        s.images.map((p) => ({
          path: p,
          src: convertFileSrc(p),
          label: `${p.split(/[\\/]/).pop()} · ${s.builtin ? "standards folder" : s.name}`,
        }))
      ),
    ],
    [installations, standards]
  );
  const external = imagePath && !images.some((i) => i.path === imagePath) ? imagePath : null;

  useEffect(() => {
    if (gameVersion) return;
    const latest = versions.find((x) => x.type === "release");
    if (latest) setGameVersion(latest.id);
  }, [versions, gameVersion]);

  useEffect(() => {
    if (loader === "vanilla" || !gameVersion) return;
    setLoaders([]);
    setLoaderVersion("");
    api
      .listLoaderVersions(loader, gameVersion)
      .then((l) => {
        setLoaders(l);
        const stable = l.find((x) => x.stable) ?? l[0];
        if (stable) setLoaderVersion(stable.version);
      })
      .catch(() => setLoaders([]));
  }, [loader, gameVersion]);

  const visibleVersions = useMemo(
    () => versions.filter((v) => showSnapshots || v.type === "release"),
    [versions, showSnapshots]
  );

  const relevantStandards = useMemo(
    () =>
      standards
        .map((s) => ({ s, entries: entriesFor(s, gameVersion) }))
        .filter((g) => g.entries.length > 0),
    [standards, gameVersion]
  );

  // stacking standards is fine, but only one can supply each file: picking
  // PvP's options.txt drops Everyday's
  function toggle(rels: string[], on: boolean) {
    const all = relevantStandards.flatMap((g) => g.entries);
    const std = (r: string) => r.split("/")[0];
    setPicked(() => {
      const next = new Set(picked);
      for (const r of rels) {
        if (!on) {
          next.delete(r);
          continue;
        }
        const name = all.find((e) => e.rel_path === r)?.name;
        for (const e of all)
          if (e.name === name && std(e.rel_path) !== std(r)) next.delete(e.rel_path);
        next.add(r);
      }
      return next;
    });
  }

  async function install() {
    if (!name.trim()) return notify("Give it a name first");
    if (!gameVersion) return notify("Pick a version");
    setBusy(
      loader === "forge" ? "Installing Forge…" : loader === "neoforge" ? "Installing NeoForge…" : "Installing…"
    );
    try {
      await api.createInstallation({
        name: name.trim(),
        game_version: gameVersion,
        loader,
        loader_version: loader !== "vanilla" && loaderVersion ? loaderVersion : null,
        standards: [...picked].filter((r) =>
          relevantStandards.some((g) => g.entries.some((e) => e.rel_path === r))
        ),
      });
      if (imagePath) {
        await api.setCustomIcon(name.trim(), imagePath).catch(() => {});
      }
      if (loader !== "vanilla" && wanted.length) {
        setBusy("Importing from Modrinth…");
        try {
          const r = await api.importLinks(wanted, name.trim());
          notify(`Installed "${name.trim()}" · ${reportSummary(r)}`);
        } catch (e) {
          notify(`Installed "${name.trim()}", but the import failed: ${e}`);
        }
        return onDone();
      }
      notify(brief(`Installed "${name.trim()}" — it's in your launcher`));
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

      <div className="install-layout">
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
              <span className="inline-check">
                <input
                  type="checkbox"
                  checked={showSnapshots}
                  onChange={(e) => setShowSnapshots(e.target.checked)}
                />
                snapshots
              </span>
            </span>
            <select value={gameVersion} onChange={(e) => setGameVersion(e.target.value)}>
              {visibleVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span>Loader</span>
            <div className="segmented">
              {(["vanilla", "fabric", "forge", "neoforge"] as const).map((l) => (
                <button key={l} className={loader === l ? "active" : ""} onClick={() => setLoader(l)}>
                  {LOADER_NAMES[l]}
                </button>
              ))}
            </div>
          </div>

          {loader !== "vanilla" && (
            <label>
              <span>{loader === "fabric" ? "Fabric loader" : `${LOADER_NAMES[loader]} version`}</span>
              <select
                value={loaderVersion}
                onChange={(e) => setLoaderVersion(e.target.value)}
                disabled={loaders.length === 0}
              >
                {loaders.length === 0 && <option>no loader for this version</option>}
                {loaders.map((l) => (
                  <option key={l.version} value={l.version}>
                    {l.version}
                    {loader === "forge" ? (l.stable ? " (recommended)" : "") : l.stable ? "" : " (beta)"}
                  </option>
                ))}
              </select>
            </label>
          )}

          {loader !== "vanilla" && (
            <details
              className="field mods-from"
              open={modsOpen}
              onToggle={(e) => setModsOpen(e.currentTarget.open)}
            >
              <summary>
                Mods from Modrinth
                <span className="optional">
                  {wanted.length
                    ? `${wanted.length} to add${modsOpen ? "" : " · edit"}`
                    : "optional"}
                </span>
              </summary>
              <div className="mods-from-body">
                {links.map((l, i) => (
                  <LinkField
                    key={i}
                    value={l}
                    loader={loader}
                    gameVersion={gameVersion}
                    onChange={(v) => setLinks((prev) => prev.map((x, j) => (j === i ? v : x)))}
                    onRemove={
                      links.length > 1
                        ? () => setLinks((prev) => prev.filter((_, j) => j !== i))
                        : undefined
                    }
                    onResolved={(info) => matchLink(info, links.filter((x) => x.trim()).length === 1)}
                  />
                ))}
                <div className="mods-from-foot">
                  <button className="linklike" onClick={() => setLinks((prev) => [...prev, ""])}>
                    + another link
                  </button>
                  <label className="inline-check" title="Syncs a server's mods when you join it">
                    <input
                      type="checkbox"
                      checked={automodpack}
                      onChange={(e) => setAutomodpack(e.target.checked)}
                    />
                    Add AutoModpack
                  </label>
                </div>
                <p className="hint">
                  A mod, collection or modpack
                  <span className="more"> — CurseForge links work when the mod is on Modrinth too. Only builds
                  for this version and loader are installed.</span>
                </p>
              </div>
            </details>
          )}

          <div className="field">
            <span>Image</span>
            <div className="image-picks">
              <button
                className={`image-pick none ${imagePath ? "" : "active"}`}
                onClick={() => setImagePath(null)}
                title={brief("No image — a soft gradient with the first letter")}
                style={{ background: nameGradient(name.trim() || "?") }}
              >
                {(name.trim() || "?")[0]}
              </button>
              {images.map((im) => (
                <button
                  key={im.path}
                  className={`image-pick ${imagePath === im.path ? "active" : ""}`}
                  onClick={() => setImagePath(im.path)}
                  title={im.label}
                  style={{ backgroundImage: `url(${im.src})` }}
                />
              ))}
              {external && (
                <button className="image-pick file active" title={external}>
                  {external.split(/[\\/]/).pop()}
                </button>
              )}
              <button
                className="image-pick add"
                title="Choose an image file…"
                onClick={async () => {
                  const p = await openDialog({
                    multiple: false,
                    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
                  });
                  if (typeof p === "string") setImagePath(p);
                }}
              >
                +
              </button>
            </div>
            <p className="hint more">
              Reuse a picture from another installation, or drop images into a standard's
              folder to share them here.
            </p>
          </div>
        </div>

        <div className="form">
          <div className="field">
            <span>{brief("Linked standards — changes stay in sync")}</span>
            {relevantStandards.length > 0 ? (
              <div className="based-list">
                {relevantStandards.map(({ s, entries }) => {
                  const rels = entries.map((e) => e.rel_path);
                  const n = rels.filter((r) => picked.has(r)).length;
                  const open = expanded.has(s.name);
                  return (
                    <div key={s.name} className={`based ${n ? "on" : ""}`}>
                      <div className="based-head">
                        <label className="based-main">
                          <input
                            type="checkbox"
                            checked={n === rels.length}
                            ref={(el) => {
                              if (el) el.indeterminate = n > 0 && n < rels.length;
                            }}
                            onChange={() => toggle(rels, n < rels.length)}
                          />
                          <StandardAvatar s={s} />
                          <span className="place-text">
                            <span className="place-label">{s.name}</span>
                            <span className="place-sub">
                              {n > 0 && n < rels.length
                                ? `${n} of ${rels.length} · `
                                : ""}
                              {entries.map((e) => e.name + (e.is_dir ? "/" : "")).join(" · ")}
                            </span>
                          </span>
                        </label>
                        <button
                          className="linklike based-more"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              open ? next.delete(s.name) : next.add(s.name);
                              return next;
                            })
                          }
                        >
                          {open ? "Done" : "Customize"}
                        </button>
                      </div>
                      {open && (
                        <div className="based-files">
                          {entries.map((e) => (
                            <label
                              key={e.rel_path}
                              className={`file-chip ${picked.has(e.rel_path) ? "on" : ""}`}
                            >
                              <input
                                type="checkbox"
                                checked={picked.has(e.rel_path)}
                                onChange={() => toggle([e.rel_path], !picked.has(e.rel_path))}
                              />
                              {e.name}
                              {e.is_dir ? "/" : ""}
                              {e.scope !== "global" && <span className="chip">{e.scope}</span>}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="hint">
                No standard has files for this version
                <span className="more"> — create one under Standards and drop an options.txt, resource packs,
                or mod configs in it.</span>
              </p>
            )}
          </div>
        </div>

        <button className="btn primary big install-go" onClick={install} disabled={!!busy}>
          {busy ?? "Install"}
        </button>
        {busy && (
          <div className="install-progress">
            <ProgressBar p={progress} fallback={busy} />
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function StandardsView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [standards = [], load] = useCached<Standard[]>("standards", api.listStandards, notify);
  const [newName, setNewName] = useState("");
  const { armed, confirm } = useConfirm(notify, load);
  // a link or unlink waiting on the user's answer
  const [ask, setAsk] = useState<
    | { kind: "blocked"; std: string; inst: string; items: string[] }
    | { kind: "unlink"; std: string; inst: string }
    | null
  >(null);

  async function create() {
    if (!newName.trim()) return;
    try {
      await api.createStandard(newName);
      setNewName("");
      load();
    } catch (e) {
      notify(String(e));
    }
  }

  async function link(s: Standard, inst: string, replace = false) {
    const v = installations.find((i) => i.name === inst)?.game_version ?? null;
    const rels = entriesFor(s, v).map((e) => e.rel_path);
    try {
      const inWay = await api.linkStandard(s.name, inst, rels, replace);
      if (inWay.length && !replace) {
        setAsk({ kind: "blocked", std: s.name, inst, items: inWay });
        return;
      }
      setAsk(null);
      notify(
        `Linked "${s.name}" into ${inst}` +
          (inWay.length ? ` · moved ${inWay.join(", ")} to Trash` : "")
      );
      load();
    } catch (e) {
      notify(String(e));
    }
  }

  async function unlink(s: Standard, inst: string, keep: boolean) {
    try {
      await api.unlinkStandard(s.name, inst, keep);
      setAsk(null);
      notify(keep ? brief(`Unlinked ${inst} — it keeps a copy`) : `Unlinked ${inst} and removed its links`);
      load();
    } catch (e) {
      notify(String(e));
    }
  }

  const remove = (s: Standard) =>
    confirm(`del:${s.name}`, async () => {
      await api.deleteStandard(s.name);
      return brief(`Moved "${s.name}" to Trash — linked installations keep copies`);
    });

  async function openFolder() {
    const path = await api.ensureStandardsDir();
    await api.revealPath(path, false);
    load();
  }

  const list = (items: string[]) =>
    items.map((n, k) => (
      <span key={n}>
        {k > 0 && ", "}
        <code>{n}</code>
      </span>
    ));

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Standards</h1>
          <p className="sub">folders you link into installations</p>
        </div>
        <button className="btn" onClick={openFolder}>
          Open Folder
        </button>
      </header>

      <p className="hint wide">
        A standard's files are symlinked into each linked installation, so a change on either
        side shows up everywhere.<span className="more"> <b>Shared</b> is built in: the Minecraft folder's own
        resource packs, saves and screenshots. Your own standards live in{" "}
        <code>minecraft/standards</code> — top-level files apply to every version, a subfolder
        named like a version (<code>1.21.10/</code>) only to that version. A <code>config/</code>{" "}
        folder is linked file by file, so installations keep their other mod configs — use{" "}
        <b>Share</b> on the Config page to put one there.</span>
      </p>

      <div className="row-inline std-new">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="New standard, e.g. PvP"
        />
        <button className="btn" onClick={create} disabled={!newName.trim()}>
          Create
        </button>
      </div>

      {standards.map((s) => (
        <section key={s.name} className="std-card">
          <div className="std-head">
            <StandardAvatar s={s} />
            <div className="std-title">
              <h2>{s.name}</h2>
              <span className="place-sub">
                {s.builtin ? "built in · the Minecraft folder" : `minecraft/standards/${s.name}`}
              </span>
            </div>
            <div className="row-inline std-actions">
              <button className="btn small" onClick={() => api.revealPath(s.path, false)}>
                Open
              </button>
              {!s.builtin && (
                <button className="btn small danger" onClick={() => remove(s)}>
                  {armed === `del:${s.name}` ? "Sure?" : "Delete"}
                </button>
              )}
            </div>
          </div>

          {s.entries.length > 0 ? (
            <div className="std-files">
              {s.entries.map((e) => (
                <span key={e.rel_path} className="std-file">
                  {e.name}
                  {e.is_dir ? "/" : ""}
                  {e.scope !== "global" && <span className="chip">{e.scope}</span>}
                </span>
              ))}
            </div>
          ) : (
            <p className="hint">
              Empty —{" "}
              <button className="linklike" onClick={() => api.revealPath(s.path, false)}>
                open it
              </button>{" "}
              <span className="more">and drop an options.txt, resource packs or mod configs in</span>.
            </p>
          )}

          <div className="std-label">Linked installations</div>
          <div className="places">
            {installations.map((i) => {
              const on = s.installations.includes(i.name);
              const want = entriesFor(s, i.game_version).length;
              // a new file in the standard, or something replaced a link with a real file
              const stale = on && (s.live[i.name] ?? 0) < want;
              return (
                <PlaceChip
                  key={i.name}
                  className="toggle"
                  place={{
                    key: i.name,
                    label: i.name,
                    inst: i,
                    sub: stale ? `↻ ${s.live[i.name] ?? 0} of ${want} linked` : on ? "linked" : "not linked",
                  }}
                  active={on}
                  title={stale ? brief("Some files aren't linked — click to relink") : on ? "Unlink…" : "Link"}
                  onClick={() =>
                    stale || !on
                      ? link(s, i.name)
                      : setAsk({ kind: "unlink", std: s.name, inst: i.name })
                  }
                />
              );
            })}
            {installations.length === 0 && <span className="hint">No installations yet.</span>}
          </div>

          {ask?.std === s.name && ask.kind === "blocked" && (
            <div className="std-ask warn">
              <p>
                <b>{ask.inst}</b> already has {list(ask.items)}. To link "{s.name}",{" "}
                {ask.items.length === 1 ? "it has" : "they have"} to be removed — MIM moves{" "}
                {ask.items.length === 1 ? "it" : "them"} to the Trash.
              </p>
              <div className="row-inline">
                <button className="btn small danger" onClick={() => link(s, ask.inst, true)}>
                  Move to Trash &amp; link
                </button>
                <button className="btn small" onClick={() => setAsk(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {ask?.std === s.name && ask.kind === "unlink" && (
            <div className="std-ask">
              <p>
                Unlink <b>{ask.inst}</b> from "{s.name}"? Do you want to remove the files from{" "}
                {ask.inst}, or keep a copy of them there? Nothing in "{s.name}" is deleted either
                way.
              </p>
              <div className="row-inline">
                <button className="btn small" onClick={() => unlink(s, ask.inst, true)}>
                  Keep a copy
                </button>
                <button className="btn small danger" onClick={() => unlink(s, ask.inst, false)}>
                  Remove the files
                </button>
                <button className="btn small ghost" onClick={() => setAsk(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      ))}
    </>
  );
}

/** One pasted link, looked up as you type so you can see what it is. */
function LinkField({
  value,
  loader,
  gameVersion,
  onChange,
  onRemove,
  onResolved,
}: {
  value: string;
  loader: Loader;
  gameVersion: string;
  onChange: (v: string) => void;
  onRemove?: () => void;
  onResolved: (info: LinkInfo) => void;
}) {
  const [info, setInfo] = useState<LinkInfo | string | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!value.trim()) return;
    const t = setTimeout(() => {
      api
        .resolveLink(value)
        .then((i) => {
          setInfo(i);
          onResolved(i);
        })
        .catch((e) => setInfo(String(e)));
    }, 400);
    return () => clearTimeout(t);
    // onResolved changes every render; only a new link should look it up again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const ok = info && typeof info !== "string" ? info : null;
  const warn = ok
    ? [
        ok.kind === "collection" && `${ok.projects.length} projects`,
        ok.note,
        ok.kind !== "collection" &&
          ok.game_versions.length > 0 &&
          !ok.game_versions.includes(gameVersion) &&
          `no ${gameVersion} version`,
        ok.kind !== "collection" &&
          ok.loaders.length > 0 &&
          ["mod", "modpack"].includes(ok.kind) &&
          !ok.loaders.includes(loader) &&
          `not made for ${loader}`,
      ].filter(Boolean)
    : [];
  return (
    <div className="link-field">
      <div className="link-input">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste a Modrinth link"
        />
        {onRemove && (
          <button className="link-remove" onClick={onRemove} title="Remove this link">
            ×
          </button>
        )}
      </div>
      {value.trim() && (
        <p className={`link-info ${typeof info === "string" ? "bad" : ""} ${warn.length ? "warn" : ""}`}>
          {ok?.icon && <img src={ok.icon} alt="" />}
          <span>
            {info == null
              ? "Looking it up…"
              : typeof info === "string"
                ? info
                : [`${info.title} · ${info.kind}`, ...warn].join(" · ")}
          </span>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const LOADER_NAMES: Record<Loader, string> = {
  vanilla: "Vanilla",
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
};

const purgeLogs = async (installation: string | null = null) =>
  `Moved ${await api.purgeLogs(installation)} log items to Trash`;
const purgeCache = async () => `Moved ${await api.purgeCache()} cache items to Trash`;

const CATEGORIES: [FolderCategory, string, string][] = [
  ["logs", "Logs", "Text records of what the game and launcher did. Useful for debugging crashes, safe to delete."],
  ["cache", "Cache", "Temporary downloads and caches. Safe to delete — the launcher and game rebuild them."],
  ["yours", "Library", "Worlds, packs, screenshots, mods and settings. MIM never touches these."],
  ["game", "Dependencies", "Downloaded by the launcher. Deleting them just forces a big re-download."],
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
  if (item.name.startsWith("hs_err_pid")) return brief("Java crash dump — Sort Logs moves it");
  if (item.category === "logs") return brief("stray log — Sort Logs moves it");
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
                <p className="hint">{brief(blurb)}</p>
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

      <PlacePicker
        places={[
          { key: "", label: "Minecraft folder", kind: "root", sub: "game & launcher logs" },
          ...installations.map((i) => ({ key: i.name, label: i.name, inst: i, sub: "game logs" })),
        ]}
        value={scope ?? ""}
        onChange={(k) => {
          setScope(k || null);
          setKind("all");
        }}
      />

      <p className="hint wide more">
        Each installation is its own game folder, so the game writes its logs and crash
        reports there; the launcher's own logs only live in the Minecraft folder.{" "}
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
