import { useEffect, useState } from "react";
import { api, Installation, Ping, Server, ServerList } from "./api";
import { PlacePicker } from "./Places";
import { brief } from "./settings";
import { useCached } from "./hooks";

// pings survive view switches; refresh re-pings
const pings = new Map<string, Ping | "offline">();

function iconSrc(s: Server, ping?: Ping | "offline"): string | null {
  if (ping && ping !== "offline" && ping.favicon) return ping.favicon;
  return s.icon ? `data:image/png;base64,${s.icon}` : null;
}

function Bars({ ms }: { ms: number }) {
  const level = ms < 80 ? 5 : ms < 150 ? 4 : ms < 250 ? 3 : ms < 500 ? 2 : 1;
  return (
    <span className="bars" title={`${ms} ms`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= level ? "on" : ""} style={{ height: 3 + i * 2 }} />
      ))}
    </span>
  );
}

const same = (a: Server, b: Server) => a.ip.trim().toLowerCase() === b.ip.trim().toLowerCase();

export function ServersView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [lists = [], reload] = useCached<ServerList[]>("servers", api.listServers, notify);
  const [selected, setSelected] = useState<string | null>(null);
  const [, bump] = useState(0);
  const [form, setForm] = useState<{ index: number | null; name: string; ip: string } | null>(
    null
  );
  const [showBackup, setShowBackup] = useState(false);

  const list = lists.find((l) => l.label === selected) ?? lists[0];

  function pingAll(force = false) {
    for (const s of list?.servers ?? []) {
      if (!force && pings.has(s.ip)) continue;
      pings.delete(s.ip);
      api
        .pingServer(s.ip)
        .then((p) => pings.set(s.ip, p))
        .catch(() => pings.set(s.ip, "offline"))
        .finally(() => bump((n) => n + 1));
    }
    bump((n) => n + 1);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => pingAll(), [list?.path, list?.servers.length]);

  async function save(servers: Server[], msg: string, target = list) {
    if (!target) return;
    try {
      await api.writeServers(target.installation, servers);
      notify(msg);
      reload();
    } catch (e) {
      notify(String(e));
    }
  }

  function submitForm() {
    if (!form || !list) return;
    const entry: Server = {
      name: form.name.trim() || "Minecraft Server",
      ip: form.ip.trim(),
      icon: form.index != null ? list.servers[form.index].icon : null,
      accept_textures: form.index != null ? list.servers[form.index].accept_textures : null,
      hidden: false,
    };
    if (!entry.ip) return notify("Give it an address");
    const next = [...list.servers];
    if (form.index == null) next.push(entry);
    else next[form.index] = entry;
    setForm(null);
    save(next, form.index == null ? `Added ${entry.name}` : `Updated ${entry.name}`);
  }

  function move(i: number, d: -1 | 1) {
    if (!list) return;
    const next = [...list.servers];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    save(next, "Reordered");
  }

  function copyTo(s: Server, label: string) {
    const target = lists.find((l) => l.label === label);
    if (!target) return;
    if (target.servers.some((t) => same(t, s))) return notify(`${label} already has ${s.name}`);
    save([...target.servers, s], `Copied ${s.name} to ${label}`, target);
  }

  const backupOnly = list ? list.backup.filter((b) => !list.servers.some((s) => same(s, b))) : [];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Servers</h1>
          <p className="sub">servers.dat, per game folder</p>
        </div>
        <div className="row-inline">
          <button className="btn" onClick={() => pingAll(true)}>
            Refresh
          </button>
          <button className="btn primary" onClick={() => setForm({ index: null, name: "", ip: "" })}>
            + Add Server
          </button>
        </div>
      </header>

      <p className="hint wide">
            Each game folder has its own server list.<span className="more"> Every time Minecraft saves it, the
            previous list is kept as <code>servers.dat_old</code>.</span>
          </p>

      <PlacePicker
        places={lists.map((l) => ({
          key: l.label,
          label: l.installation == null ? "Minecraft folder" : l.label,
          kind: l.installation == null ? ("root" as const) : undefined,
          inst: installations.find((i) => i.name === l.installation),
          sub: l.exists
            ? `${l.servers.length} server${l.servers.length === 1 ? "" : "s"}`
            : "no servers.dat yet",
        }))}
        value={list?.label ?? ""}
        onChange={(k) => {
          setSelected(k);
          setForm(null);
        }}
      />
      <div className="options-layout">

        <section className="options-editor">
          {form && (
            <div className="server-form">
              <input
                className="search"
                placeholder="Server name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                autoFocus
              />
              <input
                className="search mono"
                placeholder="play.example.net:25565"
                value={form.ip}
                onChange={(e) => setForm({ ...form, ip: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && submitForm()}
              />
              <button className="btn primary" onClick={submitForm}>
                {form.index == null ? "Add" : "Save"}
              </button>
              <button className="linklike" onClick={() => setForm(null)}>
                cancel
              </button>
            </div>
          )}

          <ul className="server-list">
            {list?.servers.map((s, i) => {
              const p = pings.get(s.ip);
              const icon = iconSrc(s, p);
              return (
                <li key={`${s.ip}-${i}`} className="server">
                  <div className="server-icon" style={icon ? { backgroundImage: `url(${icon})` } : undefined}>
                    {!icon && s.name[0]}
                  </div>
                  <div className="server-main">
                    <div className="server-top">
                      <span className="server-name">{s.name}</span>
                      {s.hidden && <span className="chip">hidden</span>}
                      <span className="server-status">
                        {p === undefined ? (
                          <span className="hint">pinging…</span>
                        ) : p === "offline" ? (
                          <span className="offline">can't reach</span>
                        ) : (
                          <>
                            <span className="players">
                              {p.online}/{p.max}
                            </span>
                            <Bars ms={p.latency_ms} />
                          </>
                        )}
                      </span>
                    </div>
                    <div className="server-motd">
                      {p && p !== "offline" ? p.motd || " " : <code>{s.ip}</code>}
                    </div>
                    <div className="server-meta">
                      <code
                        className="copyable"
                        title="Copy address"
                        onClick={() => navigator.clipboard.writeText(s.ip).then(() => notify("Address copied"))}
                      >
                        {s.ip}
                      </code>
                      {p && p !== "offline" && p.version && <span>{p.version}</span>}
                    </div>
                  </div>
                  <div className="server-actions">
                    <button disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                      ↑
                    </button>
                    <button
                      disabled={i === list.servers.length - 1}
                      onClick={() => move(i, 1)}
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button onClick={() => setForm({ index: i, name: s.name, ip: s.ip })}>Edit</button>
                    {lists.length > 1 && (
                      <select
                        value=""
                        onChange={(e) => e.target.value && copyTo(s, e.target.value)}
                        title="Copy to another installation"
                      >
                        <option value="">Copy to…</option>
                        {lists
                          .filter((l) => l.path !== list.path)
                          .map((l) => (
                            <option key={l.path} value={l.label}>
                              {l.label}
                            </option>
                          ))}
                      </select>
                    )}
                    <button
                      className="danger"
                      onClick={() =>
                        save(
                          list.servers.filter((_, j) => j !== i),
                          brief(`Removed ${s.name} — it's still in the backup`)
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {list && list.servers.length === 0 && (
            <div className="empty">No servers here yet. Add one above.</div>
          )}

          {list && list.backup.length > 0 && (
            <div className="backup">
              <button className="backup-head" onClick={() => setShowBackup(!showBackup)}>
                <span className={`chevron ${showBackup ? "turned" : ""}`}>›</span>
                Backup <code>servers.dat_old</code>
                <span className="folder-count">
                  {list.backup.length} servers
                  {backupOnly.length > 0 && ` · ${backupOnly.length} not in current list`}
                </span>
              </button>
              {showBackup && (
                <>
                  <ul className="pack-list">
                    {list.backup.map((b, i) => {
                      const missing = backupOnly.includes(b);
                      return (
                        <li key={`${b.ip}-${i}`} className={missing ? "backup-missing" : ""}>
                          <span className="pack-name">
                            {b.name} <code>{b.ip}</code>
                          </span>
                          {missing ? (
                            <button
                              className="linklike"
                              onClick={() => save([...list.servers, b], `Restored ${b.name}`)}
                            >
                              restore
                            </button>
                          ) : (
                            <span className="hint">in current list</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    className="btn small backup-restore"
                    onClick={async () => {
                      try {
                        await api.restoreServersBackup(list.installation);
                        notify(brief("Swapped in the backup — the current list is now the backup"));
                        reload();
                      } catch (e) {
                        notify(String(e));
                      }
                    }}
                  >
                    Restore whole backup
                  </button>
                </>
              )}
            </div>
          )}

          <p className="hint wide folder-foot">
            Close Minecraft before editing, or it'll save its own copy over yours.
          </p>
        </section>
      </div>
    </>
  );
}
