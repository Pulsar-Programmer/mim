import { CSSProperties, useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, Profile, ProfilesOverview, timeAgo } from "./api";
import { useCached, useConfirm } from "./hooks";

/** "fabric-loader-0.17.2-1.21.10" reads as "Fabric 1.21.10". */
function versionLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id === "latest-release") return "Latest release";
  if (id === "latest-snapshot") return "Latest snapshot";
  const loader = id.match(/^(fabric|quilt)-loader-[^-]+-(.+)$/);
  if (loader) return `${loader[1] === "fabric" ? "Fabric" : "Quilt"} ${loader[2]}`;
  const forge = id.match(/^(.+)-forge-/);
  if (forge) return `Forge ${forge[1]}`;
  const neo = id.match(/^neoforge-(.+)$/);
  return neo ? `NeoForge ${neo[1]}` : id;
}

function folderLabel(p: Profile): string {
  if (p.shares_root) return "Main Minecraft folder";
  const inside = p.game_dir.match(/[\\/]installations[\\/](.+)$/);
  return inside ? `installations/${inside[1].replace(/\\/g, "/")}` : p.game_dir;
}

function playedLabel(iso: string | null): string {
  // the launcher stamps never-played profiles with the 1970 epoch
  return iso && new Date(iso).getTime() > 0 ? `Played ${timeAgo(iso)}` : "Never played";
}

/** What's wrong in plain words. A default profile on the main folder is normal. */
function issueOf(p: Profile): string | null {
  if (p.missing) return "Its game folder is gone. Find where it lives now.";
  if (p.outside) return "Its game folder is outside installations/. Move it to keep everything together.";
  if (p.shares_root && p.kind === "custom") return "It shares the main Minecraft folder, so its mods and saves mix with others.";
  return null;
}

const customImage = (icon?: string | null) => (icon?.startsWith("data:image/") ? icon : null);

/** A steady color per profile for ones without their own image. */
function hueOf(name: string): CSSProperties {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { "--pf-hue": h } as CSSProperties;
}

