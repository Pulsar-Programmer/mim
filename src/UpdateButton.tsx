import { useEffect, useRef, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Bottom-left update control, after T3 Code's sidebar update pill:
// idle (check) → available (download) → downloading (ring) → ready (restart).

type Status = "idle" | "checking" | "available" | "downloading" | "ready";

const R = 14;
const CIRC = 2 * Math.PI * R;
const ICON = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const RefreshIcon = ({ spin }: { spin: boolean }) => (
  <svg {...ICON} className={spin ? "spin" : undefined} aria-hidden>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </svg>
);
const DownloadIcon = () => (
  <svg {...ICON} aria-hidden>
    <path d="M12 15V3" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
  </svg>
);
const RestartIcon = () => (
  <svg {...ICON} aria-hidden>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);

export function UpdateButton({ notify }: { notify: (m: string) => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [percent, setPercent] = useState(0);
  const [armed, setArmed] = useState(false);
  const update = useRef<Update | null>(null);

  async function runCheck(quiet: boolean) {
    setStatus("checking");
    try {
      update.current = await check();
      setStatus(update.current ? "available" : "idle");
      if (!update.current && !quiet) notify("MIM is up to date");
    } catch (e) {
      setStatus("idle");
      if (!quiet) notify(`Could not check for updates: ${e}`);
    }
  }

  useEffect(() => {
    if (import.meta.env.DEV) return; // no release feed for dev builds
    runCheck(true);
    const t = setInterval(() => runCheck(true), 4 * 60 * 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function download() {
    const u = update.current!;
    setStatus("downloading");
    setPercent(0);
    let total = 0;
    let got = 0;
    try {
      await u.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress" && total) setPercent(Math.min(100, ((got += e.data.chunkLength) / total) * 100));
      });
      setStatus("ready");
      notify(`MIM ${u.version} is installed — restart to finish`);
    } catch (e) {
      setStatus("available");
      notify(`Could not download update: ${e}`);
    }
  }

  async function onClick() {
    if (status === "idle") return runCheck(false);
    if (status === "available") return download();
    if (status === "ready") {
      // two-click confirm, like the rest of MIM
      if (!armed) {
        setArmed(true);
        setTimeout(() => setArmed(false), 3000);
        return;
      }
      await relaunch();
    }
  }

  const version = update.current?.version;
  const tooltip = {
    idle: "Check for updates",
    checking: "Checking for updates…",
    available: `Update available: MIM ${version} — click to download and install`,
    downloading: `Downloading MIM ${version}… ${Math.round(percent)}%`,
    ready: armed ? "Click again to restart" : `MIM ${version} installed — click to restart`,
  }[status];
  const busy = status === "checking" || status === "downloading";

  return (
    <button
      type="button"
      className={`update-btn ${status !== "idle" && status !== "checking" ? "has-update" : ""} ${armed ? "armed" : ""}`}
      title={tooltip}
      aria-label={tooltip}
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : onClick}
    >
      {status === "available" && (
        <span className="update-icon">
          <DownloadIcon />
          <span className="update-dot" aria-hidden />
        </span>
      )}
      {status === "downloading" && (
        <span className="update-ring">
          <svg viewBox="0 0 32 32" aria-hidden>
            <circle cx="16" cy="16" r={R} className="track" />
            <circle cx="16" cy="16" r={R} strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - percent / 100)} />
          </svg>
          <DownloadIcon />
        </span>
      )}
      {status === "ready" && (
        <span className="update-icon">
          <RestartIcon />
          <span className="update-check" aria-hidden>
            <svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
        </span>
      )}
      {(status === "idle" || status === "checking") && <RefreshIcon spin={status === "checking"} />}
    </button>
  );
}
