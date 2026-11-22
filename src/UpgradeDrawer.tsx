import { useEffect, useMemo, useState } from "react";
import { api, ImportReport, Installation, UpgradeMod, UpgradeScan, UpgradeTarget } from "./api";
import { Avatar } from "./Places";
import { ProgressBar, useProgress } from "./Progress";
import { brief } from "./settings";

const LOADER: Record<string, string> = { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge" };

const fits = (t: UpgradeTarget) => t.loader_ok && t.missing.length === 0;

/** The newest version every mod has a build for, else the one that loses the fewest. */
function bestTarget(targets: UpgradeTarget[]) {
  const ok = targets.filter((t) => t.loader_ok);
  return ok.find(fits) ?? [...ok].sort((a, b) => a.missing.length - b.missing.length)[0];
}

/** Moves one installation, loader and mods, to a newer Minecraft. */
export function UpgradeDrawer({
  inst,
  notify,
  onChanged,
  onClose,
}: {
  inst: Installation;
  notify: (m: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [scan, setScan] = useState<UpgradeScan | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  /** files the user chose to keep even though they can't be updated */
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ r: ImportReport; kept: number } | null>(null);
  const progress = useProgress(!scan || busy);

  useEffect(() => {
    api
      .scanUpgrade(inst.name)
      .then((s) => {
        setScan(s);
        setPick(bestTarget(s.targets)?.game ?? null);
      })
      .catch((e) => setFailed(String(e)));
  }, [inst.name]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, busy]);

  const target = scan?.targets.find((t) => t.game === pick);
  const best = scan && bestTarget(scan.targets);
  const loaderName = LOADER[scan?.loader ?? ""] ?? scan?.loader;

  const groups = useMemo(() => {
    if (!scan || !target) return null;
    const missing = new Set(target.missing);
    return {
      updates: scan.mods.filter((m) => m.known && !missing.has(m.file)),
      noBuild: scan.mods.filter((m) => missing.has(m.file)),
      unknown: scan.mods.filter((m) => !m.known),
    };
  }, [scan, target]);

  const stuck = groups ? [...groups.noBuild, ...groups.unknown] : [];
  const remove = stuck.filter((m) => !keep.has(m.file)).map((m) => m.file);

  async function upgrade() {
    if (!target) return;
    setBusy(true);
    try {
      const r = await api.upgradeInstallation(inst.name, target.game, remove);
      setDone({ r, kept: stuck.length - remove.length });
      onChanged();
    } catch (e) {
      notify(String(e));
    }
    setBusy(false);
  }

  const toggleKeep = (file: string) =>
    setKeep((k) => {
      const n = new Set(k);
      if (!n.delete(file)) n.add(file);
      return n;
    });

  const stuckList = (title: string, why: string, mods: UpgradeMod[]) =>
    mods.length > 0 && (
      <div className="up-group">
        <h3 className="drawer-h">
          {title} <span className="count">{mods.length}</span>
        </h3>
        <p className="hint">{brief(why)}</p>
        <ul className="up-mods">
          {mods.map((m) => {
            const kept = keep.has(m.file);
            return (
              <li key={m.file} className={kept ? "" : "gone"}>
                <ModIcon m={m} />
                <span className="up-mod-name" title={m.file}>
                  {m.name}
                </span>
                <button className={`btn small ${kept ? "" : "danger"}`} disabled={busy} onClick={() => toggleKeep(m.file)}>
                  {kept ? "Keep anyway" : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );

  return (
    <div className="viewer-backdrop drawer-backdrop" onClick={() => !busy && onClose()}>
      <aside className="drawer up-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-hero">
          <Avatar inst={inst} />
          <div className="links-title">
            <h2 className="drawer-title">Upgrade {inst.name}</h2>
            <span className="place-sub">
              {[inst.game_version, inst.loader].filter(Boolean).join(" · ")}
              {inst.mods_count > 0 && ` · ${inst.mods_count} mods`}
            </span>
          </div>
          <button className="linklike drawer-close" disabled={busy} onClick={onClose}>
            close
          </button>
        </div>

        {done ? (
          <div className="lw-done">
            <div className="lw-done-mark">✓</div>
            <h2>Now on {done.r.title}</h2>
            <ul>
              <li>{done.r.added.length} mods updated</li>
              {done.r.skipped.length > 0 && <li>{done.r.skipped.length} removed to the Trash</li>}
              {done.kept > 0 && <li>{done.kept} kept without an update</li>}
            </ul>
            <div className="row-inline lw-done-actions">
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : failed ? (
          <p className="hint links-intro">{failed}</p>
        ) : !scan ? (
          <div className="links-intro">
            <ProgressBar p={progress} fallback="Checking your mods…" />
          </div>
        ) : scan.targets.length === 0 ? (
          <p className="hint links-intro">{inst.name} is already on the newest Minecraft release.</p>
        ) : (
          <>
            <p className="hint links-intro">
              {best && fits(best)
                ? `${best.game} is the newest version every mod is ready for.`
                : `No newer version has a build of every mod yet.`}
              <span className="more">
                {" "}
                Each mod is checked against Modrinth for {loaderName} on every newer release. Turned-off mods are left as they
                are.
              </span>
            </p>

            <div className={`up-versions ${busy ? "busy" : ""}`}>
              {scan.targets.map((t) => (
                <button
                  key={t.game}
                  className={`up-version ${t.game === pick ? "on" : ""}`}
                  disabled={!t.loader_ok}
                  onClick={() => setPick(t.game)}
                >
                  <code>{t.game}</code>
                  {t === best && fits(t) && <span className="chip up-best">best fit</span>}
                  <span className={`up-status ${fits(t) ? "ok" : ""}`}>
                    {!t.loader_ok
                      ? `no ${loaderName} yet`
                      : t.missing.length === 0
                        ? "every mod ready"
                        : `${t.missing.length} mod${t.missing.length === 1 ? "" : "s"} not ready`}
                  </span>
                </button>
              ))}
            </div>

            {target && groups && (
              <>
                {groups.updates.length > 0 && (
                  <details className="up-group">
                    <summary className="drawer-h">
                      Updates to {target.game} <span className="count">{groups.updates.length}</span>
                    </summary>
                    <ul className="up-mods">
                      {groups.updates.map((m) => (
                        <li key={m.file}>
                          <ModIcon m={m} />
                          <span className="up-mod-name" title={m.file}>
                            {m.name}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {stuckList(
                  `No ${target.game} build`,
                  `These would likely crash ${target.game}. Removed ones go to the Trash; pick an older version above to keep them.`,
                  groups.noBuild,
                )}
                {stuckList(
                  "Not on Modrinth",
                  "MIM can't check or update these. Keep one only if you know it works on " + target.game + ".",
                  groups.unknown,
                )}
              </>
            )}

            <div className="up-foot">
              {busy ? (
                <ProgressBar p={progress} fallback={`Upgrading to ${pick}…`} />
              ) : (
                <>
                  <span className="lw-foot-sum">
                    {target && groups
                      ? [
                          `${groups.updates.length} update`,
                          remove.length && `${remove.length} to Trash`,
                          stuck.length - remove.length && `${stuck.length - remove.length} kept`,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "Pick a version"}
                  </span>
                  <button className="btn ghost" onClick={onClose}>
                    Cancel
                  </button>
                  <button className="btn primary" disabled={!target} onClick={upgrade}>
                    Upgrade to {pick ?? "…"}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function ModIcon({ m }: { m: UpgradeMod }) {
  return m.icon ? (
    <span className="up-icon" style={{ backgroundImage: `url(${m.icon})` }} />
  ) : (
    <span className="up-icon">{m.name[0]}</span>
  );
}
