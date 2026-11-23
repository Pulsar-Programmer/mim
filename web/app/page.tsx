import Image from "next/image";
import type { ReactNode } from "react";
import { latestVersion, RELEASES } from "../lib/release";
import { Sprite, type SpriteName } from "./Sprite";
import { DownloadCta, Inventory, Recipe } from "./widgets";

export const revalidate = 300;

const STEPS: { sprite: SpriteName; title: string; text: string }[] = [
  { sprite: "pickaxe", title: "Craft", text: "Pick a version and loader, add mods from Modrinth, and MIM builds the install." },
  { sprite: "chain", title: "Link", text: "Share saves, packs, and settings so your installs stop drifting apart." },
  { sprite: "sword", title: "Play", text: "Open the official launcher. Your install is already there, ready to go." },
];

const PLATFORMS: { os: string; name: string; sprite: SpriteName; links: [string, string, string][]; note: ReactNode }[] = [
  {
    os: "mac", name: "macOS", sprite: "apple",
    links: [["Apple silicon", ".dmg", "mac-arm"], ["Intel", ".dmg", "mac-intel"]],
    note: "Open the disk image and drag MIM to Applications.",
  },
  {
    os: "win", name: "Windows", sprite: "pane",
    links: [["Intel or AMD", ".exe", "win-x64"], ["ARM", ".exe", "win-arm"]],
    note: "If SmartScreen appears, choose More info, then Run anyway. Linking single files needs Developer Mode. Folders work without it.",
  },
  {
    os: "linux", name: "Linux", sprite: "penguin",
    links: [
      ["x86-64", "AppImage", "linux-x64-appimage"], ["x86-64", ".deb", "linux-x64-deb"],
      ["ARM64", "AppImage", "linux-arm-appimage"], ["ARM64", ".deb", "linux-arm-deb"],
    ],
    note: <>For an AppImage, run <code>chmod +x MIM_*.AppImage</code> first. On Debian or Ubuntu, run <code>sudo apt install ./MIM_*.deb</code>.</>,
  },
];

export default async function Page() {
  const version = await latestVersion().catch(() => null);
  return (
    <>
      <a className="skip" href="#download">Skip to downloads</a>
      <header className="panel">
        <div className="beam one" aria-hidden />
        <div className="beam two" aria-hidden />
        <nav className="glass" aria-label="Main">
          <a className="brand" href="#top"><Image src="/img/icon.png" alt="" width={34} height={34} />MIM</a>
          <div className="navlinks">
            <a href="#what"><Sprite name="book" size={18} />What is it</a>
            <a href="#inventory"><Sprite name="chest" size={18} />Features</a>
            <a href="https://github.com/Pulsar-Programmer/mim"><Sprite name="compass" size={18} />GitHub</a>
            <a className="nav-get" href="#download"><Sprite name="pickaxe" size={18} />Download</a>
          </div>
        </nav>

        <div className="hero" id="top">
          {version && <p className="badge"><Sprite name="lantern" size={18} />Version {version} is out</p>}
          <h1>Minecraft Installation <em>Manager</em></h1>
          <p className="lede">One home for every version, mod loader, world, and resource pack you play with. MIM works alongside the official launcher.</p>
          <DownloadCta />
        </div>

        <div className="stage">
          <div className="sun" aria-hidden />
          <Image className="shot" src="/img/app-installations.webp" width={1680} height={1200} priority sizes="(max-width: 1100px) 92vw, 1020px"
            alt="MIM's Installations page showing six Minecraft installations with their versions, mod loaders, mod counts, and linked folders." />
        </div>
        <div className="horizon" aria-hidden />
        <div className="ground" aria-hidden />
      </header>

      <main>
        <section className="band" id="what">
          <div className="wrap explain">
            <div>
              <h2>What's an installation?</h2>
              <p>An installation is one way you play Minecraft: a game version, a mod loader, and its own folder of mods, worlds, and settings.</p>
              <p>Most players end up with several. One for survival, one for a modpack, one for shaders. Each keeps its own copies, so your worlds get scattered and your keybinds never match.</p>
              <p><strong>MIM manages them all from one window</strong> and lets them share the files that should stay the same.</p>
            </div>
            <Recipe />
          </div>
        </section>

        <section className="band">
          <div className="wrap">
            <h2 className="center">Three steps to playing</h2>
            <ol className="steps">
              {STEPS.map((s) => (
                <li key={s.title}>
                  <span className="slot step-icon"><Sprite name={s.sprite} size={44} /></span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
            <div className="gallery">
              <figure>
                <Image src="/img/app-new.webp" width={1680} height={1200} loading="lazy" sizes="(max-width: 800px) 92vw, 540px" alt="MIM's New Install form with fields for name, version, loader, mods, resource packs, and image." />
                <figcaption>New Install</figcaption>
              </figure>
              <figure>
                <Image src="/img/app-link.webp" width={1680} height={1200} loading="lazy" sizes="(max-width: 800px) 92vw, 540px" alt="MIM's Link Existing page, where you pick installations to compare and link." />
                <figcaption>Link Existing</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="band" id="inventory">
          <div className="wrap">
            <h2>Your whole Minecraft folder</h2>
            <p className="section-lede">Everything that usually means digging through hidden folders has its own page. Select a slot to inspect it.</p>
            <Inventory />
          </div>
        </section>

        <section className="band" id="download">
          <div className="wrap">
            <h2 className="center">Get MIM</h2>
            <p className="section-lede center">Free on desktop.{version ? ` Version ${version}.` : ""} It updates itself from inside the app.</p>
            <div className="platforms">
              {PLATFORMS.map((p) => (
                <article className="os" data-os={p.os} key={p.os}>
                  <div className="os-head"><span className="slot os-icon"><Sprite name={p.sprite} size={36} /></span><h3>{p.name}</h3><span className="yours">Your computer</span></div>
                  <ul>
                    {p.links.map(([label, kind, id]) => (
                      <li key={id}><a className="btn smoked get" href={`/download/${id}`}>{label}<span>{kind}</span></a></li>
                    ))}
                  </ul>
                  <p className="note">{p.note}</p>
                </article>
              ))}
            </div>
            <p className="after">Looking for an older version? See <a href={RELEASES}>all releases on GitHub</a>.</p>
          </div>
        </section>
      </main>

      <div className="bedrock" aria-hidden />
      <footer className="wrap foot">
        <span>Minecraft textures belong to Mojang. MIM is not affiliated with or endorsed by Mojang or Microsoft.</span>
        <span>Pixel type: Minecraftia by Andrew Tyler, <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a>.</span>
      </footer>
    </>
  );
}
