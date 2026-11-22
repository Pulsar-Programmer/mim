import { convertFileSrc } from "@tauri-apps/api/core";
import { Installation, Standard } from "./api";

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
    <div className="places">
      {places.map((p) => (
        <PlaceChip key={p.key} place={p} active={p.key === value} onClick={() => onChange(p.key)} />
      ))}
    </div>
  );
}

/**
 * "All", then the shared Minecraft folder with the installations linked to it
 * nested inside, then installations that keep their own copy of `dir`.
 */
export function sharedPlaces(
  dir: "saves" | "screenshots" | "resourcepacks",
  locations: string[],
  installations: Installation[],
  countOf: (location: string) => number
): Place[] {
  const linked = installations.filter((i) => i.linked.includes(dir));
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
    ...locations
      .filter((l) => l !== "Shared")
      .map((l) => ({
        key: l,
        label: l,
        inst: installations.find((i) => i.name === l),
        count: countOf(l),
        sub: "own folder",
      })),
  ];
}
