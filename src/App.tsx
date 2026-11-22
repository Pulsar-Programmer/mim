import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "./api";
import "./App.css";

type View = "installations" | "new" | "standards" | "packs";

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

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
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
          {(
            [
              ["installations", "Installations"],
              ["new", "New Install"],
              ["standards", "Standards"],
              ["packs", "Resource Packs"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              className={`nav-item ${view === v ? "active" : ""}`}
              onClick={() => setView(v)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="btn ghost" onClick={() => api.openLauncher()}>
            Open Launcher ↗
          </button>
        </div>
      </aside>

      <main className="content">
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
  const [versions, setVersions] = useState<GameVersion[]>([]);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [gameVersion, setGameVersion] = useState("");
  const [fabric, setFabric] = useState(true);
  const [loaders, setLoaders] = useState<LoaderVersion[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [standards, setStandards] = useState<Standards | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .listGameVersions()
      .then((v) => {
        setVersions(v);
        const latest = v.find((x) => x.type === "release");
        if (latest) setGameVersion(latest.id);
      })
      .catch((e) => notify(String(e)));
    api.listStandards().then(setStandards).catch(() => {});
  }, [notify]);

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
  const [standards, setStandards] = useState<Standards | null>(null);

  const load = useCallback(() => {
    api.listStandards().then(setStandards).catch((e) => notify(String(e)));
  }, [notify]);
  useEffect(load, [load]);

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
  const [packs, setPacks] = useState<PacksOverview | null>(null);

  useEffect(() => {
    api.listResourcepacks().then(setPacks).catch((e) => notify(String(e)));
  }, [notify]);

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

export default App;
