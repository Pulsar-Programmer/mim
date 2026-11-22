import { useEffect, useMemo, useState } from "react";
import { api, Installation, OptionEntry, OptionsSource } from "./api";
import { PlacePicker } from "./Places";
import { useCached } from "./hooks";

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

function labelOf(key: string): string {
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
  if (/^-?\d*\.\d+$/.test(value) && +value >= 0 && +value <= 1)
    return (
      <span className="slider">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          onChange={(e) => onChange(String(+(+e.target.value).toFixed(2)).replace(/^(\d)$/, "$1.0"))}
        />
        <span className="slider-val">{Math.round(+value * 100)}%</span>
      </span>
    );
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
  const [selected, setSelected] = useState<string | null>(null);
  const source = sources.find((s) => s.path === selected) ?? sources[0];
  const base = sources.find((s) => s.kind === "base");

  const [entries, reload] = useCached<OptionEntry[]>(
    `options:${source?.path}`,
    () => (source ? api.readOptions(source.path) : Promise.resolve([])),
    notify
  );
  const [baseEntries] = useCached<OptionEntry[]>(
    `options:${base?.path}`,
    () => (base ? api.readOptions(base.path) : Promise.resolve([])),
    notify
  );

  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [query, setQuery] = useState("");
  const [diffOnly, setDiffOnly] = useState(false);
  useEffect(() => setEdits(new Map()), [source?.path]);

  const isInstall = source?.kind === "installation";
  const baseMap = useMemo(() => new Map(baseEntries ?? []), [baseEntries]);

  const grouped = useMemo(() => {
    const q = query.toLowerCase();
    const map = new Map<Group, OptionEntry[]>();
    for (const [k, v] of entries ?? []) {
      if (k === "version") continue;
      if (q && !k.toLowerCase().includes(q) && !labelOf(k).toLowerCase().includes(q)) continue;
      if (diffOnly && isInstall && baseMap.get(k) === v) continue;
      const g = groupOf(k);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push([k, v]);
    }
    return GROUPS.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [entries, query, diffOnly, isInstall, baseMap]);

  const diffCount = useMemo(
    () => (isInstall ? (entries ?? []).filter(([k, v]) => k !== "version" && baseMap.get(k) !== v).length : 0),
    [entries, baseMap, isInstall]
  );

  const set = (k: string) => (v: string) =>
    setEdits((prev) => {
      const next = new Map(prev);
      const original = entries?.find(([ek]) => ek === k)?.[1];
      v === original ? next.delete(k) : next.set(k, v);
      return next;
    });

  async function save() {
    if (!source || !entries) return;
    try {
      await api.writeOptions(
        source.path,
        entries.map(([k, v]) => [k, edits.get(k) ?? v])
      );
      notify(`Saved ${edits.size} change${edits.size === 1 ? "" : "s"} · backup at options.txt.bak`);
      setEdits(new Map());
      reload();
    } catch (e) {
      notify(String(e));
    }
  }

  async function copyBase() {
    if (!source || !baseEntries?.length) return;
    try {
      await api.writeOptions(source.path, baseEntries);
      notify(`Copied Minecraft folder options into ${source.label}`);
      reloadSources();
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
            The <b>Minecraft folder</b> options are used when playing from the main{" "}
            <code>minecraft</code> folder. Every installation has its own{" "}
            <code>options.txt</code> — changes never carry over between them.
          </p>

      <PlacePicker
        places={sources.map((s) => ({
          key: s.path,
          label: s.kind === "base" ? "Minecraft folder" : s.label,
          kind: s.kind === "base" ? ("root" as const) : undefined,
          inst: installations.find((i) => i.name === s.label),
          sub: s.exists ? "own options.txt" : "no options.txt · game defaults",
        }))}
        value={source?.path ?? ""}
        onChange={setSelected}
      />
      <div className="options-layout">

        <section className="options-editor">
          {source && !source.exists ? (
            <div className="empty options-empty">
              <p>
                <b>{source.label}</b> has no <code>options.txt</code> yet, so Minecraft uses its
                built-in defaults here, <i>not</i> your Minecraft folder options.
              </p>
              {baseEntries && baseEntries.length > 0 && (
                <button className="btn primary" onClick={copyBase}>
                  Copy Minecraft folder options here
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
                {isInstall && (
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={diffOnly}
                      onChange={(e) => setDiffOnly(e.target.checked)}
                    />
                    only differences from base <span className="count">{diffCount}</span>
                  </label>
                )}
                <button className="linklike" onClick={() => source && api.revealPath(source.path)}>
                  reveal file
                </button>
              </div>

              <div className="opt-groups">
              {grouped.map(([g, rows]) => (
                <div key={g} className="opt-group">
                  <h3>{g}</h3>
                  <ul className="opt-list">
                    {rows.map(([k, v]) => {
                      const value = edits.get(k) ?? v;
                      const baseV = baseMap.get(k);
                      const differs = isInstall && baseV !== v;
                      return (
                        <li key={k} className={edits.has(k) ? "dirty" : ""}>
                          <div className="opt-label">
                            <span>{labelOf(k)}</span>
                            <code className="opt-key">{k}</code>
                          </div>
                          {differs && (
                            <span
                              className="chip differs"
                              title={baseV === undefined ? "not set in base" : `base: ${baseV}`}
                            >
                              base:{" "}
                              {baseV === undefined
                                ? "—"
                                : k.startsWith("key_")
                                  ? keyLabel(baseV)
                                  : baseV}
                            </span>
                          )}
                          <div className="opt-edit">
                            <Editor k={k} value={value} onChange={set(k)} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              </div>
              {entries && grouped.length === 0 && (
                <div className="empty">Nothing matches.</div>
              )}
            </>
          )}
        </section>
      </div>

      {edits.size > 0 && (
        <div className="save-bar">
          <span>
            {edits.size} unsaved change{edits.size === 1 ? "" : "s"} to{" "}
            <b>{source?.label}</b>
          </span>
          <span className="hint">close Minecraft first or it'll overwrite them</span>
          <button className="linklike" onClick={() => setEdits(new Map())}>
            revert
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      )}
    </>
  );
}
