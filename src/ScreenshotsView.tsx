import { CSSProperties, MouseEvent, PointerEvent as RPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, formatBytes, Installation, okToChangeShared, Screenshot } from "./api";
import { PlacePicker, sharedPlaces } from "./Places";
import { brief } from "./settings";
import { useCached, useConfirm } from "./hooks";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Shot = Screenshot & { taken: Date | null };

/** Minecraft names shots `2026-11-18_21.04.11.png`; that beats mtime after a copy. */
function takenAt(s: Screenshot): Date | null {
  const m = s.name.match(/^(\d{4})-(\d\d)-(\d\d)_(\d\d)\.(\d\d)\.(\d\d)/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return s.modified ? new Date(s.modified) : null;
}

const thumb = (path: string) => convertFileSrc(path, "thumb");
const full = (path: string) => convertFileSrc(path);
const fmt = (d: Date | null, o: Intl.DateTimeFormatOptions) =>
  d ? d.toLocaleString(undefined, o) : "Undated";
const monthOf = (d: Date | null) => fmt(d, { month: "long", year: "numeric" });

const RATIOS: [number, string][] = [
  [16 / 9, "16:9"], [16 / 10, "16:10"], [4 / 3, "4:3"], [3 / 2, "3:2"],
  [21 / 9, "21:9"], [1, "1:1"], [9 / 16, "9:16"],
];
function ratio(w: number, h: number) {
  const r = w / h;
  return RATIOS.find(([v]) => Math.abs(v - r) < 0.02)?.[1] ?? `${r.toFixed(2)}:1`;
}

/** Small, per-machine conveniences — fine if storage is off. */
function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // storage off — the choice just won't stick
    }
  };
  return [v, set];
}

/** Dominant colours of an image, via a tiny canvas and 4-bit buckets. */
function palette(src: string): Promise<string[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onerror = () => resolve([]);
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 36;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const buckets = new Map<number, [number, number, number, number]>();
        for (let i = 0; i < px.length; i += 4) {
          const k = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
          const b = buckets.get(k) ?? [0, 0, 0, 0];
          b[0]++, (b[1] += px[i]), (b[2] += px[i + 1]), (b[3] += px[i + 2]);
          buckets.set(k, b);
        }
        const picked: number[][] = [];
        for (const [n, r, g, b] of [...buckets.values()].sort((a, b) => b[0] - a[0])) {
          const rgb = [r / n, g / n, b / n].map(Math.round);
          if (picked.every((p) => Math.hypot(p[0] - rgb[0], p[1] - rgb[1], p[2] - rgb[2]) > 48))
            picked.push(rgb);
          if (picked.length === 6) break;
        }
        resolve(picked.map((p) => "#" + p.map((v) => v.toString(16).padStart(2, "0")).join("")));
      } catch {
        resolve([]); // tainted canvas etc. — just no palette
      }
    };
    img.src = src;
  });
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Morphs a gallery tile into the viewer (and back) where the webview supports it. */
function morph(update: () => void, tile: HTMLElement | null, closing = false) {
  if (!document.startViewTransition || reducedMotion() || !tile) return update();
  if (!closing) tile.style.viewTransitionName = "shot";
  const t = document.startViewTransition(() => {
    flushSync(update);
    if (closing) {
      tile.scrollIntoView({ block: "nearest" });
      tile.style.viewTransitionName = "shot";
    } else tile.style.viewTransitionName = "";
  });
  t.finished.finally(() => (tile.style.viewTransitionName = ""));
}

const tileImg = (path: string) =>
  document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"] img`);

// ---------------------------------------------------------------------------
// gallery
// ---------------------------------------------------------------------------

