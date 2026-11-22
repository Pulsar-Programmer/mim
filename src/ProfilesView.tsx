import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, Profile, ProfilesOverview, timeAgo } from "./api";
import { useCached, useConfirm } from "./hooks";

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

  const profiles = data?.profiles ?? [];
  const archived = data?.archived ?? [];
  const flagged = profiles.filter((p) => p.shares_root || p.outside || p.missing).length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Launcher Profiles</h1>
          <p className="sub">
            {profiles.length} profile{profiles.length === 1 ? "" : "s"}
            {flagged > 0 && ` · ${flagged} flagged`}
            {archived.length > 0 && ` · ${archived.length} archived`}
          </p>
        </div>
        {data && (
          <button className="btn" onClick={() => api.revealPath(data.backups, false)}>
            Open Backups
          </button>
        )}
      </header>

      <p className="hint wide">
        {locked ? (
          <strong>The Minecraft Launcher is open. Quit it before editing, or it will overwrite your changes.</strong>
        ) : (
          <>
            Every edit backs up <code>launcher_profiles.json</code> first.<span className="more"> Archiving moves the
            profile, its own folder and its unused version files into <code>.mim/archive</code>,
            and Restore puts them back. Folders other profiles share stay where they are.</span>
          </>
        )}
      </p>

      <ul className="mod-list">
        {profiles.map((p) => (
          <li key={p.id} className="mod">
            <div className="mod-main">
              <div className="mod-top">
                <span className="mod-name">{p.name}</span>
                {p.version_id && <code>{p.version_id}</code>}
                {p.kind !== "custom" && <span className="chip">{p.kind}</span>}
                {p.shares_root && (
                  <span className="chip flag-warn" title="Its game folder is the Minecraft folder itself">
                    shares root
                  </span>
                )}
                {p.outside && !p.missing && (
                  <span className="chip flag-warn" title="Its game folder isn't in installations/">
                    outside installations/
                  </span>
                )}
                {p.missing && <span className="chip flag-bad">folder missing</span>}
              </div>
              <div className="mod-meta">
                <code title="Profile ID">{p.id.slice(0, 8)}</code>
                <span>{p.last_used ? `used ${timeAgo(p.last_used)}` : "never used"}</span>
                <span
                  className="mod-file copyable"
                  title={p.missing ? p.game_dir : "Show in Finder"}
                  onClick={() => !p.missing && api.revealPath(p.game_dir, false)}
                >
                  {p.game_dir}
                </span>
              </div>
            </div>
            <div className="server-actions">
              <button disabled={locked} onClick={() => relink(p)}>
                Re-link
              </button>
              {p.outside && !p.missing && (
                <button
                  disabled={locked}
                  onClick={() =>
                    run(async () => {
                      const to = await api.moveProfile(p.id);
                      return `Moved to installations/${to.split(/[\\/]/).pop()}`;
                    })
                  }
                >
                  Move into installations/
                </button>
              )}
              <button
                className="danger"
                disabled={locked}
                onClick={() =>
                  confirm(`archive:${p.id}`, async () => {
                    await api.archiveProfile(p.id);
                    return `Archived ${p.name}`;
                  })
                }
              >
                {armed === `archive:${p.id}` ? "Sure?" : "Archive"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {data && profiles.length === 0 && <div className="empty">No launcher profiles.</div>}

      {archived.length > 0 && (
        <section className="backup">
          <h2 className="backup-head">Archived</h2>
          <ul className="mod-list">
            {archived.map((a) => (
              <li key={a.id} className="mod off">
                <div className="mod-main">
                  <div className="mod-top">
                    <span className="mod-name">{a.profile.name || a.id}</span>
                    {a.profile.lastVersionId && <code>{a.profile.lastVersionId}</code>}
                  </div>
                  <div className="mod-meta">
                    <span>archived {timeAgo(a.archived)}</span>
                    <span className="mod-file" title={a.game_dir}>
                      {a.moved_dir ? "folder archived" : "folder left in place"} · {a.game_dir}
                    </span>
                    {a.versions.length > 0 && <span>+ {a.versions.join(", ")}</span>}
                  </div>
                </div>
                <div className="server-actions">
                  <button
                    disabled={locked}
                    onClick={() =>
                      run(async () => {
                        await api.restoreProfile(a.id);
                        return `Restored ${a.profile.name || a.id}`;
                      })
                    }
                  >
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
