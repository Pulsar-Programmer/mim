import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Installation, InstanceItem, Standard } from "./api";
import { Modal } from "./Modal";

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
  std?: Standard;
  count?: number;
  sub?: string;
  /** installations that use this place through a link */
  members?: Installation[];
  /** has none of this yet: stays behind the + until picked */
  empty?: boolean;
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
  const [adding, setAdding] = useState(false);
  if (places.length < 2) return null;
  const hidden = places.filter((p) => p.empty && p.key !== value);
  return (
    <div className="places" role="group" aria-label="Instances">
      <span className="places-label" aria-hidden>
        Instances
      </span>
      {places
        .filter((p) => !p.empty || p.key === value)
        .map((p) => (
          <PlaceChip key={p.key} place={p} active={p.key === value} onClick={() => onChange(p.key)} />
        ))}
      {hidden.length > 0 && (
        <button className="place place-add" aria-label="Add an instance" title="Add an instance" onClick={() => setAdding(true)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {adding && (
        <Modal className="share-dialog" label="Add an instance" onClose={() => setAdding(false)}>
          <div className="share-body">
            <header className="share-head">
              <div>
                <h2>Add an instance</h2>
                <p className="hint">Pick one to start adding to it. It stays in the bar once it has something.</p>
              </div>
            </header>
            <div className="places">
              {hidden.map((p) => (
                <PlaceChip
                  key={p.key}
                  place={p}
                  active={false}
                  onClick={() => {
                    setAdding(false);
                    onChange(p.key);
                  }}
                />
              ))}
            </div>
            <footer className="share-foot">
              <button className="btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}

export const stdScope = (name: string) => `standards/${name}`;
/** A scope or location, as a person reads it. */
export const scopeName = (scope: string) => scope.replace(/^standards\//, "");

/**
 * The bar: every standard first, each with the installations using its `item`,
 * then installations only where their `item` is standalone.
 */
export function instancePlaces(
  item: InstanceItem,
  installations: Installation[],
  standards: Standard[],
  detail: (i: Installation) => string = () => ""
): Place[] {
  const uses = (s: Standard, i: Installation) =>
    s.entries.some(
      (e) =>
        e.scope === "global" &&
        (e.name === item || e.name.startsWith(`${item}/`)) &&
        s.linked[i.name]?.includes(e.rel_path)
    );
  const place = (s: Standard): Place => {
    const members = installations.filter((i) => uses(s, i));
    return {
      key: s.builtin ? "" : stdScope(s.name),
      label: s.name,
      kind: s.builtin ? "root" : undefined,
      std: s,
      sub: members.length ? `${members.length} linked` : "standard",
      members,
      empty:
        !s.builtin && !s.entries.some((e) => e.scope === "global" && (e.name === item || e.name.startsWith(`${item}/`))),
    };
  };
  const root = standards.find((s) => s.builtin);
  const alone = installations
    .filter((i) => i.standalone.includes(item))
    // two linked to the same non-standard folder are one place
    .filter((i, n, all) => !i.links[item] || all.findIndex((o) => o.links[item]?.dir === i.links[item]?.dir) === n);
  return [
    root ? place(root) : { key: "", label: "Shared", kind: "root", sub: "standard", members: [] },
    ...standards.filter((s) => !s.builtin).map(place),
    ...alone.map((i) => ({
      key: i.name,
      label: i.name,
      inst: i,
      sub: [detail(i), i.links[item] ? `from ${i.links[item]!.from}` : "standalone"].filter(Boolean).join(" · "),
    })),
    ...installations
      .filter((i) => !i.standalone.includes(item) && !i.links[item] && !standards.some((s) => uses(s, i)))
      .map((i) => ({ key: i.name, label: i.name, inst: i, sub: "nothing here yet", empty: true })),
  ];
}

/** "All", then the bar, keyed by the locations saves and screenshots report. */
export function sharedPlaces(
  dir: "saves" | "screenshots",
  installations: Installation[],
  standards: Standard[],
  countOf: (location: string) => number
): Place[] {
  const places = instancePlaces(dir, installations, standards).map((p) => {
    const key = p.key || "Shared";
    return { ...p, key, count: countOf(key) };
  });
  return [
    { key: "all", label: "All", kind: "all", count: places.reduce((n, p) => n + p.count, 0) },
    ...places,
  ];
}
