import { useEffect, useRef, useState } from "react";
import { api, formatBytes, InstCopy, Installation, Linkable, Standard, timeAgo } from "./api";
import { useCached } from "./hooks";
import { Avatar } from "./Places";
import { brief } from "./settings";

const FOLDER_LABEL: Record<string, string> = {
  saves: "Saves",
  resourcepacks: "Resource packs",
  screenshots: "Screenshots",
};
const GROUPS: [string, (l: Linkable) => boolean][] = [
  ["Folders", (l) => l.is_dir],
  ["Settings", (l) => !l.is_dir && !l.dest.startsWith("config/")],
  ["Mod configs", (l) => l.dest.startsWith("config/")],
];
// mirrors TEXT_EXTS in lib.rs: what read_config will open
const TEXT = /\.(json5?|jsonc|toml|properties|txt|cfg|conf|ya?ml|ini|snbt|hjson)$/i;
const letter = (k: number) => String.fromCharCode(65 + (k % 26));
const ago = (secs: number) => (secs > 0 && secs < 8e12 ? timeAgo(new Date(secs * 1000).toISOString()) : "—");
const plural = (n: number, w: string, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;

/** One distinct content of a file, and everyone who has it. Newest first. */
interface Version {
  hash: string;
  copies: InstCopy[];
  modified: number;
  size: number;
}

function versionsOf(l: Linkable): Version[] {
  const by = new Map<string, Version>();
  for (const c of l.copies) {
    const v = by.get(c.hash) ?? { hash: c.hash, copies: [], modified: 0, size: c.size_bytes };
    v.copies.push(c);
    v.modified = Math.max(v.modified, c.modified);
    by.set(c.hash, v);
  }
  return [...by.values()].sort((a, b) => b.modified - a.modified);
}

/** The copy to read or copy from: one inside the Minecraft folder when there is one. */
const source = (v: Version) => v.copies.find((c) => c.link !== "elsewhere") ?? v.copies[0];

/** key → value for options.txt / .properties / flat toml; null when it's not that simple. */
function parseKV(text: string): Map<string, string> | null {
  const m = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^([#;!]|\/\/|\[)/.test(line)) continue;
    const x = /^"?([^"=:]+?)"?\s*[:=]\s*(.*?),?$/.exec(line);
    if (!x || m.has(x[1])) return null; // nested (json) or odd: compare by lines instead
    m.set(x[1], x[2]);
  }
  return m.size ? m : null;
}

/**
 * Link Existing: pick installations you already have, see how their
 * settings, configs and folders differ, choose which copy wins, link.
 */
