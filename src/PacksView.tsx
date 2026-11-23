import { useMemo, useState } from "react";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  formatBytes,
  ImportReport,
  Installation,
  PackInfo,
  PackList,
  Standard,
  okToChangeShared,
  reportSummary,
  splitLinks,
} from "./api";
import { brief } from "./settings";
import { useCached, useConfirm } from "./hooks";
import { instancePlaces, PlacePicker } from "./Places";
import { ProgressBar, useProgress } from "./Progress";

// pack_format → the game versions that read it
const FORMATS: Record<number, string> = {
  1: "1.6–1.8",
  2: "1.9–1.10",
  3: "1.11–1.12",
  4: "1.13–1.14",
  5: "1.15–1.16.1",
  6: "1.16.2–1.16.5",
  7: "1.17",
  8: "1.18",
  9: "1.19–1.19.2",
  12: "1.19.3",
  13: "1.19.4",
  15: "1.20–1.20.1",
  18: "1.20.2",
  22: "1.20.3–1.20.4",
  32: "1.20.5–1.20.6",
  34: "1.21–1.21.1",
  42: "1.21.2–1.21.3",
  46: "1.21.4",
  55: "1.21.5",
  63: "1.21.6",
  64: "1.21.7–1.21.8",
};

const packName = (file: string) => file.replace(/\.zip$/, "").replace(/§./g, "");

