import { PointerEvent as RPointerEvent, useEffect, useRef, useState } from "react";
import { api, Installation, Ping, Server, ServerList, Standard } from "./api";
import { instancePlaces, PlacePicker } from "./Places";
import { brief } from "./settings";
import { useCached, useConfirm } from "./hooks";

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

function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Rows keep their identity through a reorder, even with duplicate addresses. */
function rowKeys(servers: Server[]): string[] {
  const seen = new Map<string, number>();
  return servers.map((s) => {
    const n = seen.get(s.ip) ?? 0;
    seen.set(s.ip, n + 1);
    return `${s.ip}#${n}`;
  });
}

type Drag = { from: number; to: number; dy: number; height: number };

function rowShift(i: number, d: Drag): number {
  if (i === d.from) return d.dy;
  if (d.from < i && i <= d.to) return -d.height;
  if (d.to <= i && i < d.from) return d.height;
  return 0;
}

export function ServersView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [lists = [], reload] = useCached<ServerList[]>("servers", api.listServers, notify);
  const [selected, setSelected] = useState<string>();
  const [, bump] = useState(0);
  const [form, setForm] = useState<{ index: number | null; name: string; ip: string } | null>(
    null
  );
  const [drag, setDrag] = useState<Drag | null>(null);
  // shows a reorder immediately, until the saved list comes back
  const [pending, setPending] = useState<{ path: string; servers: Server[] } | null>(null);
  const saving = useRef(0);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const listEl = useRef<HTMLUListElement>(null);
  const refocus = useRef<number | null>(null);

  const [standards = [], reloadStandards] = useCached<Standard[]>("standards", api.listStandards, notify);
  const keyOf = (l: ServerList) => l.installation ?? "";
  const places = instancePlaces("servers.dat", installations, standards, (i) => {
    const n = lists.find((l) => l.installation === i.name)?.servers.length ?? 0;
    return `${n} server${n === 1 ? "" : "s"}`;
  });
  const section = places.find((p) => p.key === selected || p.members?.some((m) => m.name === selected)) ?? places[0];
  const list = lists.find((l) => keyOf(l) === section.key);
  const sharers = (section.members ?? []).map((m) => m.name);
  const nameOf = (l: ServerList) => places.find((p) => p.key === keyOf(l))?.label ?? l.label;
  const others = lists.filter((l) => l !== list && places.some((p) => p.key === keyOf(l)));
  const servers = pending && pending.path === list?.path ? pending.servers : (list?.servers ?? []);
  const keys = rowKeys(servers);
  const { armed, confirm } = useConfirm(notify, reload);

  useEffect(() => {
    if (saving.current === 0) setPending(null);
  }, [lists]);

  useEffect(() => {
    if (refocus.current == null) return;
    listEl.current?.querySelectorAll<HTMLElement>(".server-grip")[refocus.current]?.focus();
    refocus.current = null;
  }, [servers]);

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

  async function save(next: Server[], msg: string, target = list) {
    if (!target) return;
    saving.current++;
    // one at a time, so quick drags can't land out of order
    const write = writes.current.then(() => api.writeServers(target.installation, next));
    writes.current = write.catch(() => {});
    try {
      await write;
      notify(msg);
    } catch (e) {
      setPending(null);
      notify(String(e));
    } finally {
      saving.current--;
      reload();
      reloadStandards();
    }
  }

  function reorder(from: number, to: number) {
    if (!list || from === to) return;
    const next = moved(servers, from, to);
    setForm(null);
    setPending({ path: list.path, servers: next });
    save(next, "Reordered");
  }

  async function setArchived(s: Server, archived: boolean) {
    if (!list) return;
    setForm(null);
    try {
      await writes.current;
      await api.setServerArchived(list.installation, s, archived);
      notify(archived ? `Archived ${s.name}` : `Restored ${s.name}`);
    } catch (e) {
      notify(String(e));
    }
    reload();
    reloadStandards();
  }

  function startDrag(e: RPointerEvent<HTMLLIElement>, from: number) {
    if (e.button !== 0 || (e.target as Element).closest("button:not(.server-grip), select, code")) return;
    const rows = Array.from(listEl.current?.children ?? []) as HTMLElement[];
    const scroller = listEl.current?.closest<HTMLElement>(".content");
    if (rows.length < 2 || !scroller) return;
    const boxes = rows.map((r) => r.getBoundingClientRect());
    const mids = boxes.map((b) => b.top + b.height / 2);
    const minDy = boxes[0].top - boxes[from].top;
    const maxDy = boxes[boxes.length - 1].bottom - boxes[from].bottom;
    const startY = e.clientY;
    const startScroll = scroller.scrollTop;
    let y = startY;
    let to = from;
    let frame = 0;

    const tick = () => {
      const edge = scroller.getBoundingClientRect();
      if (y < edge.top + 48) scroller.scrollTop -= 8;
      else if (y > edge.bottom - 48) scroller.scrollTop += 8;
      const dy = Math.min(maxDy, Math.max(minDy, y - startY + scroller.scrollTop - startScroll));
      const center = mids[from] + dy;
      // rows differ in height, so a row pinned to either end must still take that slot
      to = dy >= maxDy ? rows.length - 1 : dy <= minDy ? 0 : mids.filter((m, i) => i !== from && m < center).length;
      setDrag({ from, to, dy, height: boxes[from].height });
      frame = requestAnimationFrame(tick);
    };
    const onMove = (ev: PointerEvent) => {
      y = ev.clientY;
      if (!frame && Math.abs(y - startY) > 4) frame = requestAnimationFrame(tick);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
      setDrag(null);
      if (commit && frame) reorder(from, to);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  }

  function submitForm() {
    if (!form || !list) return;
    const entry: Server = {
      name: form.name.trim() || "Minecraft Server",
      ip: form.ip.trim(),
      icon: form.index != null ? servers[form.index].icon : null,
      accept_textures: form.index != null ? servers[form.index].accept_textures : null,
      hidden: false,
    };
    if (!entry.ip) return notify("Give it an address");
    const next = [...servers];
    if (form.index == null) next.push(entry);
    else next[form.index] = entry;
    setForm(null);
    save(next, form.index == null ? `Added ${entry.name}` : `Updated ${entry.name}`);
  }

  function copyTo(s: Server, key: string) {
    const target = lists.find((l) => keyOf(l) === key);
    if (!target) return;
    const name = nameOf(target);
    if (target.servers.some((t) => same(t, s))) return notify(`${name} already has ${s.name}`);
    save([...target.servers, s], `Copied ${s.name} to ${name}`, target);
  }

  const backupOnly = list
    ? list.backup.filter((b) => ![...servers, ...list.archived].some((s) => same(s, b)))
    : [];

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

      <PlacePicker
        places={places}
        value={section.key}
        onChange={(k) => {
          setSelected(k);
          setForm(null);
        }}
      />
      <div className="options-layout">

        <section className="options-editor">
          {sharers.length > 0 && (
            <p className="hint">
              Used by <b>{sharers.join(", ")}</b> — changes here apply to all of them.
            </p>
          )}
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

          <ul ref={listEl} className={`server-list${drag ? " dragging" : ""}`}>
            {servers.map((s, i) => {
              const p = pings.get(s.ip);
              const icon = iconSrc(s, p);
              const shift = drag ? rowShift(i, drag) : 0;
              return (
                <li
                  key={keys[i]}
                  className={`server${drag?.from === i ? " lifted" : ""}`}
                  style={shift ? { transform: `translateY(${shift}px)` } : undefined}
                  onPointerDown={(e) => startDrag(e, i)}
                >
                  <button
                    className="server-grip"
                    aria-label={`Reorder ${s.name}. Use the up and down arrow keys.`}
                    title="Drag to reorder, or use the arrow keys"
                    onKeyDown={(e) => {
                      const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : -1;
                      if (to < 0 || to >= servers.length) return;
                      e.preventDefault();
                      refocus.current = to;
                      reorder(i, to);
                    }}
                  >
                    ⋮⋮
                  </button>
                  <div className="server-icon" style={icon ? { backgroundImage: `url(${icon})` } : undefined}>
                    {!icon && s.name[0]}
                  </div>
                  <div className="server-main">
                    <div className="server-top">
                      <span className="server-name">{s.name}</span>
                      {s.hidden && <span className="chip">hidden</span>}
                    </div>
                    {p && p !== "offline" && p.motd && <div className="server-motd">{p.motd}</div>}
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
                    <button onClick={() => setForm({ index: i, name: s.name, ip: s.ip })}>Edit</button>
                    <button onClick={() => setArchived(s, true)}>Archive</button>
                    <select
                      value=""
                      aria-label={`More actions for ${s.name}`}
                      title="More"
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "remove") {
                          save(
                            servers.filter((_, j) => j !== i),
                            brief(`Removed ${s.name} — it's still in the backup`)
                          );
                        } else if (v) copyTo(s, v.slice(5));
                      }}
                    >
                      <option value="">⋯</option>
                      {others.length > 0 && (
                        <optgroup label="Copy to">
                          {others.map((l) => (
                            <option key={l.path} value={`copy:${keyOf(l)}`}>
                              {nameOf(l)}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <option value="remove">Remove</option>
                    </select>
                  </div>
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
                </li>
              );
            })}
          </ul>
          {list && servers.length === 0 && (
            <div className="empty">
              {list.archived.length > 0 ? "Every server here is archived." : "No servers here yet. Add one above."}
            </div>
          )}

          {list && list.archived.length > 0 && (
            <details className="pf-archive server-archive">
              <summary>
                Archived <span>{list.archived.length}</span>
              </summary>
              <ul className="server-list">
                {list.archived.map((s, i) => {
                  const icon = iconSrc(s);
                  const armKey = `delete:${list.path}:${s.ip}:${i}`;
                  return (
                    <li key={`${s.ip}-${i}`} className="server">
                      <div className="server-icon" style={icon ? { backgroundImage: `url(${icon})` } : undefined}>
                        {!icon && s.name[0]}
                      </div>
                      <div className="server-main">
                        <div className="server-top">
                          <span className="server-name">{s.name}</span>
                        </div>
                        <div className="server-meta">
                          <code>{s.ip}</code>
                        </div>
                      </div>
                      <div className="server-actions">
                        <button onClick={() => setArchived(s, false)}>Restore</button>
                        <button
                          className={`danger${armed === armKey ? " armed" : ""}`}
                          onClick={() =>
                            confirm(armKey, async () => {
                              await api.deleteArchivedServer(list.installation, s);
                              return `Deleted ${s.name}`;
                            })
                          }
                        >
                          {armed === armKey ? "Confirm delete" : "Delete"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          {list && list.backup.length > 0 && (
            <details className="pf-archive backup">
              <summary>
                Backup <span>{list.backup.length}</span>
                {backupOnly.length > 0 && <span> · {backupOnly.length} not in current list</span>}
              </summary>
              <ul className="pack-list">
                {list.backup.map((b, i) => {
                  const missing = backupOnly.includes(b);
                  return (
                    <li key={`${b.ip}-${i}`} className={missing ? "backup-missing" : ""}>
                      <span className="pack-name">
                        {b.name} <code>{b.ip}</code>
                      </span>
                      {missing ? (
                        <button className="linklike" onClick={() => save([...servers, b], `Restored ${b.name}`)}>
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
            </details>
          )}

          <p className="hint wide folder-foot">
            Close Minecraft before editing, or it'll save its own copy over yours.
          </p>
        </section>
      </div>
    </>
  );
}
