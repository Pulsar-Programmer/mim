/** Compares config files by their settings, not their text: order, comments and
 * formatting don't count as differences. */

type Format = "flat" | "json" | "nested";
interface Parsed {
  map: Map<string, string>;
  format: Format;
}

export interface Comparison {
  /** same: only order/format differ · additive: one has everything the others do ·
   * combine: no clashes, but each has settings the others lack · conflict: values clash ·
   * unknown: can't be read as settings */
  kind: "same" | "additive" | "combine" | "conflict" | "unknown";
  maps: Map<string, string>[];
  /** every setting that isn't identical everywhere */
  keys: string[];
  /** the settings with two different values */
  conflicts: string[];
  /** the version holding everything, for additive */
  superset: number;
  /** whether a combined file can be written */
  mergeable: boolean;
}

/** Binary NBT files, read as JSON. */
export const NBT = /\.(dat|dat_old|nbt)$/i;

const NUM = /^-?\d+(\.\d+)?$/;
/** 1 and 1.0 are the same setting. */
export const sameValue = (a?: string, b?: string) =>
  a === b || (a !== undefined && b !== undefined && NUM.test(a) && NUM.test(b) && +a === +b);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseJson(text: string): Parsed | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(root)) return null;
  const map = new Map<string, string>();
  const walk = (o: Record<string, unknown>, at: string) => {
    for (const [k, v] of Object.entries(o)) {
      const p = at ? `${at}.${k}` : k;
      if (isObj(v) && Object.keys(v).length) walk(v, p);
      else map.set(p, typeof v === "string" ? v : JSON.stringify(v));
    }
  };
  walk(root, "");
  return { map, format: "json" };
}

/** Drops a trailing comment, leaving anything inside quotes alone. */
function stripComment(line: string, mark: string) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (line.startsWith(mark, i)) return line.slice(0, i);
  }
  return line;
}

const KEY = /^("[^"]*"|'[^']*'|[^=:]+?)\s*[:=]\s*(.*)$/;
const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, "$2");

