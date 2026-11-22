import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatBytes, InstCopy, Installation, Linkable, Standard, timeAgo } from "./api";
import { compare, Comparison, mergeText, sameValue } from "./compare";
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

/** What's in the list next to a file that has several versions. */
function verdict(c: Comparison | undefined): [string, string] {
  if (!c) return ["", "…"];
  if (c.kind === "same") return ["synced", "same settings"];
  if (c.kind === "additive" || (c.kind === "combine" && c.mergeable)) return ["single", "auto-merge"];
  if (c.kind === "conflict" && c.mergeable) return ["differ", plural(c.conflicts.length, "clash", "clashes")];
  return ["differ", "pick one"];
}

/** Only these need a person: real clashes, or files that can't be combined. */
const needsYou = (c: Comparison | undefined) =>
  !!c && (c.kind === "unknown" || c.kind === "conflict" || (c.kind === "combine" && !c.mergeable));

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
  const [policy, setPolicy] = useState("merge"); // "newest", or an installation's name
  const [keep, setKeep] = useState<Record<string, string>>({}); // dest -> hash, "use this one as is"
  const [picks, setPicks] = useState<Record<string, Record<string, number>>>({}); // dest -> setting -> version
  const [how, setHow] = useState<Record<string, "link" | "clone">>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [attention, setAttention] = useState(false);
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

  const comparisons = useMemo(() => {
    const out = new Map<string, Comparison>();
    for (const l of scan ?? []) {
      if (l.is_dir) continue;
      const vs = versionsOf(l);
      if (vs.length < 2) continue;
      if (!TEXT.test(l.dest)) out.set(l.dest, compare(vs.map(() => null), l.dest));
      else if (vs.every((v) => v.hash in texts)) out.set(l.dest, compare(vs.map((v) => texts[v.hash]), l.dest));
    }
    return out;
  }, [scan, texts]);
  const reading = (scan ?? []).some((l) => !l.is_dir && versionsOf(l).length > 1 && !comparisons.has(l.dest));

  /** The version a file comes from, unless it's being merged. */
  const keeper = (l: Linkable): Version => {
    const vs = versionsOf(l);
    const c = comparisons.get(l.dest);
    return (
      vs.find((v) => v.hash === keep[l.dest]) ??
      (policy !== "newest" && policy !== "merge"
        ? vs.find((v) => v.copies.some((c) => c.installation === policy))
        : undefined) ??
      (policy === "merge" && c?.kind === "additive" ? vs[c.superset] : undefined) ??
      vs[0]
    );
  };

  /** Merging writes a new file; identical or one-has-it-all files never need to. */
  const merging = (l: Linkable) => {
    const c = comparisons.get(l.dest);
    return policy === "merge" && !keep[l.dest] && !!c?.mergeable && (c.kind === "combine" || c.kind === "conflict");
  };
  const mergedText = (l: Linkable) => {
    const vs = versionsOf(l);
    return mergeText(vs.map((v) => texts[v.hash] ?? ""), comparisons.get(l.dest)!, l.dest, 0, picks[l.dest]);
  };
  // servers.dat is rewritten by the game, so it's safer as each installation's own
  const howOf = (l: Linkable) => how[l.dest] ?? (l.dest === "servers.dat" ? "clone" : "link");

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
      // read every differing file up front, so the list can say which need attention
      const wanted = new Map<string, string>();
      for (const l of list) {
        const vs = l.is_dir || !TEXT.test(l.dest) ? [] : versionsOf(l);
        if (vs.length > 1) for (const v of vs) if (!(v.hash in texts)) wanted.set(v.hash, source(v).path);
      }
      const read = await Promise.all(
        [...wanted].map(([hash, path]) =>
          api.readConfig(path).then((t) => [hash, t] as const, () => [hash, null] as const)
        )
      );
      if (id === scanId.current) setTexts((m) => ({ ...m, ...Object.fromEntries(read) }));
    } catch (e) {
      if (id !== scanId.current) return;
      notify(String(e));
      setStep("pick");
    }
  }

  const differs = (l: Linkable) => !l.is_dir && versionsOf(l).length > 1;
  const needing = (scan ?? []).filter((l) => {
    const c = comparisons.get(l.dest);
    const settled = !!keep[l.dest] || (merging(l) && c!.conflicts.every((k) => picks[l.dest]?.[k] !== undefined));
    return on.has(l.dest) && needsYou(c) && !settled;
  });
  const visible = (scan ?? []).filter(
    (l) =>
      l.dest.toLowerCase().includes(find.toLowerCase()) &&
      (!attention || needsYou(comparisons.get(l.dest)))
  );
  const focused = scan?.find((l) => l.dest === focus) ?? null;

  // a file not read up front (it was linked since, say) is read when opened, for the comparison
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
    const k = merging(l) ? null : keeper(l);
    return l.copies.filter((c) => c.link === null && c.hash !== k?.hash).map((c) => `${c.installation} · ${l.dest}`);
  });
  // a folder linked from some standard can't merge into Shared; it's left alone
  const mergeable = (l: Linkable, inst: string) =>
    !l.copies.some((c) => c.installation === inst && c.link && c.link !== "Shared");
  const canLink = ticked.length > 0 && (files.length === 0 || nameOk) && !busy && !reading;

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
          const merged = merging(l) ? mergedText(l) : null;
          if (merged != null) await api.adoptText(name, l.dest, merged);
          else await api.adoptFile(name, source(keeper(l)).path, l.dest);
        }
        const rels = (m: "link" | "clone") => files.filter((l) => howOf(l) === m).map((l) => `${name}/${l.dest}`);
        for (const i of pickedList) {
          tick(`Applying to ${i.name}`);
          if (rels("link").length) await api.linkStandard(name, i.name, rels("link"), true);
          if (rels("clone").length) await api.copyStandard(name, i.name, rels("clone"));
        }
      }
      for (const i of folders.length ? pickedList : []) {
        tick(`Merging ${i.name}`);
        const dirs = folders.filter((l) => mergeable(l, i.name)).map((l) => l.dest);
        if (dirs.length) renamed.push(...(await api.mergeShared(i.name, dirs)));
      }
      setResult(
        [
          files.some((l) => howOf(l) === "link") &&
            `${plural(files.filter((l) => howOf(l) === "link").length, "file")} linked through "${name}"`,
          files.some((l) => howOf(l) === "clone") &&
            `${plural(files.filter((l) => howOf(l) === "clone").length, "file")} cloned, each installation keeps its own`,
          files.some(merging) && `${plural(files.filter(merging).length, "file")} merged`,
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
    setPicks({});
    setHow({});
    setTexts({});
    setPolicy("merge");
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
                ? "Settings that match are handled for you. Only real clashes need a decision."
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
              <div className="segmented small">
                <button className={attention ? "" : "active"} onClick={() => setAttention(false)}>
                  All
                </button>
                <button className={attention ? "active" : ""} onClick={() => setAttention(true)}>
                  Needs you{needing.length > 0 && ` · ${needing.length}`}
                </button>
              </div>
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
                        status={verdict(comparisons.get(l.dest))}
                        onFocus={() => setFocus(l.dest)}
                        onTick={() => setTicked([l.dest], !on.has(l.dest))}
                      />
                    ))}
                  </div>
                );
              })}
              {visible.length === 0 && <p className="le-empty">{attention ? "Nothing needs you — the rest merges cleanly." : "Nothing here."}</p>}
            </div>
          </div>

          <div className="lw-detail">
            {pickedList.length > 1 && scan.some(differs) && (
              <label className="lw-policy">
                Build the shared copy by
                <select
                  value={policy}
                  onChange={(e) => {
                    setPolicy(e.target.value);
                    setKeep({});
                  }}
                >
                  <option value="merge">merging them (recommended)</option>
                  <option value="newest">using the newest of each</option>
                  {pickedList.map((i) => (
                    <option key={i.name} value={i.name}>
                      staying true to {i.name}
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
                merging={merging(focused)}
                comparison={comparisons.get(focused.dest)}
                picks={picks[focused.dest] ?? {}}
                how={howOf(focused)}
                picked={pickedList}
                texts={texts}
                instOf={instOf}
                onKeep={(hash) => {
                  setKeep({ ...keep, [focused.dest]: hash });
                  setTicked([focused.dest], true);
                }}
                onMerge={() => {
                  const { [focused.dest]: _, ...rest } = keep;
                  setKeep(rest);
                  setPolicy("merge");
                  setTicked([focused.dest], true);
                }}
                onPick={(key, version) => {
                  setPicks({ ...picks, [focused.dest]: { ...picks[focused.dest], [key]: version } });
                  setArmed(false);
                }}
                onHow={(m) => setHow({ ...how, [focused.dest]: m })}
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
                    reading && "Reading files…",
                    plural(ticked.length, "item"),
                    needing.length > 0 && `${needing.length} using the default choice`,
                    replaced.length && `${plural(replaced.length, "copy", "copies")} to Trash`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
              </span>
              {files.length > 0 && (
                <label className="lw-via" title={existing ? "Adds to this standard" : "A new standard: a folder linked into each installation"}>
                  Save to
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
  status,
  onFocus,
  onTick,
}: {
  l: Linkable;
  on: boolean;
  focus: boolean;
  synced: boolean;
  versions: number;
  status: [string, string];
  onFocus: () => void;
  onTick: () => void;
}) {
  // a badge only when it tells you something
  const badge = synced
    ? ["synced", "in sync"]
    : l.is_dir
      ? ["", String(l.copies.reduce((n, c) => n + (c.link ? 0 : c.names.length), 0) || "")]
      : versions > 1
        ? status
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
  merging,
  comparison: c,
  picks,
  how,
  picked,
  texts,
  instOf,
  onKeep,
  onMerge,
  onPick,
  onHow,
}: {
  l: Linkable;
  versions: Version[];
  keeper: Version;
  merging: boolean;
  comparison?: Comparison;
  picks: Record<string, number>;
  how: "link" | "clone";
  picked: Installation[];
  texts: Record<string, string | null>;
  instOf: (n: string) => Installation | undefined;
  onKeep: (hash: string) => void;
  onMerge: () => void;
  onPick: (key: string, version: number) => void;
  onHow: (m: "link" | "clone") => void;
}) {
  const [peek, setPeek] = useState<string | null>(null);
  const [showAdded, setShowAdded] = useState(false);
  const missing = picked.filter((i) => !l.copies.some((c) => c.installation === i.name));
  const textual = TEXT.test(l.dest);
  const ki = Math.max(0, versions.findIndex((v) => v.hash === keeper.hash));
  const several = versions.length > 1;
  const canMerge = !!c?.mergeable && (c.kind === "combine" || c.kind === "conflict");
  const added = c ? c.keys.filter((k) => !c.conflicts.includes(k)) : [];
  const whoHas = (k: string) => c!.maps.flatMap((m, i) => (m.has(k) ? [letter(i)] : [])).join(", ");
  // a version that lacks the setting can't supply it: the first that has it does
  const chosen = (key: string) => {
    const want = merging ? (picks[key] ?? 0) : ki;
    return c!.maps[want]?.has(key) ? want : c!.maps.findIndex((m) => m.has(key));
  };
  const summary = !several
    ? l.copies.length > 1
      ? "Identical everywhere."
      : "Only one installation has it."
    : !c
      ? "Reading…"
      : c.kind === "same"
        ? "Same settings — only the order or formatting differs. Nothing is lost either way."
        : c.kind === "additive"
          ? `${letter(c.superset)} has everything, plus ${plural(c.keys.length, "setting")} the others don't — usually a newer mod version. Using ${letter(c.superset)} loses nothing.`
          : c.kind === "combine"
            ? c.mergeable
              ? `No clashes: each has settings the others lack, so they combine cleanly.`
              : "Each has settings the others lack, and this format can't be combined safely. Pick the one to keep."
            : c.kind === "conflict"
              ? c.mergeable
                ? `${plural(c.conflicts.length, "setting")} ${c.conflicts.length === 1 ? "has" : "have"} different values. Click the value you want.`
                : `${plural(c.conflicts.length, "setting")} ${c.conflicts.length === 1 ? "has" : "have"} different values, and this format can't be combined safely. Pick the one to keep.`
              : "These can't be compared setting by setting. Pick the one to keep.";

  return (
    <div className="lw-detail-body">
      <h2 className="lw-detail-title">
        <code>{l.dest}</code>
      </h2>
      <p className="hint">
        {summary}
        {missing.length > 0 && ` Also goes to ${missing.map((i) => i.name).join(", ")}.`}
      </p>

      <div className="lw-how" role="radiogroup" aria-label="How installations get this file">
        <button role="radio" aria-checked={how === "link"} className={how === "link" ? "on" : ""} onClick={() => onHow("link")}>
          <b>Link</b>
          <span>One file, always in sync</span>
        </button>
        <button role="radio" aria-checked={how === "clone"} className={how === "clone" ? "on" : ""} onClick={() => onHow("clone")}>
          <b>Clone</b>
          <span>Each keeps its own copy</span>
        </button>
      </div>

      <div className="lw-versions">
        {canMerge && (
          <button className={`lw-version pickable lw-merge ${merging ? "kept" : ""}`} onClick={onMerge}>
            <span className="lw-version-head">
              <span className="lw-letter">+</span>
              <span className="lw-who">Merge all versions</span>
              <span className="lw-meta">keeps every setting</span>
            </span>
          </button>
        )}
        {versions.map((v, k) => {
          const kept = k === ki && !merging;
          return (
            <div
              key={v.hash}
              className={`lw-version ${several ? "pickable" : ""} ${kept && several ? "kept" : ""}`}
              onClick={() => onKeep(v.hash)}
            >
              <div className="lw-version-head">
                {several && <span className="lw-letter">{letter(k)}</span>}
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

      {several && c && c.kind !== "same" && (
        <div className="lw-diff">
          {c.kind === "unknown" ? (
            textual ? <LineDiff versions={versions} keeper={ki} texts={versions.map((v) => texts[v.hash] ?? "")} /> : null
          ) : (
            <>
              {c.conflicts.length > 0 && (
                <div className="lw-table-wrap">
                  <table className="lw-table">
                    <thead>
                      <tr>
                        <th>{plural(c.conflicts.length, "clash", "clashes")}</th>
                        {versions.map((v, k) => (
                          <th key={v.hash}>{letter(k)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {c.conflicts.map((key) => (
                        <tr key={key}>
                          <td className="lw-key">{key}</td>
                          {c.maps.map((m, k) => {
                            const v = m.get(key);
                            const on = sameValue(v, c.maps[chosen(key)]?.get(key));
                            return (
                              <td key={k} className={on ? "kept" : ""}>
                                {v === undefined ? (
                                  <span className="lw-none">—</span>
                                ) : merging ? (
                                  <button className="lw-cell" title={v} aria-pressed={on} onClick={() => onPick(key, k)}>
                                    {v}
                                  </button>
                                ) : (
                                  v
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {added.length > 0 && (
                <>
                  <button className="linklike lw-added" onClick={() => setShowAdded(!showAdded)}>
                    {showAdded ? "Hide" : "Show"} {plural(added.length, "setting")} only some have
                  </button>
                  {showAdded && (
                    <ul className="lw-added-list">
                      {added.map((k) => (
                        <li key={k}>
                          <code>{k}</code>
                          <span>in {whoHas(k)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
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
