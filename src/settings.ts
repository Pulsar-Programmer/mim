import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Per-machine UI preferences, kept in localStorage (they're conveniences,
// nothing breaks if storage is unavailable).

export type Theme = "system" | "light" | "dark";

export type FontChoice = "default" | "minecraft" | "minecraftia" | "system" | "mono" | "custom";

export interface Settings {
  font: FontChoice;
  customFont: string;
  fontScope: "headings" | "everything";
  scale: number; // 0.9 – 1.2
  reducedText: boolean;
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  font: "minecraftia",
  customFont: "",
  fontScope: "headings",
  scale: 1,
  reducedText: true,
  theme: "system",
};

/** Bundled with the app (src/assets/fonts), so no install needed. */
const MINECRAFT_BODY = '"MIM Minecraftia", monospace';
const MINECRAFT_HEADINGS = '"MIM Minecrafter", "MIM Minecraftia", monospace';

const KEY = "mim.settings";

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode / storage off — settings just won't persist
  }
}

/**
 * Whether a font family is installed. document.fonts.check() says yes for
 * any local name, so compare rendered widths against two different fallbacks.
 */
export function fontInstalled(family: string): boolean {
  if (!family.trim()) return false;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  const sample = "mmmmmmmmmmlli1WQ@#";
  return ["monospace", "serif"].some((fallback) => {
    ctx.font = `48px ${fallback}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `48px "${family}", ${fallback}`;
    return ctx.measureText(sample).width !== base;
  });
}

const STACKS: Record<Exclude<FontChoice, "minecraft" | "custom">, string | null> = {
  default: null, // keep the stylesheet's stacks
  minecraftia: MINECRAFT_BODY,
  system: '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
};

let reduced = DEFAULT_SETTINGS.reducedText;
let theme: Theme = DEFAULT_SETTINGS.theme;
let windowTheme: Theme | undefined;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const dark = theme === "dark" || (theme === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // The native window (title bar, resize/zoom backdrop) has its own appearance;
  // left on the OS's, it shows white behind a forced dark page, and vice versa.
  if (windowTheme !== theme) {
    windowTheme = theme;
    getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => {});
  }
}
darkQuery.addEventListener("change", applyTheme);

/** With Reduced text on, drops the " — explanation" tail of a UI string. */
export function brief(text: string): string {
  return reduced ? text.split(" — ")[0] : text;
}

/** Pushes settings onto the CSS variables the stylesheet reads. */
export function applySettings(s: Settings) {
  reduced = s.reducedText;
  theme = s.theme;
  applyTheme();
  // .more spans (long explanations) hide under :root.reduced
  document.documentElement.classList.toggle("reduced", s.reducedText);
  const root = document.documentElement.style;
  let headings: string | null;
  let body: string | null;
  if (s.font === "minecraft") {
    headings = MINECRAFT_HEADINGS;
    body = MINECRAFT_BODY;
  } else if (s.font === "custom") {
    headings = body = s.customFont.trim() ? `"${s.customFont.trim()}", serif` : null;
  } else {
    headings = body = STACKS[s.font];
  }
  for (const v of ["--serif", "--display", "--body"]) root.removeProperty(v);
  if (headings) {
    root.setProperty("--serif", headings);
    root.setProperty("--display", headings);
  }
  if (body && s.fontScope === "everything") root.setProperty("--body", body);
  // ponytail: measured from a Hypixel card's "H"; other glyphs may need their own offset
  if (s.font === "minecraft") root.setProperty("--initial-nudge", "0.074em, -0.0625em");
  else root.removeProperty("--initial-nudge");
  // native webview zoom (like ⌘+), so 100vh layouts still fit the window
  getCurrentWebview().setZoom(s.scale).catch(() => {});
}
