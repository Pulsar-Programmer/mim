import { useEffect, useMemo, useState } from "react";
import { api, ConfigFile, ConfigOverview, formatBytes, Installation, Mod, timeAgo } from "./api";
import { useCached } from "./hooks";
import { PlacePicker } from "./Places";

/**
 * Folders mods make right in the game folder instead of config/. `mod` is
 * matched against installed mod ids/names to show the owner's icon.
 */
const LOOSE: Record<string, { mod: string; note: string }> = {
  journeymap: {
    mod: "journeymap",
    note: "JourneyMap keeps its maps, waypoints and its own settings here — not in config/.",
  },
  xaerowaypoints: { mod: "xaerominimap", note: "Xaero's Minimap waypoints, per server and world." },
  xaero: { mod: "xaeroworldmap", note: "Xaero's World Map tiles and minimap data." },
  xaeroworldmap: { mod: "xaeroworldmap", note: "Xaero's World Map tiles." },
  voxelmap: { mod: "voxelmap", note: "VoxelMap waypoints and cached map." },
  schematics: { mod: "litematica", note: "Litematica schematics — your saved builds." },
  kubejs: { mod: "kubejs", note: "KubeJS scripts and assets — usually part of a modpack." },
  defaultconfigs: {
    mod: "",
    note: "Forge copies these into every new world's serverconfig/ — edit here to change new worlds.",
  },
  emotes: { mod: "emotecraft", note: "Emotecraft emotes." },
  replay_recordings: { mod: "replaymod", note: "Replay Mod recordings." },
  replay_videos: { mod: "replaymod", note: "Videos rendered by Replay Mod." },
  essential: { mod: "essential", note: "Essential's settings, cosmetics and friends data." },
  axiom: { mod: "axiom", note: "Axiom blueprints and settings." },
  patchouli_books: { mod: "patchouli", note: "Patchouli guide books." },
  customskinloader: { mod: "customskinloader", note: "CustomSkinLoader settings and cached skins." },
  simplebackups: { mod: "simplebackups", note: "World backups." },
  backups: { mod: "", note: "World backups, usually made by a backup mod." },
  moddata: { mod: "", note: "Data some mods share between worlds." },
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const stem = (name: string) => name.replace(/\.[^.]+$/, "");

const parses = (t: string) => {
  try {
    JSON.parse(t);
    return null;
  } catch (e) {
    return String(e).replace(/^SyntaxError: /, "");
  }
};

/** The installed mod a config entry most likely belongs to: a known owner, else the longest name match. */
function modFor(entry: string, mods: Mod[], owner = ""): Mod | undefined {
  const known = owner && mods.find((m) => norm(m.id ?? "") === norm(owner));
  if (known) return known;
  const n = norm(stem(entry));
  let best: [Mod, number] | undefined;
  for (const m of mods) {
    for (const k of [norm(m.id ?? ""), norm(m.name)]) {
      if (k.length < 3) continue;
      const hit = n.startsWith(k) || (n.length >= 4 && k.startsWith(n));
      if (hit && (!best || k.length > best[1])) best = [m, k.length];
    }
  }
  return best?.[0];
}

const EDITABLE = /\.(json5?|jsonc|toml|properties|txt|cfg|conf|ya?ml|ini|snbt|hjson)$/i;

function ModBadge({ mod, fallback }: { mod?: Mod; fallback: string }) {
  return (
    <span className="cfg-mod">
      <span
        className="cfg-icon"
        style={mod?.icon ? { backgroundImage: `url(${mod.icon})` } : undefined}
      >
        {!mod?.icon && (mod?.name ?? fallback)[0]?.toUpperCase()}
      </span>
      <span className="cfg-mod-name">{mod?.name ?? fallback}</span>
      {mod && !mod.enabled && <span className="chip">disabled</span>}
    </span>
  );
}

export function ConfigView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [picked, setScope] = useState<string | null | undefined>(undefined);
  const scope = picked === undefined ? (installations[0]?.name ?? null) : picked;
  const [overview, reload] = useCached<ConfigOverview>(
    `config:${scope}`,
    () => api.listConfig(scope),
    notify
  );
  const [mods = []] = useCached<Mod[]>(`mods:${scope}`, () => api.listMods(scope), notify);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ConfigFile | null>(null);
  useEffect(() => setOpen(null), [scope]);

  // config/ grouped by the mod each top-level entry belongs to
  const groups = useMemo(() => {
    const q = query.toLowerCase();
    const map = new Map<string, { mod?: Mod; label: string; files: ConfigFile[] }>();
    for (const f of overview?.files ?? []) {
      const top = f.rel.split("/")[0];
      const mod = modFor(top, mods);
      if (q && !f.rel.toLowerCase().includes(q) && !mod?.name.toLowerCase().includes(q)) continue;
      const key = mod?.path ?? "";
      if (!map.has(key)) map.set(key, { mod, label: mod?.name ?? "Other configs", files: [] });
      map.get(key)!.files.push(f);
    }
    // matched mods A–Z, the unmatched pile last
    return [...map.values()].sort((a, b) =>
      !a.mod ? 1 : !b.mod ? -1 : a.label.localeCompare(b.label)
    );
  }, [overview, mods, query]);

  const loose = (overview?.loose ?? []).filter(
    (l) => !query || l.name.toLowerCase().includes(query.toLowerCase())
  );
  const total = overview?.files.length ?? 0;
  const matched = groups.filter((g) => g.mod).length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Config</h1>
          <p className="sub">
            {total} config file{total === 1 ? "" : "s"}
            {matched > 0 && ` · ${matched} mod${matched === 1 ? "" : "s"}`}
            {loose.length > 0 && ` · ${loose.length} outside config/`}
          </p>
        </div>
        {overview && (
          <button className="btn" onClick={() => api.revealPath(overview.dir, false)}>
            Open Folder
          </button>
        )}
      </header>

      <p className="hint wide">
        Mods keep their settings in <code>config/</code>, and MIM matches each file to the mod it
        came from where it can — names don't always line up, so some land in "Other". A few mods
        skip <code>config/</code> and make their own folder in the game folder instead, like{" "}
        <code>journeymap/</code>; those are listed at the bottom.
      </p>

      <PlacePicker
        places={[
          ...installations.map((i) => ({
            key: i.name,
            label: i.name,
            inst: i,
            sub: `${i.mods_count} mod${i.mods_count === 1 ? "" : "s"}`,
          })),
          { key: "", label: "Minecraft folder", kind: "root" as const, sub: "main config/" },
        ]}
        value={scope ?? ""}
        onChange={(k) => setScope(k || null)}
      />

      <div className="config-layout">
        <section className="config-list">
          <div className="options-toolbar">
            <input
              className="search"
              placeholder="Search configs or mods…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {groups.map((g) => (
            <div key={g.label} className="cfg-group">
              <div className="cfg-head">
                {g.mod ? (
                  <ModBadge mod={g.mod} fallback={g.label} />
                ) : (
                  <span className="cfg-mod">
                    <span className="cfg-icon other">?</span>
                    <span className="cfg-mod-name">Other configs</span>
                    <span className="hint">no matching mod — a library, or a leftover</span>
                  </span>
                )}
                <span className="count">{g.files.length}</span>
              </div>
              <ul className="cfg-files">
                {g.files.map((f) => (
                  <li key={f.path}>
                    <button
                      className={`cfg-file ${open?.path === f.path ? "active" : ""}`}
                      onClick={() => setOpen(f)}
                      title={f.rel}
                    >
                      <span className="cfg-rel">{f.rel}</span>
                      <span className="cfg-size">{formatBytes(f.size_bytes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {overview && total === 0 && (
            <div className="empty">No config/ folder here yet — mods make one the first time the game runs.</div>
          )}

          {loose.length > 0 && (
            <>
              <h3 className="pack-heading">Outside config/</h3>
              <ul className="cfg-loose">
                {loose.map((l) => {
                  const known = LOOSE[norm(l.name)] ?? LOOSE[l.name.toLowerCase()];
                  const mod = modFor(l.name, mods, known?.mod);
                  return (
                    <li key={l.path}>
                      <ModBadge mod={mod} fallback={l.name} />
                      <code className="cfg-rel">
                        {l.name}
                        {l.is_dir ? "/" : ""}
                      </code>
                      <p className="hint">
                        {known?.note ??
                          (mod
                            ? `Made by ${mod.name}.`
                            : "Not something Minecraft makes — probably a mod's.")}
                      </p>
                      <span className="cfg-size">{formatBytes(l.size_bytes)}</span>
                      <button className="linklike" onClick={() => api.revealPath(l.path)}>
                        reveal
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <section className="config-editor">
          {open ? (
            <ConfigEditor
              key={open.path}
              file={open}
              mod={modFor(open.rel.split("/")[0], mods)}
              notify={notify}
              onSaved={reload}
            />
          ) : (
            <div className="empty">Pick a config file to read or edit it.</div>
          )}
        </section>
      </div>
    </>
  );
}

function ConfigEditor({
  file,
  mod,
  notify,
  onSaved,
}: {
  file: ConfigFile;
  mod?: Mod;
  notify: (m: string) => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const editable = EDITABLE.test(file.rel);

  useEffect(() => {
    if (!editable) return;
    api
      .readConfig(file.path)
      .then((t) => {
        setText(t);
        setDraft(t);
      })
      .catch((e) => setError(String(e)));
  }, [file.path, editable]);

  const dirty = text !== null && draft !== text;
  // .json that parsed when opened must still parse; some mods write comments
  // into .json (and json5/jsonc allow them), so those are left alone
  const jsonError = useMemo(
    () => (/\.json$/i.test(file.rel) && dirty && !parses(text) ? parses(draft) : null),
    [draft, dirty, text, file.rel]
  );

  async function save() {
    try {
      await api.writeConfig(file.path, draft);
      setText(draft);
      notify(`Saved ${file.rel}`);
      onSaved();
    } catch (e) {
      notify(String(e));
    }
  }

  return (
    <div className="cfg-editor">
      <div className="cfg-editor-head">
        <div>
          <div className="mod-name">{file.rel.split("/").pop()}</div>
          <div className="mod-meta">
            {mod && <span>{mod.name}</span>}
            <span className="mod-file">config/{file.rel}</span>
            <span>{formatBytes(file.size_bytes)}</span>
            <span>changed {timeAgo(new Date(file.modified * 1000).toISOString())}</span>
          </div>
        </div>
        <button className="linklike" onClick={() => api.revealPath(file.path)}>
          reveal
        </button>
      </div>
      {!editable ? (
        <div className="empty">Not a text file — reveal it to open it elsewhere.</div>
      ) : error ? (
        <div className="empty">{error}</div>
      ) : text === null ? null : (
        <>
          <textarea
            className="cfg-text"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                if (dirty && !jsonError) save();
              }
            }}
          />
          {dirty && (
            <div className="save-bar">
              <span>Unsaved changes</span>
              {jsonError ? (
                <span className="hint bad">Not valid JSON: {jsonError}</span>
              ) : (
                <span className="hint">close Minecraft first or the mod may overwrite them · ⌘S</span>
              )}
              <button className="linklike" onClick={() => setDraft(text)}>
                revert
              </button>
              <button className="btn primary" onClick={save} disabled={!!jsonError}>
                Save
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
