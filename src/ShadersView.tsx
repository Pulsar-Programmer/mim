import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  formatBytes,
  ImportReport,
  Installation,
  okToChangeShared,
  reportSummary,
  ShaderInfo,
  ShaderList,
  ShaderPack,
  splitLinks,
  Standard,
} from "./api";
import { useCached, useConfirm } from "./hooks";
import { Modal } from "./Modal";
import { instancePlaces, PlacePicker } from "./Places";
import { ProgressBar, useProgress } from "./Progress";
import { brief } from "./settings";

const packName = (file: string) => file.replace(/\.zip$/i, "").replace(/§./g, "").replace(/_/g, " ");

type Open = { pack: ShaderPack; info: ShaderInfo; index: number };

export function ShadersView({
  notify,
  installations,
}: {
  notify: (m: string) => void;
  installations: Installation[];
}) {
  const [standards = [], reloadStandards] = useCached<Standard[]>("standards", api.listStandards, notify);
  const [mode, setMode] = useState<"view" | "edit">("view");
  // View is grouped by who shares the shader folder, Edit by who shares the
  // config folder, since that's where Iris keeps the active pack
  const places = useMemo(
    () => instancePlaces(mode === "view" ? "shaderpacks" : "config", installations, standards),
    [mode, installations, standards]
  );
  const [pickedFolder, setPickedFolder] = useState<string>();
  const [pickedConfig, setPickedConfig] = useState<string>();
  const picked = mode === "view" ? pickedFolder : pickedConfig;
  const section = places.find((p) => p.key === picked || p.members?.some((m) => m.name === picked)) ?? places[0];
  const scope = section.kind === "root" ? null : section.key;
  const importTo = section.key || "standards/Shared";
  const [list, reload] = useCached<ShaderList>(`shaders:${scope}`, () => api.listShaders(scope), notify);
  // a config can turn on packs from any folder its installations use
  const users = mode === "edit" ? (section.members ?? []).map((m) => m.name) : [];
  const [userPacks = [], reloadUsers] = useCached<ShaderPack[]>(
    `shader-users:${users.join("\n")}`,
    async () => (await Promise.all(users.map((u) => api.listShaders(u)))).flatMap((l) => l.packs),
    notify
  );
  // null = Modrinth unreachable; the local list still works
  const [gallery, reloadGallery] = useCached<Record<string, ShaderInfo> | null>(
    "shader-gallery",
    () => api.shaderGallery().catch(() => null),
    notify
  );
  const refresh = () => {
    reload();
    reloadUsers();
    reloadStandards();
  };
  const { armed, confirm } = useConfirm(notify, refresh);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "newest" | "size">("name");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const progress = useProgress(busy);

  const byFile = useMemo(
    () => new Map([...userPacks, ...(list?.packs ?? [])].map((p) => [p.file, p])),
    [userPacks, list]
  );
  const packs = [...byFile.values()].sort((a, b) => a.file.toLowerCase().localeCompare(b.file.toLowerCase()));
  const active = list?.active ?? null;
  const activePack = active ? byFile.get(active) : undefined;
  const canEdit = !!list?.configs.length;
  const matching = packs.filter((p) => {
    const q = query.toLowerCase();
    const info = gallery?.[p.file];
    return (
      !q ||
      p.file.toLowerCase().includes(q) ||
      !!info?.title.toLowerCase().includes(q) ||
      !!info?.description.toLowerCase().includes(q)
    );
  });
  if (sort === "newest") matching.sort((a, b) => b.modified - a.modified);
  if (sort === "size") matching.sort((a, b) => b.size_bytes - a.size_bytes);
  const off = matching.filter((p) => p.file !== active);

  async function choose(file: string | null) {
    try {
      const what = file ? `Turning on ${packName(file)}` : "Turning shaders off";
      if (!(await okToChangeShared(list?.configs ?? [], what, true))) return;
      await api.setShader(scope, file);
      refresh();
    } catch (e) {
      notify(String(e));
    }
  }

  async function add() {
    const files = await openDialog({
      multiple: true,
      title: "Add shader packs",
      filters: [{ name: "Shader pack", extensions: ["zip"] }],
    });
    if (!files || files.length === 0) return;
    try {
      const n = await api.addShaders(scope, files as string[]);
      notify(`Added ${n} shader${n === 1 ? "" : "s"}`);
      refresh();
      reloadGallery();
    } catch (e) {
      notify(String(e));
    }
  }

  async function importLinks() {
    setBusy(true);
    setReport(null);
    try {
      const r = await api.importLinks(splitLinks(link), importTo, "shader");
      notify(reportSummary(r));
      if (r.skipped.length) setReport(r);
      setLink("");
      refresh();
      reloadGallery();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }

  function row(p: ShaderPack, on: boolean) {
    const info = gallery?.[p.file] ?? undefined;
    const cover = info?.images[0];
    const title = info?.title || packName(p.file);
    return (
      <li key={p.file} className={`mod pack ${on || mode === "view" ? "" : "off"}`}>
        <button
          className="mod-icon shader-thumb"
          disabled={!cover}
          aria-label={`View ${title} screenshots`}
          title={cover ? "View screenshots" : undefined}
          onClick={() => info && setOpen({ pack: p, info, index: 0 })}
        >
          {cover ? <img src={cover.url} loading="lazy" decoding="async" alt="" /> : title[0]}
          {info && info.images.length > 1 && <span className="count">{info.images.length}</span>}
        </button>
        <div className="mod-main">
          <div className="mod-top">
            <span className="mod-name">{title}</span>
            {on && mode === "view" && <span className="chip">active</span>}
            {p.is_dir && <span className="chip">folder</span>}
          </div>
          {info?.description && <p className="mod-desc">{info.description}</p>}
          <div className="mod-meta">
            <span className="mod-file" title={p.file}>
              {p.file}
            </span>
            <span>{formatBytes(p.size_bytes)}</span>
            {info?.page && (
              <button className="linklike" onClick={() => openUrl(info.page)}>
                Modrinth
              </button>
            )}
          </div>
        </div>
        <div className="mod-actions">
          {mode === "edit" && (
            <button
              className={`switch ${on ? "on" : ""}`}
              role="switch"
              aria-checked={on}
              aria-label={`${on ? "Turn off" : "Turn on"} ${title}`}
              disabled={!canEdit}
              title={on ? "Turn off" : brief("Turn on — replaces the current shader")}
              onClick={() => choose(on ? null : p.file)}
            >
              <span />
            </button>
          )}
          {mode === "view" && (
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
          <h1>Shader Packs</h1>
          <p className="sub">
            {packs.length} pack{packs.length === 1 ? "" : "s"}
            {mode === "edit" && ` · ${active ? "1 on" : "off"}`}
            {mode === "view" && list?.linked && " · shared folder"}
          </p>
        </div>
        {mode === "view" && (
          <div className="row-inline">
            {list && !section.empty && (
              <button className="btn" onClick={() => api.revealPath(list.dir, false)}>
                Open Folder
              </button>
            )}
            <button className="btn primary" onClick={add}>
              + Add Packs
            </button>
          </div>
        )}
      </header>

      <p className="hint wide">
        {mode === "view" ? (
          "The shader packs in each folder."
        ) : (
          <>
            The active shader lives in Iris's or OptiFine's settings, so these instances follow who shares{" "}
            <code>config</code>. Close Minecraft first, or it saves its own choice over yours.
          </>
        )}
      </p>

      <div className="segmented kinds" role="tablist" aria-label="Shader pack sections">
        <button role="tab" aria-selected={mode === "view"} className={mode === "view" ? "active" : ""} onClick={() => setMode("view")}>
          View
        </button>
        <button role="tab" aria-selected={mode === "edit"} className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>
          Edit active
        </button>
      </div>

      <PlacePicker
        places={places}
        value={section.key}
        onChange={mode === "view" ? setPickedFolder : setPickedConfig}
      />

      <div className="options-layout">
        <section className="options-editor">
          {mode === "view" && (
            <form
              className="options-toolbar import-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (link.trim()) importLinks();
              }}
            >
              <input
                className="search"
                placeholder={brief(`Paste Modrinth shader links — matched to ${section.inst?.game_version ?? "the newest version here"}`)}
                aria-label="Modrinth shader links"
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
          {gallery === null && packs.length > 0 && (
            <p className="hint wide">Couldn't reach Modrinth, so screenshots are unavailable right now.</p>
          )}

          {mode === "edit" && (
            <>
              {list && !canEdit && (
                <p className="hint wide">Launch this instance once with Iris or OptiFine, then pick a shader here.</p>
              )}
              <h3 className="pack-heading">Active</h3>
              {activePack ? (
                <ul className="mod-list">{row(activePack, true)}</ul>
              ) : (
                <div className="empty">{brief("No shader on — Minecraft's default look.")}</div>
              )}
              {active && !activePack && (
                <p className="hint">
                  The settings turn on {active}, which isn't in the folder.{" "}
                  <button className="linklike" onClick={() => choose(null)}>
                    Turn it off
                  </button>
                </p>
              )}
            </>
          )}

          <div className="options-toolbar">
            <h3 className="pack-heading">{mode === "view" ? "Packs" : "Available"}</h3>
            <input
              className="search"
              placeholder="Search shaders…"
              aria-label="Search shaders"
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
          <ul className="mod-list">
            {(mode === "view" ? matching : off).map((p) => row(p, p.file === active))}
          </ul>
          {packs.length === 0 &&
            (mode === "view" ? (
              <div className="empty">
                No shader packs here yet.{" "}
                <button className="linklike" onClick={add}>
                  Add some
                </button>
                .
              </div>
            ) : (
              <div className="empty">No shaders available here. Add some under View.</div>
            ))}
          {packs.length > 0 && matching.length === 0 && <div className="empty">Nothing matches.</div>}
        </section>
      </div>

      {open && <Viewer {...open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Viewer({ pack, info, index, onClose }: Open & { onClose: () => void }) {
  const [at, setAt] = useState(index);
  const strip = useRef<HTMLDivElement>(null);
  const image = info.images[at];
  const go = (by: number) => setAt((at + by + info.images.length) % info.images.length);

  useEffect(() => {
    strip.current?.querySelector(".strip-item.active")?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [at]);

  return (
    <Modal
      className="shader-viewer"
      label={`${info.title} screenshots`}
      focusSelf
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(1);
        if (e.key === "ArrowLeft") go(-1);
      }}
    >
      <div className="viewer-shell">
        <div className="vs-ambient" key={image.url} style={{ backgroundImage: `url("${image.url}")` }} />
        <header className="vs-top" data-tauri-drag-region>
          <span className="vs-count">
            {at + 1} <span>/ {info.images.length}</span>
          </span>
          <span className="vs-title">
            {image.title || info.title}
            {image.title && <span className="vs-loc">{info.title}</span>}
          </span>
          <div className="vs-tools">
            <button className="vs-btn wide" onClick={() => openUrl(info.page)} title="Open on Modrinth">
              Modrinth
            </button>
            <button className="vs-btn wide" onClick={() => api.revealPath(pack.path)} title="Show in folder">
              Reveal
            </button>
            <button className="vs-btn" onClick={onClose} title="Close (esc)" aria-label="Close">
              ✕
            </button>
          </div>
        </header>
        <div
          className="vs-stage"
          onClick={(e) => e.target === e.currentTarget && onClose()}
        >
          <div className="vs-frame">
            <img
              key={image.raw_url}
              className="vs-img"
              src={image.raw_url}
              alt={image.title || `${info.title} screenshot ${at + 1}`}
              style={{ backgroundImage: `url("${image.url}")` }}
              draggable={false}
            />
          </div>
          {info.images.length > 1 && (
            <>
              <button className="vs-nav prev" onClick={() => go(-1)} aria-label="Previous">
                ‹
              </button>
              <button className="vs-nav next" onClick={() => go(1)} aria-label="Next">
                ›
              </button>
            </>
          )}
        </div>
        <div className="vs-strip" ref={strip}>
          {info.images.map((m, i) => (
            <button
              key={m.url}
              className={`strip-item ${i === at ? "active" : ""}`}
              onClick={() => setAt(i)}
              aria-label={m.title || `Screenshot ${i + 1}`}
            >
              <img src={m.url} loading="lazy" alt="" />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
