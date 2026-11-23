import { Component, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ShadersView } from "./ShadersView";
import { SettingsView } from "./SettingsView";
import { ProfilesView } from "./ProfilesView";
import { instancePlaces, PlaceChip, PlacePicker, StandardAvatar, nameGradient } from "./Places";
import { ProgressBar, useProgress } from "./Progress";
import { PacksView } from "./PacksView";
import { UpdateButton } from "./UpdateButton";
import { ConfigView } from "./ConfigView";
import { LinkEditor } from "./LinkEditor";
import { AddToStandard } from "./AddToStandard";
import { RemoveFromStandard, StandardFiles, StandardSummary } from "./StandardFiles";
import { LinksDrawer } from "./LinksDrawer";
import { LinkWizard } from "./LinkWizard";
import { UpgradeDrawer } from "./UpgradeDrawer";
import { Settings, applySettings, brief, loadSettings, saveSettings } from "./settings";
import "./App.css";

type View =
  | "installations"
  | "new"
  | "link"
  | "standards"
  | "packs"
  | "shaders"
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
      ["shaders", "Shader Packs"],
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

  const sidebarToggle = (
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
  );

  return (
    <div className={`app ${collapsed ? "collapsed" : ""}`}>
      {sidebarToggle}
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
        <button
          className={`nav-new nav-link ${view === "link" ? "active" : ""}`}
          onClick={() => setView("link")}
          title="Compare installations you already have and link them"
        >
          <span className="plus">⇄</span> Link Existing
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
              Sample folder
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
          <button className="nav-item foot-link" onClick={() => api.openLauncher()}>
            Open Launcher
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
              <path d="M3 9l6-6M4 3h5v5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </aside>

      <main className="content" key={view}>
        <div className="topbar" data-tauri-drag-region />
        <Crashed onBack={() => setView("installations")}>
        {view === "installations" && (
          <InstallationsView
            sidebarToggle={sidebarToggle}
            installations={installations}
            refresh={refresh}
            notify={notify}
            onNew={() => setView("new")}
            onLink={() => setView("link")}
            onStandards={() => setView("standards")}
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
        {view === "link" && (
          <LinkWizard
            installations={installations}
            notify={notify}
            onDone={refresh}
            onStandards={() => setView("standards")}
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
            installations={installations}
          />
        )}
        {view === "saves" && <SavesView notify={notify} installations={installations} />}
        {view === "options" && <OptionsView notify={notify} installations={installations} />}
        {view === "config" && <ConfigView notify={notify} installations={installations} />}
        {view === "logs" && <LogsView notify={notify} installations={installations} />}
        {view === "servers" && <ServersView notify={notify} installations={installations} />}
        {view === "shaders" && <ShadersView notify={notify} installations={installations} />}
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
        </Crashed>
      </main>

      {toast && <Toast message={toast} />}
    </div>
  );
}

/** A view that throws while rendering shows this instead of a blank window. */
class Crashed extends Component<{ children: ReactNode; onBack: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty crashed">
        <p>Something went wrong on this page.</p>
        <code>{this.state.error.message}</code>
        <div className="row-inline">
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="btn primary" onClick={this.props.onBack}>
            Back to Installations
          </button>
        </div>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------

function InstallationsView({
  sidebarToggle,
  installations,
  refresh,
  notify,
  onNew,
  onLink,
  onStandards,
}: {
  sidebarToggle: React.ReactNode;
  installations: Installation[];
  refresh: () => void;
  notify: (m: string) => void;
  onNew: () => void;
  onLink: () => void;
  onStandards: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [standards = [], loadStandards] = useCached<Standard[]>("standards", api.listStandards, notify);
  const [linking, setLinking] = useState<string | null>(null);
  const linkingInst = installations.find((i) => i.name === linking);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const upgradingInst = installations.find((i) => i.name === upgrading);
  const [renaming, setRenaming] = useState<string | null>(null);

  async function rename(inst: Installation, to: string) {
    if (renaming !== inst.name) return; // Enter already handled it before the blur
    setRenaming(null);
    if (!to.trim() || to.trim() === inst.name) return;
    try {
      await api.renameInstallation(inst.name, to.trim());
      notify(brief(`Renamed to "${to.trim()}" — folder, launcher profile and links follow`));
      refresh();
      loadStandards();
    } catch (e) {
      notify(String(e));
    }
  }

  async function duplicate(inst: Installation) {
    const taken = new Set(installations.map((i) => i.name.toLowerCase()));
    let to = `${inst.name} copy`;
    for (let n = 2; taken.has(to.toLowerCase()); n++) to = `${inst.name} copy ${n}`;
    notify(`Duplicating "${inst.name}"…`);
    try {
      await api.duplicateInstallation(inst.name, to);
      notify(brief(`Made "${to}" — click its name to rename it`));
      refresh();
      loadStandards();
    } catch (e) {
      notify(String(e));
    }
  }

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
        <div className="row-inline head-actions">
          {installations.length > 1 && (
            <button className="btn" onClick={onLink}>
              ⇄ Link Existing
            </button>
          )}
          <button className="btn primary" onClick={onNew}>
            + New Install
          </button>
        </div>
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
              <button
                className="art-edit"
                aria-label={`Change image for ${inst.name}`}
                title="Change image"
                onClick={() => pickImage(inst)}
              >
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M5.6 2.5h4.8l1 1.6h1.9A1.7 1.7 0 0 1 15 5.8v6A1.7 1.7 0 0 1 13.3 13.5H2.7A1.7 1.7 0 0 1 1 11.8v-6a1.7 1.7 0 0 1 1.7-1.7h1.9zM8 6a2.8 2.8 0 1 0 0 5.6A2.8 2.8 0 0 0 8 6z"
                  />
                </svg>
              </button>
            </div>
            <div className="card-body">
              {renaming === inst.name ? (
                <input
                  className="card-name card-rename"
                  autoFocus
                  defaultValue={inst.name}
                  aria-label="New name"
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") rename(inst, e.currentTarget.value);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={(e) => rename(inst, e.target.value)}
                />
              ) : (
                <button
                  className="card-name"
                  title={`${inst.name} — click to rename`}
                  onClick={() => setRenaming(inst.name)}
                >
                  {inst.name}
                </button>
              )}
              <div className="card-meta">
                {inst.game_version && <code>{inst.game_version}</code>}
                {inst.mods_count > 0 && <span>{inst.mods_count} mods</span>}
                <span>{timeAgo(inst.last_used)}</span>
              </div>
              <button className="card-links" title="Links…" onClick={() => setLinking(inst.name)}>
                {["resourcepacks", "saves", "screenshots"].map((d) => (
                  <span
                    key={d}
                    className={`dot ${inst.linked.includes(d) ? "linked" : ""}`}
                  >
                    {d.replace("resourcepacks", "packs")}
                  </span>
                ))}
                {(() => {
                  const own = standards.filter((s) => !s.builtin && s.installations.includes(inst.name));
                  return own.length > 0 && (
                    <span className="dot linked std" title={own.map((s) => s.name).join(", ")}>
                      {own.length === 1 ? own[0].name : `${own.length} standards`}
                    </span>
                  );
                })()}
              </button>
              <div className="card-actions">
                <button onClick={() => api.revealPath(inst.path, false)}>Open</button>
                <button onClick={() => setRenaming(inst.name)}>Rename</button>
                <button title="Copy it, its mods and settings under a new name" onClick={() => duplicate(inst)}>
                  Duplicate
                </button>
                <button onClick={() => setLinking(inst.name)}>Links</button>
                {inst.registered && (
                  <button title="Move it and its mods to a newer Minecraft" onClick={() => setUpgrading(inst.name)}>
                    Upgrade
                  </button>
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

      {upgradingInst && (
        <UpgradeDrawer
          sidebarToggle={sidebarToggle}
          inst={upgradingInst}
          notify={notify}
          onChanged={refresh}
          onClose={() => setUpgrading(null)}
        />
      )}
      {linkingInst && (
        <LinksDrawer
          sidebarToggle={sidebarToggle}
          inst={linkingInst}
          standards={standards}
          notify={notify}
          onChanged={() => {
            loadStandards();
            refresh();
          }}
          onClose={() => setLinking(null)}
          onManage={onStandards}
        />
      )}
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
  // null until the user touches it: everything on Shared's list is on by default
  const [touched, setPicked] = useState<Set<string> | null>(null);
  const picked = useMemo(
    () =>
      touched ??
      new Set(standards.filter((s) => s.builtin).flatMap((s) => entriesFor(s, gameVersion).map((e) => e.rel_path))),
    [touched, standards, gameVersion]
  );
  // how each picked item comes in; unset means link for folders, copy for files
  const [modes, setModes] = useState<Record<string, "link" | "copy">>({});
  // open means on: imports need a real folder, so resource packs come in as
  // copies. `modes` is left alone, so closing the section restores each choice.
  const [packLinks, setPackLinks] = useState<string[]>([""]);
  const [packsOpen, setPacksOpen] = useState(false);
  const wantedPacks = packsOpen ? packLinks.filter((l) => l.trim()) : [];
  const forcedCopy = (e: { name: string }) =>
    packsOpen && (e.name === "resourcepacks" || e.name.startsWith("resourcepacks/"));
  const isCopied = (e: { name: string; rel_path: string; is_dir: boolean }) =>
    forcedCopy(e) || (modes[e.rel_path] ?? (e.is_dir ? "link" : "copy")) === "copy";
  const flipCopy = (e: { name: string; rel_path: string; is_dir: boolean }) => {
    // linking packs means sharing them, which is the section being off
    if (forcedCopy(e)) setPacksOpen(false);
    setModes((m) => ({ ...m, [e.rel_path]: isCopied(e) ? "link" : "copy" }));
  };
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
        ...(() => {
          const chosen = relevantStandards.flatMap((g) => g.entries).filter((e) => picked.has(e.rel_path));
          return {
            standards: chosen.filter((e) => !isCopied(e)).map((e) => e.rel_path),
            copies: chosen.filter(isCopied).map((e) => e.rel_path),
          };
        })(),
      });
      if (imagePath) {
        await api.setCustomIcon(name.trim(), imagePath).catch(() => {});
      }
      const mods = loader !== "vanilla" ? wanted : [];
      if (mods.length || wantedPacks.length) {
        setBusy("Importing from Modrinth…");
        const notes: string[] = [];
        for (const [list, onlyPacks] of [[mods, false], [wantedPacks, true]] as [string[], boolean][]) {
          if (!list.length) continue;
          const what = onlyPacks ? "resource packs" : "mods";
          try {
            notes.push(`${what}: ${reportSummary(await api.importLinks(list, name.trim(), onlyPacks ? "resourcepack" : null))}`);
          } catch (e) {
            notes.push(`${what} failed: ${e}`);
          }
        }
        notify(`Installed "${name.trim()}" · ${notes.join(" · ")}`);
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

          <details
            className="field mods-from"
            open={packsOpen}
            onToggle={(e) => setPacksOpen(e.currentTarget.open)}
          >
            <summary>
              With resource packs
              <span className="optional">
                {packsOpen ? (wantedPacks.length ? `${wantedPacks.length} to add` : "on") : "optional"}
              </span>
            </summary>
            <div className="mods-from-body">
              {packLinks.map((l, i) => (
                <LinkField
                  key={i}
                  value={l}
                  loader={loader}
                  gameVersion={gameVersion}
                  onlyPacks
                  onChange={(v) => setPackLinks((prev) => prev.map((x, j) => (j === i ? v : x)))}
                  onRemove={
                    packLinks.length > 1
                      ? () => setPackLinks((prev) => prev.filter((_, j) => j !== i))
                      : undefined
                  }
                />
              ))}
              <div className="mods-from-foot">
                <button className="linklike" onClick={() => setPackLinks((prev) => [...prev, ""])}>
                  + another link
                </button>
              </div>
              <p className="hint">
                A resource pack or collection
                <span className="more"> — your shared packs are copied in, so these stay with this install.
                Switching them back to linked closes this section.</span>
              </p>
            </div>
          </details>

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
            <span>{brief("Bring in — linked items stay in sync, copied ones become its own")}</span>
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
                              {n > 0 && n < rels.length ? `${n} of ${rels.length} · ` : ""}
                              {(n > 0 ? entries.filter((e) => picked.has(e.rel_path)) : entries)
                                .map((e) => e.name + (e.is_dir ? "/" : "") + (n > 0 && isCopied(e) ? " (copy)" : ""))
                                .join(" · ")}
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
                              {/* version-only items: see entriesFor */}
                              {picked.has(e.rel_path) && (
                                <button
                                  className="chip"
                                  title={
                                    isCopied(e)
                                      ? "Copied once — click to link instead"
                                      : "Linked, stays in sync — click to copy instead"
                                  }
                                  onClick={(ev) => {
                                    ev.preventDefault();
                                    flipCopy(e);
                                  }}
                                >
                                  {isCopied(e) ? "copy" : "link"}
                                </button>
                              )}
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
                No standard has files yet
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

/** In the top layer, so it stays sharp above an open dialog's blurred backdrop. */
function Toast({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el?.showPopover) return; // older webviews just show it as a normal element
    // re-showing puts it above any dialog opened since
    if (el.matches(":popover-open")) el.hidePopover();
    el.showPopover();
  }, [message]);
  return (
    <div ref={ref} className="toast" popover="manual" role="status">
      {message}
    </div>
  );
}

/** The installations using a standard; + reveals the rest to link. */
function StandardLinks({
  s,
  installations,
  onEdit,
}: {
  s: Standard;
  installations: Installation[];
  onEdit: (i: Installation) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = installations.flatMap((i) => {
    const rels = entriesFor(s, i.game_version).map((e) => e.rel_path);
    const n = rels.filter((r) => s.linked[i.name]?.includes(r)).length;
    return rels.length ? [{ i, n, want: rels.length }] : [];
  });
  const linked = rows.filter((r) => r.n > 0);
  const others = rows.filter((r) => r.n === 0);
  return (
    <div className="places">
      {(open ? [...linked, ...others] : linked).map(({ i, n, want }) => (
        <PlaceChip
          key={i.name}
          className={`toggle ${n > 0 && n < want ? "partial" : ""}`}
          place={{
            key: i.name,
            label: i.name,
            inst: i,
            sub: n === 0 ? "not linked" : n < want ? `${n} of ${want} linked` : "linked",
          }}
          active={n > 0}
          title="Choose what's linked or copied…"
          onClick={() => onEdit(i)}
        />
      ))}
      {others.length > 0 && (
        <button
          className="std-link-btn"
          aria-expanded={open}
          aria-label={open ? "Hide other installations" : `Link another installation to ${s.name}`}
          title={open ? "Hide the others" : "Link another installation"}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide" : linked.length ? "+" : "+ Link an installation"}
        </button>
      )}
      {rows.length === 0 && <span className="hint">Add something above to link it.</span>}
    </div>
  );
}

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
  // the link editor, open for one standard and installation
  const [editing, setEditing] = useState<{ s: Standard; i: Installation } | null>(null);
  const [adding, setAdding] = useState<Standard | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // the file browser: a standard's name, null for all of them, undefined when closed
  const [viewing, setViewing] = useState<string | null | undefined>(undefined);
  const [removing, setRemoving] = useState<{ s: Standard; rels: string[] } | null>(null);

  async function rename(s: Standard, to: string) {
    if (renaming !== s.name) return; // Enter already handled it before the blur
    setRenaming(null);
    if (!to.trim() || to.trim() === s.name) return;
    try {
      await api.renameStandard(s.name, to.trim());
      notify(brief(`Renamed to "${to.trim()}" — linked installations follow`));
      load();
    } catch (e) {
      notify(String(e));
    }
  }

  // nothing is lost taking an unlinked item off Shared's list, so no need to ask
  function removeItems(s: Standard, rels: string[]) {
    if (s.builtin && !Object.values(s.linked).flat().some((r) => rels.includes(r)))
      api.removeFromStandard(s.name, rels, true).then(load, (e) => notify(String(e)));
    else setRemoving({ s, rels });
  }

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

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Standards</h1>
          <p className="sub">folders you link into installations</p>
        </div>
        <div className="row-inline">
          <button className="btn" onClick={() => setViewing(null)}>
            Edit All Files
          </button>
          <button className="btn" onClick={openFolder}>
            Open Folder
          </button>
        </div>
      </header>

      <p className="hint wide">
        A standard is a set of files and folders installations can share. Hover a list and press{" "}
        <b>+</b> to add to it.<span className="more"> <b>Shared</b> lives in the Minecraft folder; your own
        live in <code>minecraft/standards</code>.</span>
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
              {renaming === s.name ? (
                <input
                  className="card-rename"
                  autoFocus
                  defaultValue={s.name}
                  aria-label={`New name for ${s.name}`}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") rename(s, e.currentTarget.value);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={(e) => rename(s, e.target.value)}
                />
              ) : (
                <h2>{s.name}</h2>
              )}
              <span className="place-sub">
                {s.builtin ? "built in · the Minecraft folder" : `minecraft/standards/${s.name}`}
              </span>
            </div>
            <div className="row-inline std-actions">
              <button className="btn small" onClick={() => setViewing(s.name)}>
                Edit Files
              </button>
              <button className="btn small" onClick={() => api.revealPath(s.path, false)}>
                Open
              </button>
              {!s.builtin && (
                <button className="btn small" onClick={() => setRenaming(s.name)}>
                  Rename
                </button>
              )}
              {!s.builtin && (
                <button className="btn small danger" onClick={() => remove(s)}>
                  {armed === `del:${s.name}` ? "Sure?" : "Delete"}
                </button>
              )}
            </div>
          </div>

          <StandardSummary s={s} onRemove={removeItems} onAdd={() => setAdding(s)} onView={() => setViewing(s.name)} />

          <div className="std-label">Linked installations</div>
          <StandardLinks s={s} installations={installations} onEdit={(i) => setEditing({ s, i })} />
        </section>
      ))}

      {viewing !== undefined && (
        <StandardFiles
          standards={standards}
          installations={installations}
          initial={viewing}
          onRemove={removeItems}
          onAdd={setAdding}
          onEdit={(s, i) => setEditing({ s, i })}
          notify={notify}
          onDone={load}
          onClose={() => setViewing(undefined)}
        />
      )}
      {editing && (
        <LinkEditor
          std={editing.s}
          inst={editing.i}
          notify={notify}
          onClose={() => setEditing(null)}
          onDone={load}
        />
      )}
      {removing && (
        <RemoveFromStandard
          s={removing.s}
          rels={removing.rels}
          notify={notify}
          onClose={() => setRemoving(null)}
          onDone={load}
        />
      )}
      {adding && (
        <AddToStandard
          std={adding}
          installations={installations}
          notify={notify}
          onClose={() => setAdding(null)}
          onDone={load}
        />
      )}
    </>
  );
}

