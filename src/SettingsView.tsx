import { useMemo } from "react";
import { FontChoice, Settings, fontInstalled } from "./settings";

const FONTS: { id: FontChoice; label: string; family?: string }[] = [
  { id: "default", label: "MIM default", family: '"P22 Mackinack Pro", "Lora", serif' },
  { id: "minecraft", label: "Minecraft", family: '"MIM Minecrafter", monospace' },
  { id: "minecraftia", label: "Minecraftia", family: '"MIM Minecraftia", monospace' },
  { id: "system", label: "System", family: "-apple-system, sans-serif" },
  { id: "mono", label: "Monospace", family: "ui-monospace, monospace" },
  { id: "custom", label: "Custom…" },
];

const SCALES = [0.9, 1, 1.1, 1.2];

export function SettingsView({
  settings,
  onChange,
  mcDir,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  mcDir: { path: string; sample: boolean } | null;
}) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const customOk = useMemo(
    () => fontInstalled(settings.customFont),
    [settings.customFont]
  );

  const familyFor = (id: FontChoice, fallback?: string) =>
    id === "custom"
        ? `"${settings.customFont}", serif`
        : fallback;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">saved on this Mac</p>
        </div>
      </header>

      <section className="settings-block">
        <h2>Font</h2>
        <div className="font-grid">
          {FONTS.map((f) => (
            <button
              key={f.id}
              className={`font-card ${settings.font === f.id ? "active" : ""}`}
              onClick={() => set({ font: f.id })}
            >
              <span className="font-sample" style={{ fontFamily: familyFor(f.id, f.family) }}>
                Aa
              </span>
              <span className="font-label">{f.label}</span>
              {(f.id === "minecraft" || f.id === "minecraftia") && <span className="font-status ok">built in</span>}
            </button>
          ))}
        </div>

        {settings.font === "minecraft" && (
          <p className="hint wide settings-note">
            Headings in <b>Minecrafter</b>
            {settings.fontScope === "everything" && (
              <>
                , text in <b>Minecraftia</b> (© Andrew Tyler, CC BY-SA 3.0)
              </>
            )}
            <span className="more"> — {settings.fontScope === "everything" ? "both ship" : "ships"} with MIM</span>.
          </p>
        )}

        {settings.font === "custom" && (
          <div className="row-inline settings-note">
            <input
              className="search custom-font"
              placeholder="Font family name, as shown in Font Book"
              value={settings.customFont}
              onChange={(e) => set({ customFont: e.target.value })}
              autoFocus
            />
            {settings.customFont.trim() && (
              <span className={`font-status ${customOk ? "ok" : "missing"}`}>
                {customOk ? "installed" : "not found"}
              </span>
            )}
          </div>
        )}

        {settings.font !== "default" && (
          <div className="row-inline settings-note">
            <span className="hint">Use it for</span>
            <div className="segmented">
              <button
                className={settings.fontScope === "headings" ? "active" : ""}
                onClick={() => set({ fontScope: "headings" })}
              >
                Headings
              </button>
              <button
                className={settings.fontScope === "everything" ? "active" : ""}
                onClick={() => set({ fontScope: "everything" })}
              >
                Everything
              </button>
            </div>
          </div>
        )}

        <div className="font-preview">
          <h1>Survival Base</h1>
          <p>The quick brown fox jumps over 13 lazy creepers.</p>
        </div>
      </section>

      <section className="settings-block">
        <h2>Reduced text</h2>
        <div className="segmented">
          {[true, false].map((on) => (
            <button
              key={String(on)}
              className={settings.reducedText === on ? "active" : ""}
              onClick={() => set({ reducedText: on })}
            >
              {on ? "On" : "Off"}
            </button>
          ))}
        </div>
        <p className="hint wide settings-note more">Hides the longer explanations around the app.</p>
      </section>

      <section className="settings-block">
        <h2>Interface size</h2>
        <div className="segmented">
          {SCALES.map((s) => (
            <button
              key={s}
              className={settings.scale === s ? "active" : ""}
              onClick={() => set({ scale: s })}
            >
              {Math.round(s * 100)}%
            </button>
          ))}
        </div>
      </section>

      <section className="settings-block">
        <h2>Minecraft folder</h2>
        <p className="hint wide">
          <code>{mcDir?.path ?? "…"}</code>
          {mcDir?.sample && (
            <>
              {" "}
              — a <b>sample folder</b> (set by <code>MIM_MINECRAFT_DIR</code>). Your real
              folder isn't being touched.
            </>
          )}
        </p>
      </section>
    </>
  );
}
