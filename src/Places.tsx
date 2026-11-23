import { convertFileSrc } from "@tauri-apps/api/core";
import { Installation, InstanceItem, Standard } from "./api";

// deterministic soft gradient for installations without a custom image
export function nameGradient(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 32% 88%), hsl(${(h + 40) % 360} 38% 78%))`;
}

const FOLDER = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path
      d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
      fill="currentColor"
    />
  </svg>
);
const GRID = (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
    {[2, 9].flatMap((x) =>
      [2, 9].map((y) => <rect key={`${x}${y}`} x={x} y={y} width="5" height="5" rx="1.2" fill="currentColor" />)
    )}
  </svg>
);

/** A standard: the built-in one gets the folder glyph, others their first picture. */
export function StandardAvatar({ s }: { s: Standard }) {
  if (s.builtin) return <Avatar kind="root" />;
  return s.images[0] ? (
    <span className="ava" style={{ backgroundImage: `url(${convertFileSrc(s.images[0])})` }} />
  ) : (
    <Avatar name={s.name} />
  );
}

/** An installation's picture, or a glyph for "all" / the Minecraft folder. */
export function Avatar({
  inst,
  name,
  kind,
  small,
}: {
  inst?: Installation;
  name?: string;
  kind?: "all" | "root";
  small?: boolean;
}) {
  const cls = `ava ${small ? "small" : ""}`;
  if (kind === "all") return <span className={`${cls} all`}>{GRID}</span>;
  if (kind === "root") return <span className={`${cls} root`}>{FOLDER}</span>;
  const n = inst?.name ?? name ?? "?";
  return inst?.icon?.startsWith("data:") ? (
    <span className={cls} style={{ backgroundImage: `url(${inst.icon})` }} />
  ) : (
    <span className={cls} style={{ background: nameGradient(n) }}>
      {n[0]}
    </span>
  );
}

export interface Place {
  key: string;
  label: string;
  kind?: "all" | "root";
  inst?: Installation;
  count?: number;
  sub?: string;
  /** installations that use this place through a link */
  members?: Installation[];
}

/** One selectable place — the same chip everywhere a folder is picked. */
export function PlaceChip({
  place,
  active,
  onClick,
  title,
  className = "",
}: {
  place: Place;
  active: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  const { label, kind, inst, count, sub, members = [] } = place;
  return (
    <button
      className={`place ${active ? "active" : ""} ${className}`}
      onClick={onClick}
      title={title ?? (members.length ? `Also used by ${members.map((m) => m.name).join(", ")}` : label)}
    >
      <Avatar kind={kind} inst={inst} name={label} />
      <span className="place-text">
        <span className="place-label">
          {label}
          {count != null && <span className="place-count">{count}</span>}
        </span>
        {sub && <span className="place-sub">{sub}</span>}
      </span>
      {members.length > 0 && (
        <span className="members">
          {members.slice(0, 4).map((m) => (
            <Avatar key={m.name} inst={m} small />
          ))}
          {members.length > 4 && <span className="more">+{members.length - 4}</span>}
        </span>
      )}
    </button>
  );
}

export function PlacePicker({
  places,
  value,
  onChange,
}: {
  places: Place[];
  value: string;
  onChange: (key: string) => void;
}) {
  if (places.length < 2) return null;
  return (
    <div className="places" role="group" aria-label="Instances">
      <span className="places-label" aria-hidden>
        Instances
      </span>
      {places.map((p) => (
        <PlaceChip key={p.key} place={p} active={p.key === value} onClick={() => onChange(p.key)} />
      ))}
    </div>
  );
}

/**
 * One place per instance of `item`: installations linking the same real
 * folder are one place, keyed by the first. The Minecraft folder comes last.
 */
export function instancePlaces(
  item: InstanceItem,
  installations: Installation[],
  detail: (i: Installation) => string,
  rootSub: string
): Place[] {
  const sub = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const places = installations.flatMap<Place>((i) => {
    const link = i.links[item];
    if (!link) return [{ key: i.name, label: i.name, inst: i, sub: detail(i) || "own folder", members: [] }];
    if (link.from === "Shared") return [];
    const group = installations.filter((o) => o.links[item]?.dir === link.dir);
    if (group[0] !== i) return [];
    return group.length > 1
      ? [{ key: i.name, label: link.from, sub: sub(detail(i), `${group.length} linked`), members: group }]
      : [{ key: i.name, label: i.name, inst: i, sub: sub(detail(i), `from ${link.from}`), members: [] }];
  });
  const inRoot = installations.filter((i) => i.links[item]?.from === "Shared");
  return [
    ...places,
    {
      key: "",
      label: "Minecraft folder",
      kind: "root",
      sub: inRoot.length ? `${inRoot.length} linked` : rootSub,
      members: inRoot,
    },
  ];
}

/**
 * "All", then the shared Minecraft folder with the installations linked to it
 * nested inside, then each other instance of `dir`. `locations` name an
 * instance by one of its installations.
 */
export function sharedPlaces(
  dir: "saves" | "screenshots",
  locations: string[],
  installations: Installation[],
  countOf: (location: string) => number
): Place[] {
  const linked = installations.filter((i) => i.links[dir]?.from === "Shared");
  const place = (l: string): Place => {
    const inst = installations.find((i) => i.name === l);
    const link = inst?.links[dir];
    const group = link ? installations.filter((o) => o.links[dir]?.dir === link.dir) : [];
    return group.length > 1
      ? { key: l, label: link!.from, count: countOf(l), sub: `${group.length} linked`, members: group }
      : { key: l, label: l, inst, count: countOf(l), sub: link ? `from ${link.from}` : "own folder" };
  };
  return [
    { key: "all", label: "All", kind: "all", count: locations.reduce((n, l) => n + countOf(l), 0) },
    {
      key: "Shared",
      label: "Shared",
      kind: "root",
      count: countOf("Shared"),
      sub: linked.length ? `${linked.length} linked` : "Minecraft folder",
      members: linked,
    },
    ...locations.filter((l) => l !== "Shared").map(place),
  ];
}