export function PacksView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [standards = [], reloadStandards] = useCached<Standard[]>("standards", api.listStandards, notify);
  const places = useMemo(
    () => instancePlaces("resourcepacks", installations, standards),
    [installations, standards]
  );
  // a picked installation that now uses a standard lands on that standard
  const [picked, setPicked] = useState<string>();
  const section = places.find((p) => p.key === picked || p.members?.some((m) => m.name === picked)) ?? places[0];
  const scope = section.kind === "root" ? null : section.key;
  const isStandard = !!section.std && !section.std.builtin;
  const members = section.members ?? [];
  // a standard's downloads match the newest version using it
  const importTo = section.key || "standards/Shared";
  const [mode, setMode] = useState<"view" | "edit">("view");
  // a standard has no active list of its own: read it from an installation using it
  const listScope = isStandard ? (members[0]?.name ?? scope) : scope;
  const canToggle = !isStandard || members.length > 0;
  // one game folder per options.txt: linked ones already share their list
  const optionsOf = (i: Installation) => {
    const l = i.links["options.txt"];
    return l ? (l.from === "Shared" ? "" : l.dir) : i.name;
  };
  const writers: (string | null)[] = [
    ...(scope === null ? [null] : []),
    ...(members.length ? members : installations.filter((i) => i.name === scope))
      .filter((m) => scope !== null || optionsOf(m) !== "")
      .filter((m, n, all) => all.findIndex((o) => optionsOf(o) === optionsOf(m)) === n)
      .map((m) => m.name),
  ];
  const [list, reload] = useCached<PackList>(
    `packs:${listScope}`,
    () => api.listPacks(listScope),
    notify
  );
  const refresh = () => {
    reload();
    reloadStandards();
  };
  const { armed, confirm } = useConfirm(notify, refresh);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "newest" | "size">("name");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const progress = useProgress(busy);

  const packs = list?.packs ?? [];
  const byFile = useMemo(() => new Map(packs.map((p) => [p.file, p])), [packs]);
  // on, top first — only packs that are still in the folder
  const enabled = (list?.enabled ?? []).filter((f) => byFile.has(f));
  const missing = (list?.enabled ?? []).filter((f) => !byFile.has(f));
  const matching = packs.filter((p) => {
    const q = query.toLowerCase();
    return !q || p.file.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q);
  });
  if (sort === "newest") matching.sort((a, b) => b.modified - a.modified);
  if (sort === "size") matching.sort((a, b) => b.size_bytes - a.size_bytes);
  const off = matching.filter((p) => !enabled.includes(p.file));

  async function save(next: string[]) {
    try {
      // the active list lives in each options.txt, so an instance sets them all
      const others = writers.filter((w) => w !== listScope);
      const lists = await Promise.all(others.map((w) => api.listPacks(w)));
      const mine = (list?.enabled ?? []).join("\n");
      const differ = others.filter((_, n) => lists[n].enabled.join("\n") !== mine);
      if (
        differ.length &&
        !(await ask(`${differ.join(", ")} ${differ.length === 1 ? "has" : "have"} different active packs. Continuing gives this whole instance the same list.`, {
          title: "Different active packs",
          kind: "warning",
          okLabel: "Continue",
          cancelLabel: "Cancel",
        }))
      )
        return;
      for (const w of writers) await api.setPacks(w, next);
      reload();
    } catch (e) {
      notify(String(e));
    }
  }
  const move = (i: number, by: number) => {
    const next = [...enabled];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    save(next);
  };

  async function add() {
    const files = await openDialog({
      multiple: true,
      title: "Add resource packs",
      filters: [{ name: "Resource pack", extensions: ["zip"] }],
    });
    if (!files || files.length === 0) return;
    try {
      const n = await api.addPacks(scope, files as string[]);
      notify(`Added ${n} pack${n === 1 ? "" : "s"}`);
      refresh();
    } catch (e) {
      notify(String(e));
    }
  }

  async function importLinks() {
    if (!importTo) return;
    setBusy(true);
    setReport(null);
    try {
      const r = await api.importLinks(splitLinks(link), importTo);
      notify(reportSummary(r));
      if (r.skipped.length) setReport(r);
      setLink("");
      refresh();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }

  const inst = section.inst;

  function row(p: PackInfo, i: number | null) {
    const on = i !== null;
    return (
      <li key={p.file} className={`mod pack ${on || mode === "view" ? "" : "off"}`}>
        {on && <span className="pack-rank">{i + 1}</span>}
        <div
          className="mod-icon"
          style={p.icon ? { backgroundImage: `url(${p.icon})` } : undefined}
        >
          {!p.icon && packName(p.file)[0]}
        </div>
        <div className="mod-main">
          <div className="mod-top">
            <span className="mod-name">{packName(p.file)}</span>
            {p.format != null && (
              <span className="chip" title={`pack_format ${p.format}`}>
                {FORMATS[p.format] ?? `format ${p.format}`}
              </span>
            )}
            {p.is_dir && <span className="chip">folder</span>}
            {mode === "view" && enabled.includes(p.file) && <span className="chip">active</span>}
          </div>
          {p.description && <p className="mod-desc">{p.description}</p>}
          <div className="mod-meta">
            <span className="mod-file" title={p.file}>
              {p.file}
            </span>
            <span>{formatBytes(p.size_bytes)}</span>
          </div>
        </div>
        <div className="mod-actions">
          {on && (
            <span className="pack-move">
              <button
                className="linklike"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                title="Higher wins over the packs below"
              >
                ▲
              </button>
              <button
                className="linklike"
                disabled={i === enabled.length - 1}
                onClick={() => move(i, 1)}
                title="Lower"
              >
                ▼
              </button>
            </span>
          )}
          {mode === "edit" && (
          <button
            className={`switch ${on ? "on" : ""}`}
            role="switch"
            aria-checked={on}
            title={on ? "Turn off" : brief("Turn on — goes on top")}
            onClick={() =>
              save(on ? enabled.filter((f) => f !== p.file) : [p.file, ...enabled])
            }
          >
            <span />
          </button>
          )}
          {mode === "view" && !enabled.includes(p.file) && (
            <button
              className="linklike danger-link"
              onClick={() =>
                confirm(p.path, async () => {
                  if (!(await okToChangeShared([p.path], `Removing ${packName(p.file)}`))) {
                    return `Kept ${packName(p.file)}`;
                  }
                  await api.trashItem(p.path);
                  return `Moved ${packName(p.file)} to Trash`;
                })
              }
            >
              {armed === p.path ? "sure?" : "remove"}
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Resource Packs</h1>
          <p className="sub">
            {packs.length} pack{packs.length === 1 ? "" : "s"} · {enabled.length} on
            {list?.linked && " · shared folder"}
          </p>
        </div>
        <div className="row-inline">
          {list && (
            <button className="btn" onClick={() => api.revealPath(list.dir, false)}>
              Open Folder
            </button>
          )}
          <button className="btn primary" onClick={add}>
            + Add Packs
          </button>
        </div>
      </header>

      <p className="hint wide">
        Which packs are on, and their order, lives in each game folder's{" "}
        <code>options.txt</code>
        <span className="more"> — changing them here updates every installation using this standard</span>.
        Close Minecraft first, or it saves its own list over yours.
      </p>

      <PlacePicker places={places} value={section.key} onChange={setPicked} />

      <div className="options-layout">
        <section className="options-editor">
          {importTo && (
            <form
              className="options-toolbar import-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (link.trim()) importLinks();
              }}
            >
              <input
                className="search"
                placeholder={brief(`Paste Modrinth resource pack links — matched to ${inst?.game_version ?? "the newest version here"}`)}
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <button className="btn" disabled={!link.trim() || busy}>
                {busy ? "Importing…" : "Import"}
              </button>
            </form>
          )}
          {busy && <ProgressBar p={progress} fallback="Looking up links…" />}
          {report && (
            <p className="hint wide">
              Skipped: {report.skipped.join(" · ")}{" "}
              <button className="linklike" onClick={() => setReport(null)}>
                dismiss
              </button>
            </p>
          )}

          <div className="segmented kinds" role="tablist" aria-label="Resource pack sections">
            <button role="tab" aria-selected={mode === "view"} className={mode === "view" ? "active" : ""} onClick={() => setMode("view")}>
              View
            </button>
            <button role="tab" aria-selected={mode === "edit"} className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>
              Edit active
            </button>
          </div>

          {mode === "edit" && !canToggle && (
            <div className="empty">No installation uses this standard yet, so there's no active list to edit.</div>
          )}
          {mode === "edit" && canToggle && (
            <>
              <h3 className="pack-heading">Active</h3>
              {enabled.length > 0 ? (
                <ul className="mod-list">{enabled.map((f, i) => row(byFile.get(f)!, i))}</ul>
              ) : (
                <div className="empty">{brief("No packs on — Minecraft's default look.")}</div>
              )}
              {missing.length > 0 && (
                <p className="hint">
                  options.txt also turns on {missing.join(", ")}, which{" "}
                  {missing.length === 1 ? "isn't" : "aren't"} in the folder.{" "}
                  <button className="linklike" onClick={() => save(enabled)}>
                    Forget {missing.length === 1 ? "it" : "them"}
                  </button>
                </p>
              )}
            </>
          )}

          {(mode === "view" || canToggle) && (
            <div className="options-toolbar">
              <h3 className="pack-heading">{mode === "view" ? "Packs" : "Available"}</h3>
              <input
                className="search"
                placeholder="Search packs…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
                title="Sort"
              >
                <option value="name">A–Z</option>
                <option value="newest">Newest</option>
                <option value="size">Largest</option>
              </select>
            </div>
          )}
          {mode === "view" && <ul className="mod-list">{matching.map((p) => row(p, null))}</ul>}
          {mode === "edit" && canToggle && <ul className="mod-list">{off.map((p) => row(p, null))}</ul>}
          {packs.length === 0 && (
            <div className="empty">
              No resource packs here yet.{" "}
              <button className="linklike" onClick={add}>
                Add some
              </button>
              .
            </div>
          )}
          {packs.length > 0 && matching.length === 0 && <div className="empty">Nothing matches.</div>}
        </section>
      </div>
    </>
  );
}
