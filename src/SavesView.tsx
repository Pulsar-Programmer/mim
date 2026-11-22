import { useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, formatBytes, timeAgo, World, WorldDetails } from "./api";
import { useCached, useConfirm } from "./hooks";

const MODES = ["Survival", "Creative", "Adventure", "Spectator"];

function modeLabel(w: World): string {
  if (w.hardcore) return "Hardcore";
  return w.game_mode == null ? "Unknown" : (MODES[w.game_mode] ?? "Unknown");
}

const PART_NOTES: Record<string, string> = {
  region: "Overworld terrain",
  "DIM-1": "The Nether",
  DIM1: "The End",
  entities: "Mobs & item frames",
  poi: "Villager points of interest",
  playerdata: "Player inventories",
  advancements: "Advancement progress",
  stats: "Statistics",
  datapacks: "Data packs",
  data: "Maps, raids, scoreboards",
  "level.dat": "World settings",
  "level.dat_old": "Previous settings backup",
  "icon.png": "World icon",
  "session.lock": "Open-world lock",
};

export function SavesView({ notify }: { notify: (m: string) => void }) {
  const [worlds = [], reload] = useCached<World[]>("saves", api.listSaves, notify);
  const [location, setLocation] = useState("all");
  const [open, setOpen] = useState<World | null>(null);

  const locations = useMemo(() => [...new Set(worlds.map((w) => w.location))], [worlds]);
  const shown = worlds.filter((w) => location === "all" || w.location === location);
  const total = worlds.reduce((n, w) => n + w.size_bytes, 0);
  // imports land in the location being viewed ("all" → shared saves)
  const target = location === "all" ? "Shared" : location;

  async function importWorld(kind: "folder" | "zip") {
    const src = await openDialog({
      title: `Import a world into ${target}`,
      directory: kind === "folder",
      multiple: false,
      filters: kind === "zip" ? [{ name: "World zip", extensions: ["zip"] }] : undefined,
    });
    if (typeof src !== "string") return;
    try {
      const name = await api.importWorld(src, target === "Shared" ? null : target);
      notify(`Imported “${name}” into ${target}`);
      reload();
    } catch (e) {
      notify(String(e));
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Saves</h1>
          <p className="sub">
            {worlds.length} world{worlds.length === 1 ? "" : "s"} · {formatBytes(total)}
          </p>
        </div>
        <div className="row-inline">
          <button className="btn" onClick={() => importWorld("zip")}>
            Import .zip…
          </button>
          <button className="btn primary" onClick={() => importWorld("folder")}>
            + Import World
          </button>
        </div>
      </header>

      <p className="hint wide">
        <b>Shared</b> worlds live in <code>minecraft/saves</code> and show up in every
        linked installation. Installations that aren't linked keep their own saves.
      </p>

      {locations.length > 1 && (
        <div className="segmented kinds">
          {["all", ...locations].map((l) => (
            <button
              key={l}
              className={location === l ? "active" : ""}
              onClick={() => setLocation(l)}
            >
              {l}{" "}
              <span className="count">
                {l === "all" ? worlds.length : worlds.filter((w) => w.location === l).length}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="grid worlds">
        {shown.map((w) => (
          <button className="card world-card" key={w.path} onClick={() => setOpen(w)}>
            <div
              className="world-icon"
              style={w.icon ? { backgroundImage: `url(${w.icon})` } : undefined}
            >
              {!w.icon && <span>{w.name[0]}</span>}
            </div>
            <div className="card-body">
              <div className="card-name" title={w.name}>
                {w.name}
              </div>
              <div className="card-meta">
                {w.version && <code>{w.version}</code>}
                <span className={`chip mode-${modeLabel(w).toLowerCase()}`}>{modeLabel(w)}</span>
              </div>
              <div className="card-meta">
                <span>
                  {w.last_played ? timeAgo(new Date(w.last_played).toISOString()) : "never played"}
                </span>
                <span>{formatBytes(w.size_bytes)}</span>
              </div>
              {w.location !== "Shared" && <div className="world-loc">{w.location}</div>}
            </div>
          </button>
        ))}
        {worlds.length === 0 && <div className="empty">No worlds yet.</div>}
      </div>

      {open && (
        <WorldDrawer
          world={open}
          notify={notify}
          onClose={() => setOpen(null)}
          onDeleted={() => {
            setOpen(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function WorldDrawer({
  world: w,
  notify,
  onClose,
  onDeleted,
}: {
  world: World;
  notify: (m: string) => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { armed, confirm } = useConfirm(notify, onDeleted);

  async function backup() {
    const day = new Date().toISOString().slice(0, 10);
    const dest = await saveDialog({
      title: `Back up ${w.name}`,
      defaultPath: `${w.folder} ${day}.zip`,
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (!dest) return;
    notify("Zipping…");
    try {
      await api.backupWorld(w.path, dest);
      notify(`Backed up ${w.name}`);
    } catch (e) {
      notify(String(e));
    }
  }

  const [details] = useCached<WorldDetails>(
    `world:${w.path}`,
    () => api.worldDetails(w.path),
    notify
  );
  const biggest = details?.parts[0]?.size_bytes || 1;

  return (
    <div className="viewer-backdrop drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-hero">
          <div
            className="world-icon big"
            style={w.icon ? { backgroundImage: `url(${w.icon})` } : undefined}
          >
            {!w.icon && <span>{w.name[0]}</span>}
          </div>
          <div>
            <h2 className="drawer-title">{w.name}</h2>
            <code>{w.folder}</code>
          </div>
          <button className="linklike drawer-close" onClick={onClose}>
            close
          </button>
        </div>

        <dl className="facts">
          <dt>Mode</dt>
          <dd>
            <span className={`chip mode-${modeLabel(w).toLowerCase()}`}>{modeLabel(w)}</span>
            {w.cheats && <span className="chip">cheats on</span>}
          </dd>
          <dt>Version</dt>
          <dd>{w.version ?? "unknown"}</dd>
          <dt>Last played</dt>
          <dd>
            {w.last_played
              ? new Date(w.last_played).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "never"}
          </dd>
          <dt>Seed</dt>
          <dd>
            {w.seed ? (
              <button
                className="seed"
                title="Copy seed"
                onClick={() =>
                  navigator.clipboard.writeText(w.seed!).then(() => notify("Seed copied"))
                }
              >
                {w.seed}
              </button>
            ) : (
              "unknown"
            )}
          </dd>
          <dt>Lives in</dt>
          <dd>{w.location === "Shared" ? "Shared saves (all linked installations)" : w.location}</dd>
          <dt>Players</dt>
          <dd>{details ? details.players : "…"}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(w.size_bytes)}</dd>
        </dl>

        <h3 className="drawer-h">What's inside</h3>
        <ul className="parts">
          {details?.parts.map((p) => (
            <li key={p.name}>
              <div className="part-row">
                <span className="part-name">
                  {p.name}
                  {p.is_dir ? "/" : ""}
                </span>
                <span className="part-note">{PART_NOTES[p.name] ?? ""}</span>
                <span className="pack-size">{formatBytes(p.size_bytes)}</span>
              </div>
              <div className="part-bar">
                <span style={{ width: `${(p.size_bytes / biggest) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>

        {details && details.datapacks.length > 0 && (
          <>
            <h3 className="drawer-h">Data packs</h3>
            <ul className="pack-list">
              {details.datapacks.map((d) => (
                <li key={d}>
                  <span className="pack-name">{d}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="drawer-actions">
          <button className="btn" onClick={() => api.revealPath(w.path, false)}>
            Open in Finder
          </button>
          <button className="btn" onClick={backup}>
            Back up as .zip…
          </button>
          <button
            className="btn danger"
            onClick={() =>
              confirm("delete", async () => {
                await api.trashItem(w.path);
                return `Moved ${w.name} to Trash`;
              })
            }
          >
            {armed === "delete" ? "Sure?" : "Delete"}
          </button>
        </div>
      </aside>
    </div>
  );
}
