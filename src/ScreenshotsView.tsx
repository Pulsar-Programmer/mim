import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, formatBytes, Installation, Screenshot } from "./api";
import { PlacePicker, sharedPlaces } from "./Places";
import { useCached, useConfirm } from "./hooks";

const month = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : "Undated";

export function ScreenshotsView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [shots = [], reload] = useCached<Screenshot[]>(
    "screenshots",
    api.listScreenshots,
    notify
  );
  const [location, setLocation] = useState("all");
  const [open, setOpen] = useState<number | null>(null);
  const { armed, confirm } = useConfirm(notify, () => {
    setOpen(null);
    reload();
  });

  const shown = shots.filter((s) => location === "all" || s.location === location);
  const locations = [...new Set(shots.map((s) => s.location))];
  const groups = useMemo(() => {
    const map = new Map<string, { shot: Screenshot; index: number }[]>();
    shown.forEach((shot, index) => {
      const m = month(shot.modified);
      if (!map.has(m)) map.set(m, []);
      map.get(m)!.push({ shot, index });
    });
    return [...map.entries()];
  }, [shown]);

  const current = open != null ? shown[open] : null;

  useEffect(() => {
    if (open == null) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowRight") setOpen((i) => Math.min((i ?? 0) + 1, shown.length - 1));
      if (e.key === "ArrowLeft") setOpen((i) => Math.max((i ?? 0) - 1, 0));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, shown.length]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Screenshots</h1>
          <p className="sub">
            {shots.length} screenshot{shots.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(shots.reduce((n, s) => n + s.size_bytes, 0))}
          </p>
        </div>
      </header>

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

      {groups.map(([m, items]) => (
        <section key={m}>
          <h3 className="shot-month">{m}</h3>
          <div className="shot-grid">
            {items.map(({ shot, index }) => (
              <button key={shot.path} className="shot" onClick={() => setOpen(index)}>
                <img src={convertFileSrc(shot.path)} loading="lazy" decoding="async" alt={shot.name} />
              </button>
            ))}
          </div>
        </section>
      ))}
      {shots.length === 0 && <div className="empty">No screenshots yet — press F2 in game.</div>}

      {current && (
        <div className="viewer-backdrop lightbox" onClick={() => setOpen(null)}>
          <img
            src={convertFileSrc(current.path)}
            alt={current.name}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <button className="linklike" disabled={open === 0} onClick={() => setOpen(open! - 1)}>
              ←
            </button>
            <span className="lightbox-name">{current.name}</span>
            <span className="hint">
              {current.modified && new Date(current.modified).toLocaleString()} ·{" "}
              {formatBytes(current.size_bytes)}
              {current.location !== "Shared" && ` · ${current.location}`}
            </span>
            <button className="linklike" onClick={() => api.revealPath(current.path)}>
              reveal
            </button>
            <button
              className="linklike danger-link"
              onClick={() =>
                confirm(current.path, async () => {
                  await api.trashItem(current.path);
                  return "Moved screenshot to Trash";
                })
              }
            >
              {armed === current.path ? "sure?" : "delete"}
            </button>
            <button
              className="linklike"
              disabled={open === shown.length - 1}
              onClick={() => setOpen(open! + 1)}
            >
              →
            </button>
          </div>
        </div>
      )}
    </>
  );
}
