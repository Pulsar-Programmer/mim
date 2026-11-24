import { useEffect, useMemo, useState } from "react";
import { api, Installation, OptionEntry, OptionsSource, Standard } from "./api";
import { sameValue } from "./compare";
import { instancePlaces, PlacePicker, stdScope } from "./Places";
import { useCached } from "./hooks";
import { ResolveDialog, ResolveDraft } from "./Resolve";

// ---- grouping & labels ----------------------------------------------------

const VIDEO = new Set(
  (
    "graphicsMode renderDistance simulationDistance maxFps enableVsync fullscreen fov gamma " +
    "guiScale entityShadows particles mipmapLevels biomeBlendRadius renderClouds ao bobView " +
    "entityDistanceScaling fovEffectScale screenEffectScale prioritizeChunkUpdates " +
    "attackIndicator fullscreenResolution menuBackgroundBlurriness darknessEffectScale " +
    "glintSpeed glintStrength damageTiltStrength cloudRange inactivityFpsLimit " +
    "textureFiltering vignette showAutosaveIndicator chunkSectionFadeInTime improvedTransparency"
  ).split(" ")
);
const CONTROLS = new Set(
  (
    "mouseSensitivity invertYMouse invertXMouse mouseWheelSensitivity discrete_mouse_scroll " +
    "rawMouseInput touchscreen autoJump toggleCrouch toggleSprint operatorItemsTab"
  ).split(" ")
);
const ACCESS = new Set(
  (
    "narrator highContrast darkMojangStudiosBackground hideLightningFlashes " +
    "panoramaScrollSpeed notificationDisplayTime textBackgroundOpacity " +
    "backgroundForChatOnly showSubtitles directionalAudio hideSplashTexts " +
    "highContrastBlockOutline rotateWithMinecart"
  ).split(" ")
);

const GROUPS = [
  "Video",
  "Sound",
  "Controls",
  "Key binds",
  "Chat",
  "Skin",
  "Accessibility",
  "Packs",
  "General",
] as const;
type Group = (typeof GROUPS)[number];

function groupOf(key: string): Group {
  if (key.startsWith("key_")) return "Key binds";
  if (key.startsWith("soundCategory_") || key === "soundDevice") return "Sound";
  if (key.startsWith("modelPart_") || key === "mainHand") return "Skin";
  if (key.startsWith("chat") || key === "reducedDebugInfo" || key === "onlyShowSecureChat")
    return "Chat";
  if (key.toLowerCase().includes("resourcepacks")) return "Packs";
  if (VIDEO.has(key)) return "Video";
  if (CONTROLS.has(key)) return "Controls";
  if (ACCESS.has(key)) return "Accessibility";
  return "General";
}

function words(s: string): string {
  const w = s
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function labelOf(key: string): string {
  if (key.startsWith("key_key.")) return words(key.slice(8));
  if (key.startsWith("key_")) return words(key.slice(4));
  if (key.startsWith("soundCategory_")) return words(key.slice(14));
  if (key.startsWith("modelPart_")) return words(key.slice(10));
  return words(key);
}

// ---- key binds ------------------------------------------------------------

const SPECIAL_KEYS: Record<string, string> = {
  Space: "space",
  Tab: "tab",
  Enter: "enter",
  Backquote: "grave.accent",
  Minus: "minus",
  Equal: "equal",
  BracketLeft: "left.bracket",
  BracketRight: "right.bracket",
  Backslash: "backslash",
  Semicolon: "semicolon",
  Quote: "apostrophe",
  Comma: "comma",
  Period: "period",
  Slash: "slash",
  CapsLock: "caps.lock",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "page.up",
  PageDown: "page.down",
};
const MODIFIERS: Record<string, string> = {
  Shift: "shift",
  Control: "control",
  Alt: "alt",
  Meta: "win",
};

/** Browser KeyboardEvent.code → Minecraft key name. */
function codeToMc(code: string): string {
  const k = "key.keyboard.";
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return k + m[1].toLowerCase();
  if ((m = code.match(/^Digit(\d)$/))) return k + m[1];
  if ((m = code.match(/^F(\d+)$/))) return k + "f" + m[1];
  if ((m = code.match(/^Numpad(\d)$/))) return k + "keypad." + m[1];
  if ((m = code.match(/^(Shift|Control|Alt|Meta)(Left|Right)$/)))
    return k + m[2].toLowerCase() + "." + MODIFIERS[m[1]];
  if ((m = code.match(/^Arrow(\w+)$/))) return k + m[1].toLowerCase();
  return k + (SPECIAL_KEYS[code] ?? "unknown");
}

const MOUSE = ["key.mouse.left", "key.mouse.middle", "key.mouse.right", "key.mouse.4", "key.mouse.5"];

function keyLabel(v: string): string {
  if (v === "key.keyboard.unknown") return "Not bound";
  if (v.startsWith("key.mouse.")) return "Mouse " + words(v.slice(10));
  if (v.startsWith("key.keyboard.")) {
    const k = v.slice(13);
    return k.length === 1 ? k.toUpperCase() : words(k);
  }
  return v;
}

function KeyBind({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code !== "Escape")
        onChange(
          e.code === "Backspace" || e.code === "Delete" ? "key.keyboard.unknown" : codeToMc(e.code)
        );
      setListening(false);
    };
    const mouse = (e: MouseEvent) => {
      e.preventDefault();
      if (MOUSE[e.button]) onChange(MOUSE[e.button]);
      setListening(false);
    };
    const menu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", mouse, true);
    window.addEventListener("contextmenu", menu, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", mouse, true);
      window.removeEventListener("contextmenu", menu, true);
    };
  }, [listening, onChange]);

  return (
    <button
      className={`keycap ${listening ? "listening" : ""} ${value === "key.keyboard.unknown" ? "unbound" : ""}`}
      onClick={() => setListening(true)}
      title="Click, then press a key or mouse button · ⌫ unbinds · Esc cancels"
    >
      {listening ? "press a key…" : keyLabel(value)}
    </button>
  );
}