function ProfileArt({ name, icon, presets }: { name: string; icon?: string | null; presets: Record<string, string> }) {
  const custom = customImage(icon);
  const src = custom ?? (icon ? presets[icon] : undefined);
  return src ? (
    <img className={`pf-art-img${custom ? "" : " block"}`} src={src} alt="" />
  ) : (
    <span className="pf-art-letter" style={hueOf(name)} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function ProfilesView({
  notify,
  onChanged,
}: {
  notify: (m: string) => void;
  onChanged: () => void;
}) {
  const [data, reload] = useCached<ProfilesOverview>("profiles", api.listProfiles, notify);
  const refresh = () => {
    reload();
    onChanged();
  };
  const { armed, confirm } = useConfirm(notify, refresh);
  const locked = data?.launcher_running ?? false;
  const lockedTitle = locked ? "Quit the Minecraft Launcher first" : undefined;

  // coming back after quitting the launcher unlocks the page
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  async function run(f: () => Promise<string>) {
    try {
      notify(await f());
    } catch (e) {
      notify(String(e));
    }
    refresh();
  }

  async function relink(p: Profile) {
    const dir = await openDialog({ directory: true, title: `Game folder for ${p.name}` });
    if (typeof dir !== "string") return;
    run(async () => {
      await api.relinkProfile(p.id, dir);
      return `${p.name} now uses ${dir.split(/[\\/]/).pop()}`;
    });
  }

  async function pickImage(p: Profile) {
    const path = await openDialog({
      title: `Image for ${p.name}`,
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof path !== "string") return;
    run(async () => {
      await api.setProfileIcon(p.id, path);
      return `Updated the image for ${p.name}`;
    });
  }

  const profiles = data?.profiles ?? [];
  const archived = data?.archived ?? [];
  const presets = data?.preset_icons ?? {};
  const attention = profiles.filter(issueOf);
  const ready = profiles.filter((p) => !issueOf(p));

  function row(p: Profile) {
    const issue = issueOf(p);
    const isArmed = armed === `archive:${p.id}`;
    const version = versionLabel(p.version_id ?? (p.kind === "custom" ? null : p.kind));
    const custom = customImage(p.icon);
    const banner = custom ?? (p.icon ? presets[p.icon] : undefined);
    return (
      <li key={p.id} className={`pf-card${issue ? " has-issue" : ""}`} style={hueOf(p.name)}>
        <div className="pf-banner" aria-hidden="true">
          {banner && <img src={banner} alt="" />}
        </div>
        <div className="pf-head">
          <div className="pf-art-wrap">
            <button
              className="pf-art"
              disabled={locked}
              title={lockedTitle ?? "Change image"}
              aria-label={`Change image for ${p.name}`}
              onClick={() => pickImage(p)}
            >
              <ProfileArt name={p.name} icon={p.icon} presets={presets} />
              <span className="pf-art-hint">Change</span>
            </button>
            {custom && (
              <button
                className="pf-art-clear"
                disabled={locked}
                title={lockedTitle ?? "Remove image"}
                aria-label={`Remove image from ${p.name}`}
                onClick={() =>
                  run(async () => {
                    await api.setProfileIcon(p.id, null);
                    return `Removed the image from ${p.name}`;
                  })
                }
              >
                ×
              </button>
            )}
          </div>
          <div className="pf-main">
            <div className="pf-title">
              <span className="pf-name">{p.name}</span>
              {version && <span className="pf-version" title={p.version_id ?? undefined}>{version}</span>}
            </div>
            <div className="pf-meta">
              <span>{playedLabel(p.last_used)}</span>
              {p.missing ? (
                <span className="pf-folder gone" title={p.game_dir}>{folderLabel(p)}</span>
              ) : (
                <button
                  className="pf-folder"
                  title={`Open ${p.game_dir}`}
                  onClick={() => api.revealPath(p.game_dir, false)}
                >
                  {folderLabel(p)}
                </button>
              )}
            </div>
          </div>
        </div>
        {isArmed ? (
          <p className="pf-note">Removes it from the launcher and stores its unshared files. You can restore it anytime.</p>
        ) : (
          issue && <p className="pf-note warn">{issue}</p>
        )}
        <div className="pf-actions">
          {p.outside && !p.missing && (
            <button
              className="pf-btn primary"
              disabled={locked}
              title={lockedTitle}
              onClick={() =>
                run(async () => {
                  const to = await api.moveProfile(p.id);
                  return `Moved to installations/${to.split(/[\\/]/).pop()}`;
                })
              }
            >
              Move to installations
            </button>
          )}
          <button
            className={`pf-btn${p.missing || (issue && p.shares_root) ? " primary" : ""}`}
            disabled={locked}
            title={lockedTitle}
            onClick={() => relink(p)}
          >
            {p.missing ? "Find folder" : "Change folder"}
          </button>
          <button
            className={`pf-btn quiet${isArmed ? " armed" : ""}`}
            disabled={locked}
            title={lockedTitle}
            onClick={() =>
              confirm(`archive:${p.id}`, async () => {
                await api.archiveProfile(p.id);
                return `Archived ${p.name}`;
              })
            }
          >
            {isArmed ? "Confirm archive" : "Archive"}
          </button>
        </div>
      </li>
    );
  }

  return (
    <div className="pf">
      <header className="page-head">
        <div>
          <h1>Launcher Profiles</h1>
          {data && (
            <p className="sub">
              {profiles.length} profile{profiles.length === 1 ? "" : "s"}
              {attention.length > 0
                ? ` · ${attention.length} need${attention.length === 1 ? "s" : ""} attention`
                : profiles.length > 0 && " · all good"}
            </p>
          )}
        </div>
        {data && (
          <button
            className="btn"
            title="Every edit saves a copy of launcher_profiles.json here first"
            onClick={() => api.revealPath(data.backups, false)}
          >
            Open Backups
          </button>
        )}
      </header>

      {locked && (
        <div className="pf-lock" role="status">
          <strong>Minecraft Launcher is open.</strong> Quit it to make changes, or it will overwrite them.
        </div>
      )}

      {attention.length > 0 && (
        <section className="pf-section">
          <h2>Needs attention</h2>
          <ul className="pf-grid">{attention.map(row)}</ul>
        </section>
      )}

      {ready.length > 0 && (
        <section className="pf-section">
          {attention.length > 0 && <h2>Ready to play</h2>}
          <ul className="pf-grid">{ready.map(row)}</ul>
        </section>
      )}

      {data && profiles.length === 0 && <div className="empty">No launcher profiles.</div>}

      {archived.length > 0 && (
        <details className="pf-archive">
          <summary>
            Archived <span>{archived.length}</span>
          </summary>
          <ul className="pf-list">
            {archived.map((a) => {
              const name = a.profile.name || a.id;
              const deleting = armed === `delete:${a.id}`;
              return (
                <li key={a.id} className="pf-row">
                  <span className="pf-art small"><ProfileArt name={name} icon={a.profile.icon} presets={presets} /></span>
                  <div className="pf-main">
                    <div className="pf-title">
                      <span className="pf-name">{name}</span>
                      {a.profile.lastVersionId && (
                        <span className="pf-version">{versionLabel(a.profile.lastVersionId)}</span>
                      )}
                    </div>
                    <div className="pf-meta">
                      <span>Archived {timeAgo(a.archived)}</span>
                      <span title={a.game_dir}>{a.moved_dir ? "Folder stored in archive" : "Folder left in place"}</span>
                    </div>
                    {deleting && (
                      <p className="pf-note">
                        {a.moved_dir
                          ? "Moves the profile and its stored game folder to the Trash."
                          : "Moves the stored profile to the Trash. Its shared folder stays."}
                      </p>
                    )}
                  </div>
                  <div className="pf-actions">
                    <button
                      className="pf-btn"
                      disabled={locked}
                      title={lockedTitle}
                      onClick={() =>
                        run(async () => {
                          await api.restoreProfile(a.id);
                          return `Restored ${name}`;
                        })
                      }
                    >
                      Restore
                    </button>
                    <button
                      className={`pf-btn danger${deleting ? " armed" : ""}`}
                      onClick={() =>
                        confirm(`delete:${a.id}`, async () => {
                          await api.deleteArchivedProfile(a.id);
                          return `Moved ${name} to Trash`;
                        })
                      }
                    >
                      {deleting ? "Confirm delete" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