/** Pretty-printed json5, toml, .properties, options.txt… one setting per line. */
function parseLines(text: string, dest: string): Parsed | null {
  const mark = /\.(json5?|jsonc|hjson)$/i.test(dest) ? "//" : /\.toml$/i.test(dest) ? "#" : "";
  const map = new Map<string, string>();
  const stack: string[] = [];
  let section = "";
  let nested = false;
  let block = false;
  let list: { key: string; depth: number; parts: string[] } | null = null;
  const put = (k: string, v: string) => {
    const p = [section, ...stack, k].filter(Boolean).join(".");
    if (map.has(p)) return false;
    map.set(p, v);
    return true;
  };
  for (const raw of text.split(/\r?\n/)) {
    let l = raw.trim();
    if (block) {
      if (!l.includes("*/")) continue;
      l = l.slice(l.indexOf("*/") + 2).trim();
      block = false;
    }
    if (mark === "//" && l.startsWith("/*")) {
      if (!l.includes("*/")) block = true;
      continue;
    }
    if (mark) l = stripComment(l, mark).trim();
    if (!l || /^([#;!]|\/\/)/.test(l)) continue;
    l = l.replace(/,$/, "").trim();
    if (list) {
      if (/^[\]}]/.test(l)) list.depth--;
      if (/[[{]$/.test(l)) list.depth++;
      list.parts.push(l);
      if (list.depth === 0) {
        if (!put(list.key, list.parts.join(" "))) return null;
        list = null;
      }
      continue;
    }
    if (l === "{" && !stack.length && !map.size) {
      stack.push("");
      continue;
    }
    if (/^[}\]]$/.test(l)) {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    if (!stack.length && /^\[\[?[^\]]+\]\]?$/.test(l)) {
      section = l.replace(/[[\]]/g, "").trim();
      nested = true;
      continue;
    }
    const m = KEY.exec(l);
    if (!m) return null;
    const key = unquote(m[1].trim());
    if (m[2] === "{") {
      stack.push(key);
      nested = true;
    } else if (m[2] === "[") {
      list = { key, depth: 1, parts: ["["] };
      nested = true;
    } else if (!put(key, unquote(m[2]))) return null;
  }
  if (list || stack.length || !map.size) return null;
  return { map, format: nested || mark === "//" ? "nested" : "flat" };
}

const parse = (text: string, dest: string) =>
  (/\.json$/i.test(dest) || text.trimStart().startsWith("{") ? parseJson(text) : null) ?? parseLines(text, dest);

/** options.txt's data version isn't a preference: the highest always wins. */
const isVersionKey = (k: string, dest: string) => k === "version" && dest === "options.txt";

export function compare(texts: (string | null)[], dest: string): Comparison {
  const unknown: Comparison = { kind: "unknown", maps: [], keys: [], conflicts: [], superset: -1, mergeable: false };
  const parsed = texts.map((t) => (t == null ? null : parse(t, dest)));
  if (parsed.some((p) => !p)) return unknown;
  const ps = parsed as Parsed[];
  const maps = ps.map((p) => p.map);
  const all = [...new Set(maps.flatMap((m) => [...m.keys()]))].filter((k) => !isVersionKey(k, dest));
  const distinct = (k: string) => {
    const vals: string[] = [];
    for (const m of maps) {
      const v = m.get(k);
      if (v !== undefined && !vals.some((x) => sameValue(x, v))) vals.push(v);
    }
    return vals.length;
  };
  const keys = all.filter((k) => distinct(k) > 1 || maps.some((m) => !m.has(k)));
  const conflicts = keys.filter((k) => distinct(k) > 1);
  const superset = conflicts.length ? -1 : maps.findIndex((m) => all.every((k) => m.has(k)));
  const format = ps[0].format;
  // binary NBT (.dat, .nbt) is shown as JSON but can only be replaced whole
  const mergeable = !NBT.test(dest) && format !== "nested" && ps.every((p) => p.format === format);
  const kind = !keys.length ? "same" : conflicts.length ? "conflict" : superset >= 0 ? "additive" : "combine";
  return { kind, maps, keys, conflicts, superset, mergeable };
}

/** Which version supplies setting `k`: a pick, else `base`, else the first that has it. */
function chooser(maps: Map<string, string>[], base: number, picks: Record<string, number>, dest: string) {
  return (k: string) => {
    if (isVersionKey(k, dest)) {
      let best = base;
      maps.forEach((m, i) => {
        if (+(m.get(k) ?? -1) > +(maps[best].get(k) ?? -1)) best = i;
      });
      return best;
    }
    const p = picks[k];
    if (p !== undefined && maps[p]?.has(k)) return p;
    return maps[base].has(k) ? base : maps.findIndex((m) => m.has(k));
  };
}

/** One file with every version's settings except `skip`, in `base`'s layout. Null if it can't be written. */
export function mergeText(
  texts: string[],
  cmp: Comparison,
  dest: string,
  base: number,
  picks: Record<string, number> = {},
  skip: ReadonlySet<string> = new Set()
): string | null {
  if (!cmp.mergeable) return null;
  const choose = chooser(cmp.maps, base, picks, dest);
  if (parse(texts[base], dest)?.format === "json") {
    const roots = texts.map((t) => JSON.parse(t) as Record<string, unknown>);
    const join = (objs: (Record<string, unknown> | undefined)[], at: string) => {
      const out: Record<string, unknown> = {};
      const names = [...new Set([objs[base], ...objs].flatMap((o) => (o ? Object.keys(o) : [])))];
      for (const n of names) {
        const p = at ? `${at}.${n}` : n;
        const vals = objs.map((o) => o?.[n]);
        const present = vals.filter((v) => v !== undefined);
        if (present.every((v) => isObj(v) && Object.keys(v).length)) {
          const inner = join(vals.map((v) => v as Record<string, unknown> | undefined), p);
          if (Object.keys(inner).length) out[n] = inner; // empty only if all of it was skipped
        } else if (!skip.has(p)) {
          const c = choose(p);
          out[n] = c >= 0 && vals[c] !== undefined ? vals[c] : vals[base] !== undefined ? vals[base] : present[0];
        }
      }
      return out;
    };
    return JSON.stringify(join(roots, ""), null, 2) + "\n";
  }
  // flat: keep base's lines, swap the picked ones, add what it lacks
  const rawOf = (t: string) => {
    const m = new Map<string, string>();
    for (const line of t.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || /^[#;!]/.test(l)) continue;
      const x = KEY.exec(l);
      if (x) m.set(unquote(x[1].trim()), line);
    }
    return m;
  };
  const raws = texts.map(rawOf);
  const seen = new Set<string>();
  const out = texts[base].split(/\r?\n/).flatMap((line) => {
    const l = line.trim();
    const x = l && !/^[#;!]/.test(l) ? KEY.exec(l) : null;
    if (!x) return [line];
    const k = unquote(x[1].trim());
    seen.add(k);
    return skip.has(k) ? [] : [raws[choose(k)]?.get(k) ?? line];
  });
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const k of new Set(cmp.maps.flatMap((m) => [...m.keys()])))
    if (!seen.has(k) && !skip.has(k)) out.push(raws[choose(k)].get(k)!);
  return out.join("\n") + "\n";
}