// ---- value editors --------------------------------------------------------

/** options.txt writes floats with a decimal point: 1 -> "1.0" */
const float = (n: number) => {
  const t = String(+n.toFixed(3));
  return /^-?\d+$/.test(t) ? t + ".0" : t;
};

function Slider({ value, min, label, onChange }: { value: string; min: number; label: string; onChange: (v: string) => void }) {
  return (
    <span className="slider">
      <input
        type="range"
        min={min}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(float(+e.target.value))}
      />
      <span className="slider-val">{label}</span>
    </span>
  );
}

function Editor({ k, value, onChange }: { k: string; value: string; onChange: (v: string) => void }) {
  if (k.startsWith("key_")) return <KeyBind value={value} onChange={onChange} />;
  if (value === "true" || value === "false")
    return (
      <button
        className={`switch ${value === "true" ? "on" : ""}`}
        role="switch"
        aria-checked={value === "true"}
        onClick={() => onChange(value === "true" ? "false" : "true")}
      >
        <span />
      </button>
    );
  // fov is stored from -1 to 1 around 70°
  if (k === "fov" && /^-?\d*\.?\d+$/.test(value))
    return <Slider value={value} min={-1} label={`${Math.round(70 + +value * 40)}°`} onChange={onChange} />;
  if (/^-?\d*\.\d+$/.test(value) && +value >= 0 && +value <= 1)
    return <Slider value={value} min={0} label={`${Math.round(+value * 100)}%`} onChange={onChange} />;
  if (/^-?\d+(\.\d+)?$/.test(value))
    return (
      <input
        className="num"
        type="number"
        value={value}
        step={value.includes(".") ? 0.1 : 1}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return <input className="text" value={value} onChange={(e) => onChange(e.target.value)} />;
}

const nameOf = (s: OptionsSource) => (s.kind === "base" ? "Shared" : s.label);
export const show = (k: string, v: string | undefined) =>
  v === undefined ? "not set" : k.startsWith("key_") ? keyLabel(v) : v;

// ---- view -----------------------------------------------------------------

export function OptionsView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [sources = [], reloadSources] = useCached<OptionsSource[]>(
    "options-sources",
    api.optionsSources,
    notify
  );
  const [standards = [], reloadStandards] = useCached<Standard[]>("standards", api.listStandards, notify);
  const places = useMemo(
    () => instancePlaces("options.txt", installations, standards),
    [installations, standards]
  );
  const [selected, setSelected] = useState<string>();
  const section = places.find((p) => p.key === selected || p.members?.some((m) => m.name === selected)) ?? places[0];
  const keyOf = (s: OptionsSource) => (s.kind === "base" ? "" : s.kind === "standard" ? stdScope(s.label) : s.label);
  const source = sources.find((s) => keyOf(s) === section.key);
  const sharers = section.members ?? [];
  // what to compare against: picked, or the Minecraft folder for an installation
  const [comparePick, setComparePick] = useState<string | null>(null);
  const other =
    comparePick === ""
      ? undefined
      : (sources.find((s) => s.path === comparePick && s.path !== source?.path) ??
        (source?.kind === "base" ? undefined : sources.find((s) => s.kind === "base" && s.exists)));
  const sameFile = !!other && other.target === source?.target;

  const [entries, reload] = useCached<OptionEntry[]>(
    `options:${source?.path}`,
    () => (source ? api.readOptions(source.path) : Promise.resolve([])),
    notify
  );
  const [otherEntries, reloadOther] = useCached<OptionEntry[]>(
    `options:${other?.path}`,
    () => (other ? api.readOptions(other.path) : Promise.resolve([])),
    notify
  );

  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [query, setQuery] = useState("");
  const [diffOnly, setDiffOnly] = useState(false);
  const [resolving, setResolving] = useState(false);
  // resolved but unsaved; the Save bar writes it, and switching place drops it
  const [draft, setDraft] = useState<ResolveDraft | null>(null);
  useEffect(() => {
    setEdits(new Map());
    setDraft(null);
  }, [source?.path]);

  const mine = useMemo(() => new Map(entries ?? []), [entries]);
  const theirs = useMemo(() => new Map(other ? (otherEntries ?? []) : []), [other, otherEntries]);
  const comparing = !!other && !sameFile;

  // every key either side has; ones only theirs can be added here
  const keys = useMemo(() => {
    const ks = [...mine.keys()];
    if (comparing) for (const k of theirs.keys()) if (!mine.has(k)) ks.push(k);
    return ks.filter((k) => k !== "version");
  }, [mine, theirs, comparing]);
  const differs = (k: string) => comparing && !sameValue(theirs.get(k), mine.get(k));
  const diffKeys = useMemo(() => keys.filter(differs), [keys, mine, theirs, comparing]); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const q = query.toLowerCase();
    const map = new Map<Group, string[]>();
    for (const k of diffOnly && comparing ? diffKeys : keys) {
      if (q && !k.toLowerCase().includes(q) && !labelOf(k).toLowerCase().includes(q)) continue;
      const g = groupOf(k);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(k);
    }
    return GROUPS.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [keys, diffKeys, query, diffOnly, comparing]);

  const set = (k: string) => (v: string) =>
    setEdits((prev) => {
      const next = new Map(prev);
      v === mine.get(k) ? next.delete(k) : next.set(k, v);
      return next;
    });

  /** stage every one of theirs that differs; nothing is saved yet */
  function takeAll() {
    const next = new Map(edits);
    for (const k of diffKeys) {
      const v = theirs.get(k);
      if (v !== undefined) next.set(k, v);
    }
    setEdits(next);
  }

  async function save() {
    if (!source || !entries) return;
    try {
      if (draft) {
        await api.writeMerged(draft);
        notify(`Saved ${draft.changes} resolved change${draft.changes === 1 ? "" : "s"} · old version in Trash`);
        setDraft(null);
        reload();
        reloadOther();
        return;
      }
      const added = [...edits].filter(([k]) => !mine.has(k));
      await api.writeOptions(source.path, [...entries.map(([k, v]) => [k, edits.get(k) ?? v] as OptionEntry), ...added]);
      notify(`Saved ${edits.size} change${edits.size === 1 ? "" : "s"} · backup at options.txt.bak`);
      setEdits(new Map());
      reload();
      if (sameFile) reloadOther();
    } catch (e) {
      notify(String(e));
    }
  }

  // a missing options.txt starts from the compared one, or the Minecraft folder's
  const seed = other && theirs.size ? other : sources.find((s) => s.kind === "base" && s.exists);
  async function copyFrom() {
    if (!source || !seed) return;
    try {
      await api.writeOptions(source.path, await api.readOptions(seed.path));
      notify(`Copied ${nameOf(seed)} options into ${source.label}`);
      reloadSources();
      reloadStandards();
      reload();
    } catch (e) {
      notify(String(e));
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Options</h1>
          <p className="sub">options.txt, per game folder</p>
        </div>
      </header>

      <p className="hint wide">
        Edit a standard's <code>options.txt</code> once for everything using it. Installations appear
        only when they keep their own.
        <span className="more">
          {" "}
          Pick another under{" "}
          <b>Compare with</b> to see what differs and take its values</span>.
      </p>

      <PlacePicker places={places} value={section.key} onChange={setSelected} />
      <div className="options-layout">
        <section className="options-editor">
          {sharers.length > 0 && (
            <p className="hint">
              Used by <b>{sharers.map((s) => s.name).join(", ")}</b> — saving here changes it for all of them.
            </p>
          )}
          {source && !source.exists ? (
            <div className="empty options-empty">
              <p>
                <b>{source.label}</b> has no <code>options.txt</code> yet, so Minecraft uses its
                built-in defaults here, <i>not</i> your Minecraft folder options.
              </p>
              {seed && (
                <button className="btn primary" onClick={copyFrom}>
                  Copy {nameOf(seed)} options here
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="options-toolbar">
                <input
                  className="search"
                  placeholder="Search options…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <label className="inline-check">
                  Compare with
                  <select value={other?.path ?? ""} onChange={(e) => setComparePick(e.target.value)}>
                    <option value="">nothing</option>
                    {sources
                      .filter((s) => places.some((p) => p.key === keyOf(s)))
                      .filter((s) => s.path !== source?.path && (s.exists || s.path === other?.path))
                      .map((s) => (
                        <option key={s.path} value={s.path}>
                          {nameOf(s)}
                        </option>
                      ))}
                  </select>
                </label>
                {comparing && (
                  <label className="inline-check">
                    <input type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} />
                    only differences <span className="count">{diffKeys.length}</span>
                  </label>
                )}
                {comparing && diffKeys.length > 0 && !draft && (
                  <button className="linklike" onClick={takeAll} title="Stages them — nothing is saved until Save">
                    take all {diffKeys.length} from {nameOf(other!)}
                  </button>
                )}
                <button
                  className={`btn small ${draft ? "primary" : ""}`}
                  disabled={edits.size > 0}
                  title={edits.size ? "Save or revert your edits first" : "Compare this file with another and pick what to keep"}
                  onClick={() => setResolving(true)}
                >
                  {draft ? `Resolved · ${draft.changes}` : "Resolve"}
                </button>
                <button className="linklike" onClick={() => source && api.revealPath(source.path)}>
                  reveal file
                </button>
              </div>
              {sameFile && (
                <p className="hint">
                  {nameOf(other!)} uses the very same file — they're linked, so nothing can differ.
                </p>
              )}

              <div className={`opt-groups ${comparing ? "comparing" : ""}`} inert={!!draft}>
                {grouped.map(([g, ks]) => (
                  <div key={g} className="opt-group">
                    <h3>{g}</h3>
                    <ul className="opt-list">
                      {comparing && (
                        <li className="opt-head">
                          <span>Option</span>
                          <span title={nameOf(other!)}>{nameOf(other!)}</span>
                          <span title={source && nameOf(source)}>{source && nameOf(source)}</span>
                        </li>
                      )}
                      {ks.map((k) => {
                        const value = edits.get(k) ?? mine.get(k);
                        const t = theirs.get(k);
                        const useTheirs = !comparing
                          ? ""
                          : t === undefined
                            ? `${nameOf(other!)} doesn't set this`
                            : `Use ${nameOf(other!)}'s value`;
                        return (
                          <li key={k} className={edits.has(k) ? "dirty" : ""}>
                            <div className="opt-label">
                              <span>{labelOf(k)}</span>
                              <code className="opt-key">{k}</code>
                            </div>
                            {comparing &&
                              (sameValue(value, t) ? (
                                <span className="opt-same">{show(k, t)}</span>
                              ) : (
                                <button
                                  className="chip differs"
                                  disabled={t === undefined}
                                  title={useTheirs}
                                  aria-label={`${useTheirs}: ${show(k, t)}`}
                                  onClick={() => t !== undefined && set(k)(t)}
                                >
                                  {show(k, t)}
                                </button>
                              ))}
                            <div className="opt-edit">
                              {value === undefined ? (
                                <span className="hint">not set</span>
                              ) : (
                                <Editor k={k} value={value} onChange={set(k)} />
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
              {entries && grouped.length === 0 && <div className="empty">Nothing matches.</div>}
            </>
          )}
        </section>
      </div>

      {(edits.size > 0 || draft) && (
        <div className="save-bar">
          <span>
            {draft?.changes ?? edits.size} unsaved {draft ? "resolved " : ""}change{(draft?.changes ?? edits.size) === 1 ? "" : "s"} to <b>{source && nameOf(source)}</b>
          </span>
          <span className="hint">close Minecraft first or it'll overwrite them</span>
          <button
            className="linklike"
            onClick={() => {
              setEdits(new Map());
              setDraft(null);
            }}
          >
            revert
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      )}
      {resolving && source && (
        <ResolveDialog
          dest="options.txt"
          into={keyOf(source)}
          from={other && keyOf(other)}
          onClose={() => setResolving(false)}
          draft={draft ?? undefined}
          onStage={setDraft}
        />
      )}
    </>
  );
}