/** One pasted link, looked up as you type so you can see what it is. */
function LinkField({
  value,
  loader,
  gameVersion,
  onlyPacks,
  onChange,
  onRemove,
  onResolved,
}: {
  value: string;
  loader: Loader;
  gameVersion: string;
  onlyPacks?: boolean;
  onChange: (v: string) => void;
  onRemove?: () => void;
  onResolved?: (info: LinkInfo) => void;
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
          onResolved?.(i);
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
        onlyPacks && !["resourcepack", "collection"].includes(ok.kind) && "not a resource pack",
        ok.kind !== "collection" &&
          ok.game_versions.length > 0 &&
          !ok.game_versions.includes(gameVersion) &&
          `no ${gameVersion} version`,
        ok.kind !== "collection" &&
          ok.loaders.length > 0 &&
          !onlyPacks &&
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
          placeholder={onlyPacks ? "Paste a Modrinth resource pack link" : "Paste a Modrinth link"}
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
const purgeCache = async (installation: string | null = null) =>
  `Moved ${await api.purgeCache(installation)} cache items to Trash`;

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
  installations,
}: {
  notify: (m: string) => void;
  root: string;
  go: (v: View) => void;
  installations: Installation[];
}) {
  const [scope, setScope] = useState<string | null>(null);
  const [items, load] = useCached<FolderItem[]>(
    `folder:${scope}`,
    () => api.folderOverview(scope),
    notify
  );
  const dir = installations.find((i) => i.name === scope)?.path ?? root;
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
        <button className="btn" onClick={() => api.revealPath(dir, false)} disabled={!dir}>
          Open Folder
        </button>
      </header>

      <PlacePicker
        places={[
          { key: "", label: "Minecraft folder", kind: "root", sub: "launcher & shared files" },
          ...installations.map((i) => ({ key: i.name, label: i.name, inst: i, sub: "game folder" })),
        ]}
        value={scope ?? ""}
        onChange={(k) => setScope(k || null)}
      />

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
                    onClick={act(() => confirm(`logs:${scope}`, () => purgeLogs(scope)))}
                  >
                    {armed === `logs:${scope}` ? "Sure?" : "Purge"}
                  </button>
                </div>
              )}
              {cat === "cache" && (
                <button
                  className="btn small danger"
                  onClick={act(() => confirm(`cache:${scope}`, () => purgeCache(scope)))}
                >
                  {armed === `cache:${scope}` ? "Sure?" : "Purge"}
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
  const [standards = []] = useCached<Standard[]>("standards", api.listStandards, notify);
  const places = useMemo(
    () => instancePlaces("logs", installations, standards),
    [installations, standards]
  );
  const [picked, setPicked] = useState<string>();
  const section = places.find((p) => p.key === picked || p.members?.some((m) => m.name === picked)) ?? places[0];
  const scope = section.kind === "root" ? null : section.key;
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
        places={places}
        value={section.key}
        onChange={(k) => {
          setPicked(k);
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
