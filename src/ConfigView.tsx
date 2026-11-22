import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ConfigFile,
  ConfigOverview,
  formatBytes,
  Installation,
  Mod,
  Standard,
  timeAgo,
} from "./api";
import { brief } from "./settings";
import { useCached } from "./hooks";
import { PlacePicker, StandardAvatar } from "./Places";

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

const LINK = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
    <path
      d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

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
  const [standards = [], reloadStandards] = useCached<Standard[]>(
    "standards",
    api.listStandards,
    notify
  );
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ConfigFile | null>(null);
  // the Share dialog: a mod's files, with the ones to share ticked
  const [sharing, setSharing] = useState<{ mod?: Mod; files: ConfigFile[]; picked: string[] } | null>(
    null
  );
  useEffect(() => {
    setOpen(null);
    setSharing(null);
  }, [scope]);
  const groupOf = (f: ConfigFile) => groups.find((g) => g.files.some((x) => x.path === f.path));
  const shareFile = (f: ConfigFile) =>
    setSharing({ mod: groupOf(f)?.mod, files: groupOf(f)?.files ?? [f], picked: [f.rel] });

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

      <p className="hint wide more">
        Mods keep their settings in <code>config/</code>, and MIM matches each file to the mod it
        came from where it can — names don't always line up, so some land in "Other".{" "}
        <b>Share</b> moves a mod's config into a standard and links it back, so every installation
        linked to that standard uses the same settings. A few mods
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

          {groups.map((g) => {
            const free = g.files.filter((f) => !f.linked);
            const linked = [...new Set(g.files.flatMap((f) => (f.linked ? [f.linked] : [])))];
            return (
              <div key={g.label} className="cfg-group">
                <div className="cfg-head">
                  {g.mod ? (
                    <ModBadge mod={g.mod} fallback={g.label} />
                  ) : (
                    <span className="cfg-mod">
                      <span className="cfg-icon other">?</span>
                      <span className="cfg-mod-name">Other configs</span>
                      <span className="hint">{brief("no matching mod — a library, or a leftover")}</span>
                    </span>
                  )}
                  <span className="cfg-head-end">
                    {linked.map((s) => (
                      <span key={s} className="chip" title={`linked from the "${s}" standard`}>
                        ↔ {s}
                      </span>
                    ))}
                    {scope && free.length > 0 && (
                      <button
                        className="cfg-share-btn"
                        onClick={() =>
                          setSharing({
                            mod: g.mod,
                            files: g.files,
                            picked: g.mod ? free.map((f) => f.rel) : [],
                          })
                        }
                      >
                        {LINK} Share
                      </button>
                    )}
                    <span className="count">{g.files.length}</span>
                  </span>
                </div>
                <ul className="cfg-files">
                  {g.files.map((f) => (
                    <li key={f.path} className="cfg-row">
                      <button
                        className={`cfg-file ${open?.path === f.path ? "active" : ""}`}
                        onClick={() => setOpen(f)}
                        title={f.rel}
                      >
                        <span className="cfg-rel">{f.rel}</span>
                        {f.linked && (
                          <span className="chip cfg-linked" title={`linked from the "${f.linked}" standard`}>
                            {LINK} {f.linked}
                          </span>
                        )}
                        <span className="cfg-size">{formatBytes(f.size_bytes)}</span>
                      </button>
                      {scope && !f.linked && (
                        <button
                          className="cfg-row-share"
                          title="Share this file through a standard"
                          onClick={() => shareFile(f)}
                        >
                          {LINK}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {overview && total === 0 && (
            <div className="empty">{brief("No config/ folder here yet — mods make one the first time the game runs.")}</div>
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
                        {brief(
                          known?.note ??
                            (mod ? `Made by ${mod.name}.` : "Not something Minecraft makes — probably a mod's.")
                        )}
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
              onShare={scope && !open.linked ? () => shareFile(open) : undefined}
            />
          ) : (
            <div className="empty">Pick a config file to read or edit it.</div>
          )}
        </section>
      </div>

      {sharing && scope && (
        <ShareDialog
          installation={scope}
          {...sharing}
          standards={standards.filter((s) => !s.builtin)}
          notify={notify}
          onClose={() => setSharing(null)}
          onDone={() => {
            setSharing(null);
            setOpen(null);
            reload();
            reloadStandards();
          }}
        />
      )}
    </>
  );
}

function ConfigEditor({
  file,
  mod,
  notify,
  onSaved,
  onShare,
}: {
  file: ConfigFile;
  mod?: Mod;
  notify: (m: string) => void;
  onSaved: () => void;
  onShare?: () => void;
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
            {file.linked && (
              <span className="cfg-linked-note">
                {LINK} from "{file.linked}" · edits reach every installation linked to it
              </span>
            )}
          </div>
        </div>
        <span className="row-inline">
          {onShare && (
            <button className="cfg-share-btn" onClick={onShare}>
              {LINK} Share
            </button>
          )}
          <button className="linklike" onClick={() => api.revealPath(file.path)}>
            reveal
          </button>
        </span>
      </div>
      {!editable ? (
        <div className="empty">{brief("Not a text file — reveal it to open it elsewhere.")}</div>
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

/**
 * Pick files and a standard: the files move into the standard and are linked
 * back, so every installation linked to that standard uses the same copy.
 */
function ShareDialog({
  installation,
  mod,
  files,
  picked: initial,
  standards,
  notify,
  onClose,
  onDone,
}: {
  installation: string;
  mod?: Mod;
  files: ConfigFile[];
  picked: string[];
  standards: Standard[];
  notify: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const [picked, setPicked] = useState(new Set(initial));
  const [std, setStd] = useState<string | null>(standards[0]?.name ?? null);
  // a standard typed in here, made when Share is clicked
  const [fresh, setFresh] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(standards.length ? null : "");
  const [busy, setBusy] = useState(false);
  const free = files.filter((f) => !f.linked);
  const rels = [...picked];
  const chosen = standards.find((s) => s.name === std);
  // files the standard already has: its copy wins
  const inWay = rels.filter((r) =>
    chosen?.entries.some((e) => e.scope === "global" && e.name === `config/${r}`)
  );

  function commitName() {
    const n = naming?.trim();
    setNaming(null);
    if (!n) return;
    if (!standards.some((s) => s.name === n)) setFresh(n);
    setStd(n);
  }

  async function share() {
    if (!std || !rels.length) return;
    setBusy(true);
    try {
      if (!chosen) await api.createStandard(std);
      const blocked = await api.shareConfig(installation, std, rels, inWay.length > 0);
      if (blocked.length && !inWay.length) {
        notify(`"${std}" already has ${blocked.join(", ")} — pick again to use its copy`);
        return onDone();
      }
      notify(
        `Shared ${rels.length === 1 ? rels[0] : `${rels.length} files`} through "${std}"` +
          (inWay.length ? ` · ${installation}'s own ${inWay.length === 1 ? "copy" : "copies"} moved to Trash` : "")
      );
      onDone();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }

  const card = (s: Standard, sub: string) => (
    <button
      key={s.name}
      className={`place ${std === s.name ? "active" : ""}`}
      onClick={() => setStd(s.name)}
    >
      <StandardAvatar s={s} />
      <span className="place-text">
        <span className="place-label">{s.name}</span>
        <span className="place-sub">{sub}</span>
      </span>
    </button>
  );
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  return (
    <dialog
      ref={ref}
      className="share-dialog"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}
    >
      <div className="share-body">
        <header className="share-head">
          <span
            className="cfg-icon big"
            style={mod?.icon ? { backgroundImage: `url(${mod.icon})` } : undefined}
          >
            {!mod?.icon && LINK}
          </span>
          <div>
            <h2>Share {mod ? `${mod.name} settings` : "configs"}</h2>
            <p className="hint">
              Installations linked to a standard all use one copy
              <span className="more"> — change it in one, it changes in all of them. Their other configs stay
              their own.</span>
            </p>
          </div>
        </header>

        <div className="share-label">
          Files
          {free.length > 1 && (
            <button
              className="linklike"
              onClick={() =>
                setPicked(new Set(picked.size === free.length ? [] : free.map((f) => f.rel)))
              }
            >
              {picked.size === free.length ? "none" : "all"}
            </button>
          )}
        </div>
        <div className="share-files">
          {files.map((f) => (
            <label
              key={f.path}
              className={`share-file ${picked.has(f.rel) ? "on" : ""} ${f.linked ? "done" : ""}`}
            >
              <input
                type="checkbox"
                disabled={!!f.linked}
                checked={picked.has(f.rel) || !!f.linked}
                onChange={() => {
                  const next = new Set(picked);
                  next.has(f.rel) ? next.delete(f.rel) : next.add(f.rel);
                  setPicked(next);
                }}
              />
              <span className="share-rel">{f.rel}</span>
              {f.linked ? (
                <span className="chip cfg-linked">
                  {LINK} {f.linked}
                </span>
              ) : (
                <span className="cfg-size">{formatBytes(f.size_bytes)}</span>
              )}
            </label>
          ))}
        </div>

        <div className="share-label">Standard</div>
        <div className="places share-stds">
          {standards.map((s) =>
            card(
              s,
              s.installations.length
                ? `${plural(s.installations.length, "installation")}`
                : "not linked yet"
            )
          )}
          {fresh && card({ name: fresh, path: "", builtin: false, installations: [], live: {}, entries: [], images: [] }, "new")}
          {naming === null ? (
            <button className="place toggle share-new" onClick={() => setNaming("")}>
              <span className="ava">+</span>
              <span className="place-label">New standard</span>
            </button>
          ) : (
            <span className="place active share-new">
              <span className="ava">+</span>
              <input
                className="share-name"
                autoFocus
                placeholder="Name it, e.g. PvP"
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName();
                  if (e.key === "Escape") {
                    e.preventDefault(); // keep the dialog open
                    setNaming(null);
                  }
                }}
              />
            </span>
          )}
        </div>

        {inWay.length > 0 && (
          <p className="share-note">
            "{std}" already has {inWay.map((r) => <code key={r}>{r}</code>)}. Its copy will be used
            here, and {installation}'s own goes to the Trash.
          </p>
        )}

        <footer className="share-foot">
          <button className="btn" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button className="btn primary" onClick={share} disabled={!std || !rels.length || busy}>
            {!rels.length
              ? "Pick a file"
              : !std
                ? "Pick a standard"
                : inWay.length === rels.length
                  ? `Use ${std}'s copy`
                  : `Share ${plural(rels.length, "file")} to ${std}`}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
