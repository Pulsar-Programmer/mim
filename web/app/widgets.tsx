"use client";

import { useEffect, useState } from "react";
import { Sprite, type SpriteName } from "./Sprite";

const OPTIONS = {
  mac: { name: "macOS", picks: [["Apple silicon", "mac-arm"], ["Intel", "mac-intel"]] },
  win: { name: "Windows", picks: [["Intel or AMD", "win-x64"], ["ARM", "win-arm"]] },
  linux: { name: "Linux", picks: [["x86-64 AppImage", "linux-x64-appimage"], ["ARM64 AppImage", "linux-arm-appimage"]] },
} as const;
type Os = keyof typeof OPTIONS;

type Detected = { os: Os | null; phone: boolean; arm: boolean };

async function detect(): Promise<Detected> {
  const ua = navigator.userAgent;
  const phone = /Android|iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const os: Os | null = phone ? null : /Mac/.test(ua) ? "mac" : /Win/.test(ua) ? "win" : /Linux|X11/.test(ua) ? "linux" : null;
  // Only Chromium reports the CPU. Elsewhere, assume the common one and keep the other a click away.
  let arm = os === "mac" || /aarch64|arm64/i.test(ua);
  try {
    const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ architecture?: string }> } }).userAgentData;
    const architecture = (await data?.getHighEntropyValues(["architecture"]))?.architecture;
    if (architecture) arm = architecture === "arm";
  } catch {}
  return { os, phone, arm };
}

export function ThemeToggle() {
  const toggle = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("mim-theme", next);
    } catch {}
  };
  return (
    <button className="theme" onClick={toggle} aria-label="Switch between light and dark mode">
      <span className="show-dark"><Sprite name="sunny" size={20} /></span>
      <span className="show-light"><Sprite name="moon" size={20} /></span>
    </button>
  );
}

export function DownloadCta() {
  const [d, setD] = useState<Detected | null>(null);
  useEffect(() => {
    detect().then((found) => {
      setD(found);
      if (found.os) document.querySelector(`[data-os="${found.os}"]`)?.classList.add("mine");
    });
  }, []);

  if (d?.phone) {
    return (
      <div className="cta">
        <a className="btn enamel" href="#download">See desktop downloads</a>
        <p className="cta-note">MIM runs on computers, not phones or tablets.</p>
      </div>
    );
  }
  if (!d?.os) {
    return (
      <div className="cta">
        <a className="btn enamel" href="#download">Download MIM</a>
        <a className="btn smoked" href="#what">What is MIM?</a>
      </div>
    );
  }
  const { name, picks } = OPTIONS[d.os];
  const armFirst = d.os === "mac";
  const [pick, other] = armFirst === d.arm ? [picks[0], picks[1]] : [picks[1], picks[0]];
  return (
    <>
      <div className="cta">
        <a className="btn enamel" href={`/download/${pick[1]}`}>Download for {name}</a>
        <a className="btn smoked" href="#what">What is MIM?</a>
      </div>
      <p className="cta-note">
        {pick[0]}. <a href={`/download/${other[1]}`}>Need {other[0]}?</a>
      </p>
    </>
  );
}

const VERSIONS = ["1.21.4", "1.20.1", "1.16.1"];
const LOADERS: { name: string; sprite: SpriteName }[] = [
  { name: "Fabric", sprite: "gear" },
  { name: "Forge", sprite: "anvil" },
  { name: "NeoForge", sprite: "lantern" },
  { name: "Vanilla", sprite: "grass" },
];
const MODS = [42, 118, 9];
const SHARED = ["Saves", "Packs", "Screenshots"];

export function Recipe() {
  const [v, setV] = useState(0);
  const [l, setL] = useState(0);
  const [m, setM] = useState(0);
  const [s, setS] = useState(0);
  const loader = LOADERS[l];
  const vanilla = loader.name === "Vanilla";
  const mods = vanilla ? 0 : MODS[m];

  return (
    <div className="recipe">
      <div className="recipe-row">
        <button className="slot" onClick={() => setV((v + 1) % VERSIONS.length)} aria-label={`Minecraft version ${VERSIONS[v]}. Change version`}>
          <Sprite name="map" size={40} />
          <b>{VERSIONS[v]}</b>
          <small>Version</small>
        </button>
        <button className="slot" onClick={() => setL((l + 1) % LOADERS.length)} aria-label={`Loader ${loader.name}. Change loader`}>
          <Sprite name={loader.sprite} size={40} />
          <b>{loader.name}</b>
          <small>Loader</small>
        </button>
        <button className="slot" disabled={vanilla} onClick={() => setM((m + 1) % MODS.length)} aria-label={`${mods} mods. Change mods`}>
          <Sprite name="pickaxe" size={40} />
          <b>{mods}</b>
          <small>Mods</small>
        </button>
        <button className="slot" onClick={() => setS((s + 1) % SHARED.length)} aria-label={`Shared ${SHARED[s]}. Change shared folder`}>
          <Sprite name="chain" size={40} />
          <b>{SHARED[s]}</b>
          <small>Shared</small>
        </button>
        <span className="recipe-arrow" aria-hidden />
        <div className="slot output" aria-live="polite">
          <Sprite name="chest" size={48} />
          <b>{vanilla ? "Vanilla" : loader.name} {VERSIONS[v]}</b>
          <small>{vanilla ? "No mods" : `${mods} mods`}, shared {SHARED[s].toLowerCase()}</small>
        </div>
      </div>
      <p className="recipe-hint">Click a slot to change the recipe.</p>
    </div>
  );
}

const ITEMS: { name: string; sprite: SpriteName; text: string }[] = [
  { name: "Saves", sprite: "grass", text: "Browse your worlds across every install and see what's inside each one." },
  { name: "Mods", sprite: "gear", text: "See what each install runs and update its mods from Modrinth." },
  { name: "Upgrades", sprite: "anvil", text: "Move an install and its mods to a newer Minecraft version." },
  { name: "Resource Packs", sprite: "painting", text: "Manage your packs and share them between installs." },
  { name: "Shader Packs", sprite: "lantern", text: "Pick shaders with preview screenshots from Modrinth." },
  { name: "Options & Config", sprite: "book", text: "Compare and edit settings and keybinds for each game folder." },
  { name: "Servers", sprite: "compass", text: "Edit server lists and copy servers between installs." },
  { name: "Screenshots", sprite: "map", text: "Find every screenshot from every install in one gallery." },
  { name: "Launcher Profiles", sprite: "chest", text: "Put away old profiles and restore them anytime." },
];

export function Inventory() {
  const [i, setI] = useState(0);
  return (
    <div className="inventory">
      <div className="inv-grid">
        {ITEMS.map((item, n) => (
          <button
            key={item.name}
            className="slot inv"
            aria-pressed={n === i}
            aria-label={item.name}
            onClick={() => setI(n)}
            onMouseEnter={() => setI(n)}
            onFocus={() => setI(n)}
          >
            <Sprite name={item.sprite} size={48} />
          </button>
        ))}
      </div>
      <div className="tooltip" aria-live="polite">
        <Sprite name={ITEMS[i].sprite} size={64} />
        <h3>{ITEMS[i].name}</h3>
        <p>{ITEMS[i].text}</p>
      </div>
    </div>
  );
}
