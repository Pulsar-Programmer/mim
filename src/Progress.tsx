import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export interface ProgressMsg {
  done: number;
  /** 0 while the amount of work isn't known yet */
  total: number;
  label: string;
}

/** Follows the backend's "progress" events while `active`. */
export function useProgress(active: boolean) {
  const [p, setP] = useState<ProgressMsg | null>(null);
  useEffect(() => {
    if (!active) return setP(null);
    const off = listen<ProgressMsg>("progress", (e) => setP(e.payload));
    return () => void off.then((f) => f());
  }, [active]);
  return p;
}

/** A bar that fills as work lands; stripes while the total isn't known. */
export function ProgressBar({ p, fallback }: { p: ProgressMsg | null; fallback: string }) {
  const known = !!p && p.total > 0;
  const pct = known ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={known ? pct : undefined}>
      <div className={`progress-track ${known ? "" : "busy"}`}>
        <div className="progress-fill" style={known ? { width: `${pct}%` } : undefined} />
      </div>
      <div className="progress-text">
        <span className="progress-label">{p?.label || fallback}</span>
        {known && (
          <span className="progress-count">
            {p.done} / {p.total}
          </span>
        )}
      </div>
    </div>
  );
}