export function ScreenshotsView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [raw = [], reload] = useCached<Screenshot[]>("screenshots", api.listScreenshots, notify);
  const [gone, setGone] = useState<Set<string>>(new Set()); // trashed, before the reload lands
  const [favList, setFavList] = usePref<string[]>("mim.shots.favorites", []);
  const favs = useMemo(() => new Set(favList), [favList]);
  const toggleFav = (p: string) =>
    setFavList(favs.has(p) ? favList.filter((f) => f !== p) : [...favList, p]);

  const [location, setLocation] = useState("all");
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [sort, setSort] = usePref<"newest" | "oldest">("mim.shots.sort", "newest");
  const [row, setRow] = usePref("mim.shots.row", 150);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const anchor = useRef<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [heroPath, setHeroPath] = useState<string | null>(null);
  const heroImg = useRef<HTMLImageElement>(null);

  const { armed, confirm } = useConfirm(notify, reload);

  const shots: Shot[] = useMemo(
    () => raw.filter((s) => !gone.has(s.path)).map((s) => ({ ...s, taken: takenAt(s) })),
    [raw, gone]
  );
  const locations = [...new Set(shots.map((s) => s.location))];
  const shown = useMemo(() => {
    const list = shots.filter(
      (s) => (location === "all" || s.location === location) && (!onlyFavs || favs.has(s.path))
    );
    const t = (s: Shot) => s.taken?.getTime() ?? 0;
    return list.sort((a, b) => (sort === "newest" ? t(b) - t(a) : t(a) - t(b)));
  }, [shots, location, onlyFavs, favs, sort]);

  const groups = useMemo(() => {
    const map = new Map<string, { shot: Shot; index: number }[]>();
    shown.forEach((shot, index) => {
      const m = monthOf(shot.taken);
      if (!map.has(m)) map.set(m, []);
      map.get(m)!.push({ shot, index });
    });
    return [...map.entries()];
  }, [shown]);

  const hero =
    shots.find((s) => s.path === heroPath) ??
    shots.find((s) => favs.has(s.path)) ??
    [...shots].sort((a, b) => (b.taken?.getTime() ?? 0) - (a.taken?.getTime() ?? 0))[0];
  const dates = shots.map((s) => s.taken?.getTime()).filter((t): t is number => !!t);
  const span =
    dates.length > 1
      ? `${monthOf(new Date(Math.min(...dates)))} – ${monthOf(new Date(Math.max(...dates)))}`
      : null;

  // keep the viewer on a valid shot as the list shrinks
  useEffect(() => {
    if (open == null) return;
    if (shown.length === 0) setOpen(null);
    else if (open >= shown.length) setOpen(shown.length - 1);
  }, [open, shown.length]);

  // gallery keys (the viewer handles its own)
  useEffect(() => {
    if (open != null) return;
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Escape") clearSelection();
      if ((e.metaKey || e.ctrlKey) && e.key === "a" && selecting) {
        e.preventDefault();
        setSelected(new Set(shown.map((s) => s.path)));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  function clearSelection() {
    setSelected(new Set());
    setSelecting(false);
    anchor.current = null;
  }

  function openAt(index: number, play = false, from?: HTMLElement | null) {
    setAutoplay(play);
    morph(() => setOpen(index), from ?? tileImg(shown[index].path));
  }

  function close() {
    const path = open != null ? shown[open]?.path : null;
    morph(() => setOpen(null), path ? tileImg(path) : null, true);
  }

  function onTile(e: MouseEvent, index: number) {
    const path = shown[index].path;
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = [anchor.current, index].sort((x, y) => x - y);
      setSelected(new Set([...selected, ...shown.slice(a, b + 1).map((s) => s.path)]));
      setSelecting(true);
      return;
    }
    if (selecting || e.metaKey || e.ctrlKey) {
      const next = new Set(selected);
      next.has(path) ? next.delete(path) : next.add(path);
      setSelected(next);
      setSelecting(next.size > 0 || selecting);
      anchor.current = index;
      return;
    }
    anchor.current = index;
    openAt(index);
  }

  async function trash(paths: string[]) {
    const label = paths.length === 1 ? "Trashing this screenshot" : `Trashing ${paths.length} screenshots`;
    if (!(await okToChangeShared(paths, label))) return "Nothing moved";
    let n = 0;
    for (const p of paths) {
      await api.trashItem(p);
      n++;
      setGone((g) => new Set(g).add(p));
    }
    return `Moved ${n} screenshot${n === 1 ? "" : "s"} to Trash`;
  }

  const totalBytes = shots.reduce((n, s) => n + s.size_bytes, 0);

  return (
    <div className="shots" style={{ "--row": `${row}px` } as CSSProperties}>
      <header className="page-head">
        <div>
          <h1>Screenshots</h1>
          <p className="sub">
            {shots.length} capture{shots.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}
            {span && ` · ${span}`}
          </p>
        </div>
      </header>

      {hero && (
        <section className="hero" onClick={() => openAt(Math.max(0, shown.indexOf(hero)), false, heroImg.current)}>
          <img key={hero.path} ref={heroImg} src={full(hero.path)} alt="" />
          <div className="hero-shade" />
          <div className="hero-copy">
            <div className="eyebrow">
              {heroPath ? "Rediscovered" : favs.has(hero.path) ? "★ Favorite" : "Latest capture"}
            </div>
            <div className="hero-title">{fmt(hero.taken, { weekday: "long", month: "long", day: "numeric" })}</div>
            <div className="hero-sub">
              {fmt(hero.taken, { hour: "numeric", minute: "2-digit" })} · {hero.taken?.getFullYear()}
              {hero.location !== "Shared" && ` · ${hero.location}`} · {hero.width}×{hero.height}
            </div>
            <div className="hero-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="glass primary"
                onClick={() => openAt(Math.max(0, shown.indexOf(hero)), false, heroImg.current)}
              >
                View
              </button>
              <button className="glass" disabled={!shown.length} onClick={() => openAt(0, true)}>
                ▶ Slideshow
              </button>
              {shots.length > 1 && (
                <button
                  className="glass"
                  title="Show a random screenshot"
                  onClick={() => {
                    const others = shots.filter((s) => s.path !== hero.path);
                    setHeroPath(others[Math.floor(Math.random() * others.length)].path);
                  }}
                >
                  ⤨ Surprise me
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {shots.length > 0 && (
        <PlacePicker
          places={sharedPlaces("screenshots", locations, installations, (l) =>
            shots.filter((s) => s.location === l).length
          )}
          value={location}
          onChange={(l) => {
            setLocation(l);
            setOpen(null);
          }}
        />
      )}

      {shots.length > 0 && (
        <div className="shot-toolbar">
          <button
            className={`pill ${onlyFavs ? "on" : ""}`}
            onClick={() => setOnlyFavs(!onlyFavs)}
            title="Only favorites"
          >
            ★ <span className="count">{shots.filter((s) => favs.has(s.path)).length}</span>
          </button>
          <div className="spacer" />
          <div className="segmented small">
            {(["newest", "oldest"] as const).map((s) => (
              <button key={s} className={sort === s ? "active" : ""} onClick={() => setSort(s)}>
                {s}
              </button>
            ))}
          </div>
          <label className="density" title="Thumbnail size">
            <span className="dot small" />
            <input type="range" min={100} max={320} step={10} value={row} onChange={(e) => setRow(+e.target.value)} />
            <span className="dot" />
          </label>
          <button
            className={`pill ${selecting ? "on" : ""}`}
            onClick={() => (selecting ? clearSelection() : setSelecting(true))}
          >
            {selecting ? "Done" : "Select"}
          </button>
        </div>
      )}

      {groups.map(([m, items]) => (
        <section key={m} className="shot-group">
          <h3 className="shot-month">
            {m} <span className="count">{items.length}</span>
          </h3>
          <div className={`justified ${selecting ? "selecting" : ""}`}>
            {items.map(({ shot, index }) => {
              const ar = Math.min(Math.max(shot.width / shot.height, 0.5), 3);
              return (
                <div
                  key={shot.path}
                  data-path={shot.path}
                  className={`tile ${selected.has(shot.path) ? "selected" : ""}`}
                  style={{ flexGrow: ar * 100, flexBasis: `calc(${ar} * var(--row))`, "--i": index } as CSSProperties}
                >
                  <button className="tile-hit" onClick={(e) => onTile(e, index)} aria-label={shot.name}>
                    <i style={{ paddingBottom: `${100 / ar}%` }} />
                    <img
                      src={thumb(shot.path)}
                      loading="lazy"
                      decoding="async"
                      alt=""
                      onLoad={(e) => e.currentTarget.classList.add("loaded")}
                    />
                    <span className="tile-meta">
                      {fmt(shot.taken, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      {shot.location !== "Shared" && <span className="tile-loc">{shot.location}</span>}
                    </span>
                    <span className="tile-check">✓</span>
                  </button>
                  <button
                    className={`tile-fav ${favs.has(shot.path) ? "on" : ""}`}
                    aria-label={favs.has(shot.path) ? "Unfavorite" : "Favorite"}
                    onClick={() => toggleFav(shot.path)}
                  >
                    ★
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {shots.length === 0 && (
        <div className="shots-empty">
          <div className="lens" />
          <h2>No screenshots yet</h2>
          <p className="hint">
            Press <kbd>F2</kbd> in game and they'll show up here, sorted by month.
          </p>
        </div>
      )}
      {shots.length > 0 && shown.length === 0 && (
        <div className="empty">{onlyFavs ? brief("No favorites here yet — tap ★ on any shot.") : "Nothing here."}</div>
      )}

      {selecting && (
        <div className="select-bar">
          <span>
            <b>{selected.size}</b> selected
          </span>
          <button className="linklike" onClick={() => setSelected(new Set(shown.map((s) => s.path)))}>
            all
          </button>
          <button
            className="linklike"
            disabled={!selected.size}
            onClick={() => {
              const add = [...selected].filter((p) => !favs.has(p));
              setFavList(add.length ? [...favList, ...add] : favList.filter((f) => !selected.has(f)));
            }}
          >
            ★ favorite
          </button>
          <button
            className="linklike danger-link"
            disabled={!selected.size}
            onClick={() =>
              confirm("bulk", async () => {
                const msg = await trash([...selected]);
                clearSelection();
                return msg;
              })
            }
          >
            {armed === "bulk" ? `trash ${selected.size}?` : "move to trash"}
          </button>
          <button className="select-x" onClick={clearSelection} aria-label="Done selecting">
            ✕
          </button>
        </div>
      )}

      {open != null && shown[open] && (
        <Viewer
          shots={shown}
          index={open}
          setIndex={setOpen}
          autoplay={autoplay}
          onClose={close}
          favs={favs}
          toggleFav={toggleFav}
          armed={armed}
          onTrash={(p) => confirm(p, () => trash([p]))}
          notify={notify}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// viewer
// ---------------------------------------------------------------------------

const SLIDE_MS = 5000;
const MAX_ZOOM = 12;

function Viewer(props: {
  shots: Shot[];
  index: number;
  setIndex: (i: number) => void;
  autoplay: boolean;
  onClose: () => void;
  favs: Set<string>;
  toggleFav: (p: string) => void;
  armed: string | null;
  onTrash: (p: string) => void;
  notify: (m: string) => void;
}) {
  const { shots, index, setIndex, onClose, favs, notify } = props;
  const shot = shots[index];
  const stage = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 1, h: 1 });
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const [playing, setPlaying] = useState(props.autoplay);
  const [info, setInfo] = usePref("mim.shots.info", false);
  const [idle, setIdle] = useState(false);
  const [colors, setColors] = useState<string[]>([]);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const swipe = useRef({ dx: 0, at: 0 });
  const idleTimer = useRef<number>(undefined);

  const fit = Math.min(box.w / shot.width, box.h / shot.height);
  const zoomPct = Math.round(fit * z.s * 100);
  const go = (i: number) => setIndex((i + shots.length) % shots.length);

  // clamp so the picture can't be dragged off-stage
  const clampZ = (s: number, x: number, y: number) => {
    s = Math.min(Math.max(s, 1), MAX_ZOOM);
    const mx = Math.max(0, (shot.width * fit * s - box.w) / 2);
    const my = Math.max(0, (shot.height * fit * s - box.h) / 2);
    return { s, x: Math.min(Math.max(x, -mx), mx), y: Math.min(Math.max(y, -my), my) };
  };
  // zoom about a point given relative to the stage centre
  const zoomAt = (s: number, px = 0, py = 0) =>
    setZ((c) => {
      const k = Math.min(Math.max(s, 1), MAX_ZOOM) / c.s;
      return clampZ(s, px - (px - c.x) * k, py - (py - c.y) * k);
    });
  const toActual = () => zoomAt(z.s > 1.01 ? 1 : Math.max(1 / fit, 2.5));

  useEffect(() => setZ({ s: 1, x: 0, y: 0 }), [index]);

  useEffect(() => {
    const el = stage.current!;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // pinch / ctrl-wheel zooms, mouse wheel zooms, two-finger scroll pans (or swipes between shots)
  useEffect(() => {
    const el = stage.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left - r.width / 2;
      const py = e.clientY - r.top - r.height / 2;
      const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && !e.ctrlKey);
      if (e.ctrlKey || mouseWheel) {
        setZ((c) => {
          const s = c.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
          const k = Math.min(Math.max(s, 1), MAX_ZOOM) / c.s;
          return clampZ(s, px - (px - c.x) * k, py - (py - c.y) * k);
        });
      } else if (z.s > 1) {
        setZ((c) => clampZ(c.s, c.x - e.deltaX, c.y - e.deltaY));
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const now = performance.now();
        if (now - swipe.current.at < 450) return; // one swipe, one shot
        swipe.current.dx += e.deltaX;
        if (Math.abs(swipe.current.dx) > 90) {
          go(index + Math.sign(swipe.current.dx));
          swipe.current = { dx: 0, at: now };
        }
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  // keyboard
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "c") return copy();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const act: Record<string, () => void> = {
        escape: () => (z.s > 1 ? setZ({ s: 1, x: 0, y: 0 }) : onClose()),
        arrowright: () => go(index + 1),
        arrowleft: () => go(index - 1),
        home: () => setIndex(0),
        end: () => setIndex(shots.length - 1),
        " ": () => setPlaying(!playing),
        i: () => setInfo(!info),
        f: () => props.toggleFav(shot.path),
        c: copy,
        r: () => api.revealPath(shot.path),
        o: () => api.revealPath(shot.path, false),
        "+": () => zoomAt(z.s * 1.5),
        "=": () => zoomAt(z.s * 1.5),
        "-": () => zoomAt(z.s / 1.5),
        "0": () => setZ({ s: 1, x: 0, y: 0 }),
        "1": toActual,
        backspace: () => props.onTrash(shot.path),
        delete: () => props.onTrash(shot.path),
      };
      if (act[k]) {
        e.preventDefault();
        act[k]();
        wake();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // slideshow
  useEffect(() => {
    if (!playing) return;
    setZ({ s: 1, x: 0, y: 0 });
    const t = setTimeout(() => go(index + 1), SLIDE_MS);
    return () => clearTimeout(t);
  }, [playing, index, shots.length]);

  // filmstrip follows along
  useEffect(() => {
    strip.current
      ?.querySelector(".strip-item.active")
      ?.scrollIntoView({ inline: "center", block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [index]);

  useEffect(() => {
    let live = true;
    setColors([]);
    palette(thumb(shot.path)).then((c) => live && setColors(c));
    return () => {
      live = false;
    };
  }, [shot.path]);

  // tuck the chrome away when the mouse rests
  function wake() {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 2600);
  }
  useEffect(() => {
    wake();
    return () => clearTimeout(idleTimer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": fetch(full(shot.path)).then((r) => r.blob()) }),
      ]);
      notify(brief("Copied image — paste it anywhere"));
    } catch (e) {
      notify(`Couldn't copy: ${e}`);
    }
  }

  function copyHex(hex: string) {
    navigator.clipboard.writeText(hex).then(
      () => notify(`Copied ${hex}`),
      (e) => notify(String(e))
    );
  }

  const pointer = {
    onPointerDown: (e: RPointerEvent) => {
      drag.current = { x: e.clientX, y: e.clientY, moved: false };
      if (z.s > 1) e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: RPointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (z.s > 1) {
        d.x = e.clientX;
        d.y = e.clientY;
        setZ((c) => clampZ(c.s, c.x + dx, c.y + dy));
      }
    },
    onPointerUp: (e: RPointerEvent) => {
      const d = drag.current;
      drag.current = null;
      // a plain click on the dark around the picture closes
      if (d && !d.moved && e.target === e.currentTarget) onClose();
    },
    onDoubleClick: (e: MouseEvent) => {
      const r = stage.current!.getBoundingClientRect();
      const target = z.s > 1.01 ? 1 : Math.max(1 / fit, 2.5);
      zoomAt(target, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    },
  };

  const fav = favs.has(shot.path);
  const trashArmed = props.armed === shot.path;
  const kbClass = playing ? `kb kb-${index % 4}` : "";

  return (
    <div
      className={`viewer-shell ${idle && !info ? "idle" : ""} ${info ? "with-info" : ""}`}
      onMouseMove={wake}
      role="dialog"
      aria-label="Screenshot viewer"
    >
      <div className="vs-ambient" style={{ backgroundImage: `url("${thumb(shot.path)}")` }} key={shot.path} />

      <header className="vs-top" data-tauri-drag-region>
        <span className="vs-count" data-tauri-drag-region>
          {index + 1} <span>/ {shots.length}</span>
        </span>
        <span className="vs-title" data-tauri-drag-region>
          {fmt(shot.taken, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          {shot.location !== "Shared" && <span className="vs-loc">{shot.location}</span>}
        </span>
        <div className="vs-tools">
          <button className="vs-btn wide" onClick={toActual} title="Toggle actual size (1)">
            {zoomPct}%
          </button>
          <button className={`vs-btn ${playing ? "on" : ""}`} onClick={() => setPlaying(!playing)} title="Slideshow (space)">
            {playing ? "❚❚" : "▶"}
          </button>
          <button className={`vs-btn ${fav ? "on fav" : ""}`} onClick={() => props.toggleFav(shot.path)} title="Favorite (F)">
            ★
          </button>
          <button className="vs-btn" onClick={copy} title="Copy image (C)">
            ⧉
          </button>
          <button className={`vs-btn ${info ? "on" : ""}`} onClick={() => setInfo(!info)} title="Info (I)">
            i
          </button>
          <button className="vs-btn" onClick={onClose} title="Close (esc)">
            ✕
          </button>
        </div>
      </header>

      <div
        ref={stage}
        className={`vs-stage ${z.s > 1 ? "zoomed" : ""}`}
        {...pointer}
      >
        <div className={`vs-frame ${kbClass}`} key={shot.path + playing}>
          <img
            className="vs-img"
            src={full(shot.path)}
            alt={shot.name}
            draggable={false}
            style={{
              width: shot.width * fit,
              height: shot.height * fit,
              transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})`,
              backgroundImage: `url("${thumb(shot.path)}")`,
              imageRendering: fit * z.s > 1.2 ? "pixelated" : "auto",
              viewTransitionName: "shot",
            }}
          />
        </div>
        {shots.length > 1 && (
          <>
            <button className="vs-nav prev" onClick={() => go(index - 1)} aria-label="Previous">
              ‹
            </button>
            <button className="vs-nav next" onClick={() => go(index + 1)} aria-label="Next">
              ›
            </button>
          </>
        )}
      </div>

      {playing && <div className="vs-progress" key={index} style={{ animationDuration: `${SLIDE_MS}ms` }} />}

      <div className="vs-strip" ref={strip}>
        {shots.map((s, i) => (
          <button
            key={s.path}
            className={`strip-item ${i === index ? "active" : ""}`}
            style={{ aspectRatio: `${Math.min(Math.max(s.width / s.height, 0.5), 3)}` }}
            onClick={() => setIndex(i)}
            aria-label={s.name}
          >
            <img src={thumb(s.path)} loading="lazy" alt="" />
            {favs.has(s.path) && <span className="strip-fav">★</span>}
          </button>
        ))}
      </div>

      {info && (
        <aside className="vs-info">
          <div className="eyebrow">{fmt(shot.taken, { weekday: "long" })}</div>
          <h2>{fmt(shot.taken, { month: "long", day: "numeric", year: "numeric" })}</h2>
          <div className="vs-time">{fmt(shot.taken, { hour: "numeric", minute: "2-digit", second: "2-digit" })}</div>

          <dl>
            <dt>Size</dt>
            <dd>
              {shot.width} × {shot.height} <span>{ratio(shot.width, shot.height)}</span>
            </dd>
            <dt>File</dt>
            <dd>
              {formatBytes(shot.size_bytes)} <span>PNG</span>
            </dd>
            <dt>From</dt>
            <dd>{shot.location === "Shared" ? "Shared folder" : shot.location}</dd>
            <dt>Name</dt>
            <dd className="mono" title={shot.path}>
              {shot.name}
            </dd>
          </dl>

          {colors.length > 0 && (
            <>
              <div className="vs-label">Palette</div>
              <div className="swatches">
                {colors.map((c) => (
                  <button key={c} style={{ background: c }} title={`Copy ${c}`} onClick={() => copyHex(c)}>
                    <span>{c}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="vs-actions">
            <button className="btn" onClick={copy}>Copy image</button>
            <button className="btn" onClick={() => api.revealPath(shot.path, false)}>Open in Preview</button>
            <button className="btn" onClick={() => api.revealPath(shot.path)}>Show in Finder</button>
            <button className={`btn danger ${trashArmed ? "armed" : ""}`} onClick={() => props.onTrash(shot.path)}>
              {trashArmed ? "Click again to trash" : "Move to Trash"}
            </button>
          </div>

          <div className="vs-label">Keys</div>
          <div className="keys">
            {[
              ["← →", "browse"], ["space", "slideshow"], ["1", "actual size"],
              ["+ −", "zoom"], ["F", "favorite"], ["C", "copy"], ["⌫", "trash"], ["esc", "close"],
            ].map(([k, v]) => (
              <span key={k}>
                <kbd>{k}</kbd> {v}
              </span>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
