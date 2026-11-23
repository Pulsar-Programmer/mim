import { useEffect, useRef, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Bottom-left update control, after T3 Code's sidebar update pill:
// idle (check) → available (download) → downloading → installing → ready (restart).

type Status = "idle" | "checking" | "available" | "downloading" | "installing" | "ready";

const R = 6.5;
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

// value is 0-100; null means unknown, so a short arc spins instead
const Ring = ({ value }: { value: number | null }) => (
  <svg className={`update-ring ${value === null ? "spin" : ""}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <circle cx="8" cy="8" r={R} className="track" />
    <circle
      cx="8"
      cy="8"
      r={R}
      transform="rotate(-90 8 8)"
      strokeDasharray={CIRC}
      strokeDashoffset={CIRC * (1 - (value ?? 25) / 100)}
    />
  </svg>
);

export function UpdateButton({ notify }: { notify: (m: string) => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [percent, setPercent] = useState<number | null>(0);
  const [armed, setArmed] = useState(false);
  const update = useRef<Update | null>(null);
  const pending = useRef<Promise<Update | null> | null>(null);
  const statusNow = useRef(status);
  statusNow.current = status;

  // Background checks stay invisible unless they find something.
  async function runCheck(quiet: boolean) {
    if (!quiet) setStatus("checking");
    try {
      const found = await (pending.current ??= check().finally(() => (pending.current = null)));
      update.current = found;
      if (found) setStatus("available");
      else if (!quiet) {
        setStatus("idle");
        notify("MIM is up to date");
      }
    } catch (e) {
      if (quiet) return;
      setStatus("idle");
      notify(`Could not check for updates: ${e}`);
    }
  }

  useEffect(() => {
    if (import.meta.env.DEV) return; // no release feed for dev builds
    const background = () => {
      // never disturb an offered, running, or installed update
      if (statusNow.current === "idle") runCheck(true);
    };
    background();
    const t = setInterval(background, 4 * 60 * 60 * 1000);
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
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
          setPercent(total ? 0 : null);
        }
        if (e.event === "Progress" && total) setPercent(Math.min(100, ((got += e.data.chunkLength) / total) * 100));
        if (e.event === "Finished") setStatus("installing");
      });
      setStatus("ready");
      notify(`MIM ${u.version} is installed. Restart to finish.`);
    } catch (e) {
      setStatus("available");
      notify(`Could not install update: ${e}`);
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
      try {
        await relaunch();
      } catch (e) {
        setArmed(false);
        notify(`Could not restart: ${e}`);
      }
    }
  }

  const version = update.current?.version;
  const pct = percent === null ? null : Math.round(percent);
  const tooltip = {
    idle: "Check for updates",
    checking: "Checking for updates…",
    available: `Update available: MIM ${version}. Click to download and install.`,
    downloading: `Downloading MIM ${version}${pct === null ? "…" : `: ${pct}%`}`,
    installing: `Installing MIM ${version}…`,
    ready: armed ? "Click again to restart" : `MIM ${version} installed. Click to restart.`,
  }[status];
  const label = {
    idle: null,
    checking: null,
    available: "Update",
    downloading: pct === null ? "Downloading" : `${pct}%`,
    installing: "Installing",
    ready: armed ? "Confirm" : "Restart",
  }[status];
  const busy = status === "checking" || status === "downloading" || status === "installing";

  return (
    <button
      type="button"
      className={`update-btn ${label ? "has-update" : ""} ${armed ? "armed" : ""}`}
      title={tooltip}
      aria-label={tooltip}
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : onClick}
    >
      {(status === "idle" || status === "checking") && <RefreshIcon spin={status === "checking"} />}
      {status === "available" && <DownloadIcon />}
      {status === "downloading" && <Ring value={percent} />}
      {status === "installing" && <Ring value={null} />}
      {status === "ready" && <RestartIcon />}
      {label && <span className="update-label">{label}</span>}
    </button>
  );
}
