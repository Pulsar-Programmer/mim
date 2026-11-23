import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  formatBytes,
  ImportReport,
  Installation,
  PackInfo,
  PackList,
  okToChangeShared,
  reportSummary,
  splitLinks,
} from "./api";
import { brief } from "./settings";
import { useCached, useConfirm } from "./hooks";
import { PlacePicker } from "./Places";
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
  // undefined until picked: then the first installation, once they've loaded
  const [picked, setScope] = useState<string | null | undefined>(undefined);
  const scope = picked === undefined ? (installations[0]?.name ?? null) : picked;
  const [list, reload] = useCached<PackList>(
    `packs:${scope}`,
    () => api.listPacks(scope),
    notify
  );
  const { armed, confirm } = useConfirm(notify, reload);
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
  const off = packs
    .filter((p) => !enabled.includes(p.file))
    .filter((p) => {
      const q = query.toLowerCase();
      return !q || p.file.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q);
    });
  if (sort === "newest") off.sort((a, b) => b.modified - a.modified);
  if (sort === "size") off.sort((a, b) => b.size_bytes - a.size_bytes);

  async function save(next: string[]) {
    try {
      await api.setPacks(scope, next);
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
      reload();
    } catch (e) {
      notify(String(e));
    }
  }

  async function importLinks() {
    if (!scope) return;
    setBusy(true);
    setReport(null);
    try {
      const r = await api.importLinks(splitLinks(link), scope);
      notify(reportSummary(r));
      if (r.skipped.length) setReport(r);
      setLink("");
      reload();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }

  const inst = installations.find((i) => i.name === scope);

  function row(p: PackInfo, i: number | null) {
    const on = i !== null;
    return (
      <li key={p.file} className={`mod pack ${on ? "" : "off"}`}>
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
          {!on && (
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
        <span className="more"> — installations linked to the shared folder see the same packs but can turn on
        different ones</span>. Close Minecraft first, or it saves its own list over yours.
      </p>

      <PlacePicker
        places={[
          ...installations.map((i) => ({
            key: i.name,
            label: i.name,
            inst: i,
            sub: i.linked.includes("resourcepacks") ? "shared folder" : "own folder",
          })),
          { key: "", label: "Minecraft folder", kind: "root" as const, sub: "shared folder" },
        ]}
        value={scope ?? ""}
        onChange={(k) => setScope(k || null)}
      />

      <div className="options-layout">
        <section className="options-editor">
          {scope && (
            <form
              className="options-toolbar import-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (link.trim()) importLinks();
              }}
            >
              <input
                className="search"
                placeholder={brief(`Paste Modrinth resource pack links — matched to ${inst?.game_version ?? "this version"}`)}
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

          <div className="options-toolbar">
            <h3 className="pack-heading">Available</h3>
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
          <ul className="mod-list">{off.map((p) => row(p, null))}</ul>
          {packs.length === 0 && (
            <div className="empty">
              No resource packs here yet.{" "}
              <button className="linklike" onClick={add}>
                Add some
              </button>
              .
            </div>
          )}
          {packs.length > 0 && off.length === 0 && enabled.length < packs.length && (
            <div className="empty">Nothing matches.</div>
          )}
        </section>
      </div>
    </>
  );
}
