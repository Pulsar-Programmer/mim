import { useEffect, useState } from "react";
import { api, entriesFor, Installation, Standard } from "./api";
import { Avatar, StandardAvatar } from "./Places";
import { brief } from "./settings";

type Ask =
  | { kind: "blocked"; std: string; rels: string[]; items: string[] }
  | { kind: "unlink"; std: string; rels?: string[]; label: string };

const LABEL: Record<string, string> = { resourcepacks: "resource packs" };

/** Everything one installation can be linked to, each a click away. */
export function LinksDrawer({
  inst,
  standards,
  notify,
  onChanged,
  onClose,
  onManage,
}: {
  inst: Installation;
  standards: Standard[];
  notify: (m: string) => void;
  onChanged: () => void;
  onClose: () => void;
  onManage: () => void;
}) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  async function run(task: () => Promise<string | null>) {
    setBusy(true);
    try {
      const msg = await task();
      if (msg) notify(msg);
    } catch (e) {
      notify(String(e));
    }
    setBusy(false);
    onChanged();
  }

  // Shared: the installation's own folders move into Shared, nothing to ask
  const linkShared = (rels: string[]) =>
    run(async () => {
      const dirs = rels.map((r) => r.split("/")[1]);
      const own = dirs.filter((d) => inst.unlinked.includes(d));
      const renamed = await api.mergeShared(inst.name, dirs);
      setAsk(null);
      return (
        `Linked ${dirs.map((d) => LABEL[d] ?? d).join(", ")}` +
        (own.length ? brief(` · ${inst.name}'s own moved into Shared`) : "") +
        (renamed.length ? ` · kept both of ${renamed.join(", ")}` : "")
      );
    });

  const link = (s: Standard, rels: string[], replace = false) =>
    s.builtin
      ? linkShared(rels)
      : run(async () => {
          const inWay = await api.linkStandard(s.name, inst.name, rels, replace);
          if (inWay.length && !replace) {
            setAsk({ kind: "blocked", std: s.name, rels, items: inWay });
            return null;
          }
          setAsk(null);
          return `Linked "${s.name}"` + (inWay.length ? ` · moved ${inWay.join(", ")} to Trash` : "");
        });

  const unlink = (s: Standard, keep: boolean, rels?: string[]) =>
    run(async () => {
      await api.unlinkStandard(s.name, inst.name, keep, rels);
      setAsk(null);
      return keep ? brief(`Unlinked — ${inst.name} keeps a copy`) : "Unlinked";
    });

  const rows = standards.map((s) => ({ s, entries: entriesFor(s, inst.game_version) }));
  const shown = rows.filter((r) => r.entries.length > 0);
  const hidden = rows.length - shown.length;

  return (
    <div className="viewer-backdrop drawer-backdrop" onClick={onClose}>
      <aside className="drawer links-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-hero">
          <Avatar inst={inst} />
          <div className="links-title">
            <h2 className="drawer-title">{inst.name}</h2>
            <span className="place-sub">
              {[inst.game_version, inst.loader].filter(Boolean).join(" · ") || "links"}
            </span>
          </div>
          <button className="linklike drawer-close" onClick={onClose}>
            close
          </button>
        </div>

        <p className="hint links-intro">
          {brief("Linked folders stay in sync — change it here, it changes everywhere it's linked.")}
        </p>

        <div className={`based-list ${busy ? "busy" : ""}`}>
          {shown.map(({ s, entries }) => {
            const live = new Set(s.linked[inst.name] ?? []);
            const rels = entries.map((e) => e.rel_path);
            const n = rels.filter((r) => live.has(r)).length;
            const all = n === rels.length;
            const missing = rels.filter((r) => !live.has(r));
            const status = all
              ? "linked"
              : n > 0
                ? `${n} of ${rels.length} linked`
                : s.builtin
                  ? "not linked"
                  : `${rels.length} ${rels.length === 1 ? "item" : "items"} · not linked`;
            return (
              <div key={s.name} className={`based ${n ? "on" : ""}`}>
                <div className="based-head">
                  <label className="based-main">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={all}
                      ref={(el) => {
                        if (el) el.indeterminate = n > 0 && !all;
                      }}
                      onChange={() =>
                        all
                          ? setAsk({ kind: "unlink", std: s.name, label: `"${s.name}"` })
                          : link(s, missing)
                      }
                    />
                    <StandardAvatar s={s} />
                    <span className="place-text">
                      <span className="place-label">{s.builtin ? "Shared folders" : s.name}</span>
                      <span className="place-sub">{status}</span>
                    </span>
                  </label>
                  {n > 0 && !all && (
                    <button className="linklike based-more" disabled={busy} onClick={() => link(s, missing)}>
                      Link the rest
                    </button>
                  )}
                </div>
                <div className="based-files">
                  {entries.map((e) => {
                    const on = live.has(e.rel_path);
                    return (
                      <button
                        key={e.rel_path}
                        className={`file-chip ${on ? "on" : ""}`}
                        disabled={busy}
                        title={on ? "Linked — click to unlink" : "Click to link"}
                        onClick={() =>
                          on
                            ? setAsk({
                                kind: "unlink",
                                std: s.name,
                                rels: [e.rel_path],
                                label: e.name,
                              })
                            : link(s, [e.rel_path])
                        }
                      >
                        <span className={`link-dot ${on ? "on" : ""}`} />
                        {s.builtin ? LABEL[e.name] ?? e.name : e.name}
                        {e.is_dir && !s.builtin ? "/" : ""}
                        {e.scope !== "global" && <span className="chip">{e.scope}</span>}
                        {s.builtin && !on && inst.unlinked.includes(e.name) && (
                          <span className="chip" title={brief("Has its own — linking moves them into Shared")}>
                            own
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {ask?.std === s.name && ask.kind === "blocked" && (
                  <div className="std-ask warn links-ask">
                    <p>
                      {inst.name} already has <code>{ask.items.join(", ")}</code>.{" "}
                      {brief(`To link "${s.name}", MIM moves ${ask.items.length === 1 ? "it" : "them"} to the Trash.`)}
                    </p>
                    <div className="row-inline">
                      <button className="btn small danger" onClick={() => link(s, ask.rels, true)}>
                        Move to Trash &amp; link
                      </button>
                      <button className="btn small ghost" onClick={() => setAsk(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {ask?.std === s.name && ask.kind === "unlink" && (
                  <div className="std-ask links-ask">
                    <p>
                      Unlink {ask.label}?{" "}
                      {brief(`Keep a copy in ${inst.name}, or start it empty? Nothing in ${s.builtin ? "Shared" : `"${s.name}"`} is deleted.`)}
                    </p>
                    <div className="row-inline">
                      <button className="btn small" onClick={() => unlink(s, true, ask.rels)}>
                        Keep a copy
                      </button>
                      <button className="btn small danger" onClick={() => unlink(s, false, ask.rels)}>
                        Just unlink
                      </button>
                      <button className="btn small ghost" onClick={() => setAsk(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {standards.length === 1 && (
          <p className="hint links-intro">
            No standards yet.
            <span className="more"> A standard is a folder of options.txt, packs or mod configs you link into any installation.</span>
          </p>
        )}
        {hidden > 0 && (
          <p className="hint links-intro">
            {hidden} {hidden === 1 ? "standard has" : "standards have"} nothing for {inst.game_version ?? "this version"}.
          </p>
        )}

        <div className="drawer-actions">
          <button className="btn" onClick={onManage}>
            {standards.length === 1 ? "Create a standard →" : "Manage standards →"}
          </button>
        </div>
      </aside>
    </div>
  );
}