export function LinkWizard({
  installations,
  notify,
  onDone,
  onStandards,
}: {
  installations: Installation[];
  notify: (m: string) => void;
  onDone: () => void;
  onStandards: () => void;
}) {
  const [standards = [], loadStandards] = useCached<Standard[]>("standards", api.listStandards, notify);
  const [step, setStep] = useState<"pick" | "compare" | "done">("pick");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "unlinked">("all");

  const [scan, setScan] = useState<Linkable[] | null>(null);
  const scanId = useRef(0);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [policy, setPolicy] = useState("newest"); // or an installation's name
  const [keep, setKeep] = useState<Record<string, string>>({}); // dest -> hash, per-file picks
  const [focus, setFocus] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [diffOnly, setDiffOnly] = useState(false);
  const [texts, setTexts] = useState<Record<string, string | null>>({}); // hash -> text (null: unreadable)

  const [stdName, setStdName] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string[]>([]);

  const linkedTo = (i: Installation) =>
    i.linked.length > 0 || standards.some((s) => !s.builtin && s.installations.includes(i.name));
  const shown = installations.filter(
    (i) =>
      (only === "all" || !linkedTo(i)) &&
      `${i.name} ${i.game_version ?? ""} ${i.loader ?? ""}`.toLowerCase().includes(query.toLowerCase())
  );
  const allShown = shown.length > 0 && shown.every((i) => picked.has(i.name));
  const pickedList = installations.filter((i) => picked.has(i.name));
  const instOf = (n: string) => installations.find((i) => i.name === n);
  const customStds = standards.filter((s) => !s.builtin);

  // ---- compare ----------------------------------------------------------

  const synced = (l: Linkable) =>
    l.copies.length === picked.size &&
    (l.is_dir
      ? l.copies.every((c) => c.link === "Shared")
      : new Set(l.copies.map((c) => c.link)).size === 1 && l.copies[0].link !== null);

  /** The version that wins for a file: a per-file pick, else the policy. */
  const keeper = (l: Linkable): Version => {
    const vs = versionsOf(l);
    return (
      vs.find((v) => v.hash === keep[l.dest]) ??
      (policy !== "newest" ? vs.find((v) => v.copies.some((c) => c.installation === policy)) : undefined) ??
      vs[0]
    );
  };

  async function startCompare() {
    const id = ++scanId.current; // a later Compare wins over a slow earlier one
    setStep("compare");
    setScan(null);
    setArmed(false);
    if (!stdName) {
      const taken = new Set(customStds.map((s) => s.name.toLowerCase()));
      let n = "Linked";
      for (let k = 2; taken.has(n.toLowerCase()); k++) n = `Linked ${k}`;
      setStdName(n);
    }
    try {
      const list = await api.scanLinkables([...picked]);
      if (id !== scanId.current) return;
      setScan(list);
      // tick what more than one has (folders anyone has), skip what's already in sync
      setOn(
        new Set(
          list
            .filter((l) => !synced(l) && l.copies.length > (l.is_dir ? 0 : 1))
            .map((l) => l.dest)
        )
      );
      setFocus(list.find((l) => !l.is_dir && versionsOf(l).length > 1)?.dest ?? list[0]?.dest ?? null);
    } catch (e) {
      if (id !== scanId.current) return;
      notify(String(e));
      setStep("pick");
    }
  }

  const differs = (l: Linkable) => !l.is_dir && versionsOf(l).length > 1;
  const visible = (scan ?? []).filter(
    (l) => l.dest.toLowerCase().includes(find.toLowerCase()) && (!diffOnly || differs(l))
  );
  const focused = scan?.find((l) => l.dest === focus) ?? null;

  // read each distinct version of the focused file once, for the comparison
  useEffect(() => {
    if (!focused || focused.is_dir || !TEXT.test(focused.dest)) return;
    for (const v of versionsOf(focused)) {
      if (v.hash in texts) continue;
      api
        .readConfig(source(v).path)
        .then((t) => setTexts((m) => ({ ...m, [v.hash]: t })))
        .catch(() => setTexts((m) => ({ ...m, [v.hash]: null })));
    }
    // texts is a cache; re-reading on its change would loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  function setTicked(dests: string[], tick: boolean) {
    const next = new Set(on);
    for (const d of dests) tick ? next.add(d) : next.delete(d);
    setOn(next);
    setArmed(false);
  }

  function listKeys(e: React.KeyboardEvent) {
    const k = visible.findIndex((l) => l.dest === focus);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = visible[Math.min(visible.length - 1, Math.max(0, k + (e.key === "ArrowDown" ? 1 : -1)))];
      if (n) {
        setFocus(n.dest);
        document.getElementById(`lw-${n.dest}`)?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === " " && focus) {
      e.preventDefault();
      setTicked([focus], !on.has(focus));
    }
  }

  // ---- apply ------------------------------------------------------------

  const ticked = (scan ?? []).filter((l) => on.has(l.dest));
  const files = ticked.filter((l) => !l.is_dir);
  const folders = ticked.filter((l) => l.is_dir);
  const existing = customStds.find((s) => s.name.toLowerCase() === stdName.trim().toLowerCase());
  const nameOk = /^[^./][^/]*$/.test(stdName.trim()) && stdName.trim().toLowerCase() !== "shared";
  // own copies that lose to the keeper: replaced, so they go to the Trash
  const replaced = files.flatMap((l) => {
    const k = keeper(l);
    return l.copies.filter((c) => c.link === null && c.hash !== k.hash).map((c) => `${c.installation} · ${l.dest}`);
  });
  // a folder linked from some standard can't merge into Shared; it's left alone
  const mergeable = (l: Linkable, inst: string) =>
    !l.copies.some((c) => c.installation === inst && c.link && c.link !== "Shared");
  const canLink = ticked.length > 0 && (files.length === 0 || nameOk) && !busy;

  async function apply() {
    if (!canLink) return;
    if (replaced.length && !armed) {
      setArmed(true); // second click confirms
      return;
    }
    const name = existing?.name ?? stdName.trim();
    const total = (files.length ? 1 + files.length + pickedList.length : 0) + (folders.length ? pickedList.length : 0);
    let done = 0;
    let at = "";
    const tick = (what: string) => setBusy((at = `${what} · ${++done}/${total}`));
    const renamed: string[] = [];
    try {
      if (files.length) {
        tick("Setting up");
        if (!existing) await api.createStandard(name);
        for (const l of files) {
          tick(`Keeping ${l.dest}`);
          await api.adoptFile(name, source(keeper(l)).path, l.dest);
        }
        for (const i of pickedList) {
          tick(`Linking ${i.name}`);
          await api.linkStandard(name, i.name, files.map((l) => `${name}/${l.dest}`), true);
        }
      }
      for (const i of folders.length ? pickedList : []) {
        tick(`Merging ${i.name}`);
        const dirs = folders.filter((l) => mergeable(l, i.name)).map((l) => l.dest);
        if (dirs.length) renamed.push(...(await api.mergeShared(i.name, dirs)));
      }
      setResult(
        [
          files.length && `${plural(files.length, "file")} now shared through "${name}"`,
          folders.length && `${folders.map((l) => FOLDER_LABEL[l.dest]).join(", ")} merged into Shared`,
          replaced.length && `${plural(replaced.length, "older copy", "older copies")} in the Trash`,
          renamed.length && `${plural(renamed.length, "name clash", "name clashes")} — kept both`,
        ].filter((x): x is string => !!x)
      );
      setStep("done");
    } catch (e) {
      notify(`Stopped at ${at}: ${e}`);
    }
    setBusy(null);
    setArmed(false);
    loadStandards();
    onDone();
  }

  function restart() {
    setPicked(new Set());
    setScan(null);
    setKeep({});
    setTexts({});
    setPolicy("newest");
    setStep("pick");
  }

  // ---- render -----------------------------------------------------------

  return (
    <div
      className="lw"
      onKeyDown={(e) => {
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
        if (step === "pick" && picked.size >= 2) startCompare();
        else if (step === "compare") apply();
      }}
    >
      <header className="page-head lw-head">
        <div>
          <h1>Link Existing</h1>
          <p className="sub">
            {step === "pick"
              ? "Pick the installations that should share settings, configs and folders."
              : step === "compare"
                ? "Tick what to share. Where copies differ, click the one to keep."
                : brief("Done — they stay in sync from now on.")}
          </p>
        </div>
      </header>

      <ol className="lw-steps">
        {(["Pick installations", "Compare & link"] as const).map((label, k) => {
          const at = step === "pick" ? 0 : step === "compare" ? 1 : 2;
          return (
            <li key={label} className={k === at ? "on" : k < at ? "past" : ""}>
              <button disabled={k !== 0 || at !== 1 || !!busy} onClick={() => setStep("pick")}>
                <span className="lw-num">{k < at ? "✓" : k + 1}</span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {step === "pick" && (
        <>
          <div className="lw-toolbar">
            <input
              className="search"
              placeholder="Filter by name, version or loader…"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="segmented small">
              <button className={only === "all" ? "active" : ""} onClick={() => setOnly("all")}>
                All
              </button>
              <button className={only === "unlinked" ? "active" : ""} onClick={() => setOnly("unlinked")}>
                Not linked
              </button>
            </div>
            <button
              className="linklike"
              onClick={() => {
                const next = new Set(picked);
                shown.forEach((i) => (allShown ? next.delete(i.name) : next.add(i.name)));
                setPicked(next);
              }}
            >
              {allShown ? "clear" : "select all"}
            </button>
          </div>

          <div className="lw-tiles">
            {shown.map((i) => {
              const sel = picked.has(i.name);
              return (
                <button
                  key={i.name}
                  className={`lw-tile ${sel ? "on" : ""}`}
                  aria-pressed={sel}
                  onClick={() => {
                    const next = new Set(picked);
                    sel ? next.delete(i.name) : next.add(i.name);
                    setPicked(next);
                  }}
                >
                  <Avatar inst={i} />
                  <span className="lw-tile-text">
                    <span className="lw-tile-name">{i.name}</span>
                    <span className="place-sub">
                      {[i.game_version, i.loader].filter(Boolean).join(" · ")}
                      {linkedTo(i) && <span className="lw-linked"> · linked</span>}
                    </span>
                  </span>
                  <span className="lw-check">{sel && "✓"}</span>
                </button>
              );
            })}
            {shown.length === 0 && <p className="empty">Nothing matches.</p>}
          </div>
        </>
      )}

      {step === "compare" && !scan && (
        <div className="lw-loading">
          <span className="lw-spinner" /> Comparing {plural(picked.size, "installation")}…
        </div>
      )}

      {step === "compare" && scan && (
        <div className="lw-split">
          <div className="lw-list-col">
            <div className="lw-list-head">
              {scan.length > 10 && (
                <input className="search" placeholder="Find…" value={find} onChange={(e) => setFind(e.target.value)} />
              )}
              <label className="lw-toggle">
                <input type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} />
                Only differences
              </label>
            </div>
            <div className="lw-list" tabIndex={0} onKeyDown={listKeys} title="↑↓ to move · space to tick">
              {GROUPS.map(([label, test]) => {
                const items = visible.filter(test);
                if (!items.length) return null;
                const n = items.filter((l) => on.has(l.dest)).length;
                return (
                  <div key={label}>
                    <label className="lw-group">
                      <input
                        type="checkbox"
                        checked={n === items.length}
                        ref={(el) => {
                          if (el) el.indeterminate = n > 0 && n < items.length;
                        }}
                        onChange={() => setTicked(items.map((l) => l.dest), n < items.length)}
                      />
                      {label}
                      <span className="lw-count">{items.length}</span>
                    </label>
                    {items.map((l) => (
                      <Row
                        key={l.dest}
                        l={l}
                        on={on.has(l.dest)}
                        focus={focus === l.dest}
                        synced={synced(l)}
                        versions={l.is_dir ? 0 : versionsOf(l).length}
                        onFocus={() => setFocus(l.dest)}
                        onTick={() => setTicked([l.dest], !on.has(l.dest))}
                      />
                    ))}
                  </div>
                );
              })}
              {visible.length === 0 && <p className="le-empty">{diffOnly ? "No differences — all copies match." : "Nothing here."}</p>}
            </div>
          </div>

          <div className="lw-detail">
            {pickedList.length > 1 && scan.some(differs) && (
              <label className="lw-policy">
                When copies differ, keep
                <select
                  value={policy}
                  onChange={(e) => {
                    setPolicy(e.target.value);
                    setKeep({});
                  }}
                >
                  <option value="newest">the newest</option>
                  {pickedList.map((i) => (
                    <option key={i.name} value={i.name}>
                      {i.name}'s
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!focused ? (
              <p className="le-empty">Pick something on the left.</p>
            ) : focused.is_dir ? (
              <FolderDetail l={focused} picked={pickedList} />
            ) : (
              <FileDetail
                l={focused}
                versions={versionsOf(focused)}
                keeper={keeper(focused)}
                picked={pickedList}
                texts={texts}
                instOf={instOf}
                onKeep={(hash) => {
                  setKeep({ ...keep, [focused.dest]: hash });
                  setTicked([focused.dest], true);
                }}
              />
            )}
          </div>
        </div>
      )}

      {step === "done" && (
        <section className="lw-done">
          <div className="lw-done-mark">✓</div>
          <h2>Linked {plural(pickedList.length, "installation")}</h2>
          <ul>
            {result.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="row-inline lw-done-actions">
            <button className="btn primary" onClick={onStandards}>
              See it in Standards →
            </button>
            <button className="btn" onClick={restart}>
              Link more
            </button>
          </div>
        </section>
      )}

      {step !== "done" && (
        <footer className="lw-foot">
          {step === "pick" ? (
            <span className="lw-foot-sum">{picked.size < 2 ? "Pick at least two" : `${picked.size} picked`}</span>
          ) : (
            <>
              <span className="lw-foot-sum" title={replaced.join("\n")}>
                {busy ??
                  [
                    plural(ticked.length, "item"),
                    replaced.length && `${plural(replaced.length, "copy", "copies")} to Trash`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
              </span>
              {files.length > 0 && (
                <label className="lw-via" title={existing ? "Adds to this standard" : "A new standard: a folder linked into each installation"}>
                  via
                  <input
                    className={`search ${nameOk ? "" : "bad"}`}
                    list="lw-stds"
                    value={stdName}
                    onChange={(e) => {
                      setStdName(e.target.value);
                      setArmed(false);
                    }}
                  />
                  <datalist id="lw-stds">
                    {customStds.map((s) => (
                      <option key={s.name} value={s.name} />
                    ))}
                  </datalist>
                </label>
              )}
              <button className="btn" disabled={!!busy} onClick={() => setStep("pick")}>
                Back
              </button>
            </>
          )}
          {step === "pick" ? (
            <button className="btn primary" disabled={picked.size < 2} onClick={startCompare}>
              Compare →
            </button>
          ) : (
            <button
              className={`btn ${armed ? "danger solid" : "primary"}`}
              disabled={!canLink || !scan}
              onClick={apply}
            >
              {busy ? "Linking…" : armed ? `Trash ${replaced.length} & link` : "Link"}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

function Row({
  l,
  on,
  focus,
  synced,
  versions,
  onFocus,
  onTick,
}: {
  l: Linkable;
  on: boolean;
  focus: boolean;
  synced: boolean;
  versions: number;
  onFocus: () => void;
  onTick: () => void;
}) {
  // a badge only when it tells you something
  const badge = synced
    ? ["synced", "in sync"]
    : l.is_dir
      ? ["", String(l.copies.reduce((n, c) => n + (c.link ? 0 : c.names.length), 0) || "")]
      : versions > 1
        ? ["differ", `${versions} versions`]
        : l.copies.length === 1
          ? ["single", `only ${l.copies[0].installation}`]
          : ["", ""];
  return (
    <div id={`lw-${l.dest}`} className={`lw-item ${focus ? "focus" : ""} ${on ? "" : "off"}`} onClick={onFocus}>
      <input type="checkbox" checked={on} onClick={(e) => e.stopPropagation()} onChange={onTick} />
      <span className="lw-item-name" title={l.dest}>
        {l.is_dir ? FOLDER_LABEL[l.dest] : l.dest.replace(/^config\//, "")}
      </span>
      {badge[1] && <span className={`lw-badge ${badge[0]}`}>{badge[1]}</span>}
    </div>
  );
}

function FolderDetail({ l, picked }: { l: Linkable; picked: Installation[] }) {
  const own = l.copies.filter((c) => !c.link);
  const seen = new Map<string, number>();
  for (const n of [...l.shared, ...own.flatMap((c) => c.names)]) seen.set(n, (seen.get(n) ?? 0) + 1);
  const clashes = [...seen.values()].filter((x) => x > 1).length;
  return (
    <div className="lw-detail-body">
      <h2 className="lw-detail-title">{FOLDER_LABEL[l.dest]}</h2>
      <p className="hint">Everything merges into the one Shared folder — nothing is picked or lost.</p>
      <div className="lw-versions">
        {picked.map((i) => {
          const c = l.copies.find((x) => x.installation === i.name);
          return (
            <div key={i.name} className="lw-version">
              <div className="lw-version-head">
                <Avatar inst={i} small /> {i.name}
                <span className="lw-meta">
                  {!c
                    ? "none yet"
                    : c.link === "Shared"
                      ? "linked ✓"
                      : c.link
                        ? `linked from ${c.link} — skipped`
                        : plural(c.names.length, "item")}
                </span>
              </div>
              {c && !c.link && c.names.length > 0 && (
                <div className="lw-names">
                  {c.names.slice(0, 10).map((n) => (
                    <span key={n} className={`chip ${l.shared.includes(n) ? "differs" : ""}`}>
                      {n}
                    </span>
                  ))}
                  {c.names.length > 10 && <span className="chip">+{c.names.length - 10}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="lw-outcome">
        Shared ends up with <b>{plural(seen.size + clashes, "item")}</b>
        {clashes > 0 && ` — ${plural(clashes, "name")} clash, both copies kept`}.
      </p>
    </div>
  );
}

function FileDetail({
  l,
  versions,
  keeper,
  picked,
  texts,
  instOf,
  onKeep,
}: {
  l: Linkable;
  versions: Version[];
  keeper: Version;
  picked: Installation[];
  texts: Record<string, string | null>;
  instOf: (n: string) => Installation | undefined;
  onKeep: (hash: string) => void;
}) {
  const [peek, setPeek] = useState<string | null>(null);
  const missing = picked.filter((i) => !l.copies.some((c) => c.installation === i.name));
  const textual = TEXT.test(l.dest);
  const loaded = versions.every((v) => v.hash in texts);
  const ki = Math.max(0, versions.findIndex((v) => v.hash === keeper.hash));
  const maps = loaded ? versions.map((v) => (texts[v.hash] == null ? null : parseKV(texts[v.hash]!))) : [];
  const kv = loaded && maps.every(Boolean) ? (maps as Map<string, string>[]) : null;
  const diffKeys = kv
    ? [...new Set(kv.flatMap((m) => [...m.keys()]))].filter((k) => new Set(kv.map((m) => m.get(k))).size > 1)
    : [];

  return (
    <div className="lw-detail-body">
      <h2 className="lw-detail-title">
        <code>{l.dest}</code>
      </h2>
      <p className="hint">
        {versions.length > 1
          ? `${versions.length} versions — the one you keep goes to all.`
          : l.copies.length > 1
            ? "Identical everywhere."
            : "Only one installation has it."}
        {missing.length > 0 && ` Added to ${missing.map((i) => i.name).join(", ")}.`}
      </p>

      <div className="lw-versions">
        {versions.map((v, k) => {
          const kept = k === ki;
          return (
            <div
              key={v.hash}
              className={`lw-version ${versions.length > 1 ? "pickable" : ""} ${kept && versions.length > 1 ? "kept" : ""}`}
              onClick={() => onKeep(v.hash)}
            >
              <div className="lw-version-head">
                {versions.length > 1 && <span className="lw-letter">{letter(k)}</span>}
                <span className="lw-who">
                  {v.copies.map((c) => (
                    <span key={c.installation} className="lw-member" title={c.link ? `linked from ${c.link}` : undefined}>
                      <Avatar inst={instOf(c.installation)} small /> {c.installation}
                    </span>
                  ))}
                </span>
                <span className="lw-meta">
                  {formatBytes(v.size)} · {ago(v.modified)}
                </span>
                {textual && texts[v.hash] && (
                  <button
                    className="linklike lw-peek-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPeek(peek === v.hash ? null : v.hash);
                    }}
                  >
                    {peek === v.hash ? "hide" : "view"}
                  </button>
                )}
              </div>
              {peek === v.hash && <pre className="lw-pre" onClick={(e) => e.stopPropagation()}>{texts[v.hash]}</pre>}
            </div>
          );
        })}
      </div>

      {versions.length > 1 && textual && loaded && (
        <div className="lw-diff">
          {kv ? (
            diffKeys.length === 0 ? (
              <p className="le-empty">Same settings, different order.</p>
            ) : (
              <div className="lw-table-wrap">
                <table className="lw-table">
                  <thead>
                    <tr>
                      <th>{plural(diffKeys.length, "difference")}</th>
                      {versions.map((v, k) => (
                        <th key={v.hash} className={k === ki ? "kept" : ""}>
                          {letter(k)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {diffKeys.map((key) => (
                      <tr key={key}>
                        <td className="lw-key">{key}</td>
                        {kv.map((m, k) => (
                          <td key={k} className={k === ki ? "kept" : m.get(key) === kv[ki].get(key) ? "" : "diff"}>
                            {m.get(key) ?? <span className="lw-none">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <LineDiff versions={versions} keeper={ki} texts={versions.map((v) => texts[v.hash] ?? "")} />
          )}
        </div>
      )}
    </div>
  );
}

/** For nested files (json…): each other version's lines against the kept one. */
function LineDiff({ versions, keeper, texts }: { versions: Version[]; keeper: number; texts: string[] }) {
  const lines = (t: string) => t.split(/\r?\n/).map((x) => x.trimEnd()).filter((x) => x.trim());
  const base = new Set(lines(texts[keeper] ?? ""));
  return (
    <div className="lw-lines">
      {versions.map((v, k) => {
        if (k === keeper) return null;
        const mine = lines(texts[k] ?? "");
        const set = new Set(mine);
        const plus = mine.filter((x) => !base.has(x));
        const minus = [...base].filter((x) => !set.has(x));
        return plus.length + minus.length === 0 ? (
          <p key={v.hash} className="le-empty">{letter(k)}: same lines, different order.</p>
        ) : (
          <pre key={v.hash} className="lw-pre">
            {minus.slice(0, 80).map((x, n) => (
              <div key={`m${n}`} className="keep">{`${letter(keeper)}  ${x}`}</div>
            ))}
            {plus.slice(0, 80).map((x, n) => (
              <div key={`p${n}`} className="lose">{`${letter(k)}  ${x}`}</div>
            ))}
          </pre>
        );
      })}
    </div>
  );
}
