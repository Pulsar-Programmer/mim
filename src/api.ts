import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

/** Asks first when these items live in a folder other installations share. */
export async function okToChangeShared(paths: string[], what: string, followLinks = false): Promise<boolean> {
  const who = await api.sharedWith(paths, followLinks);
  return (
    !who.length ||
    ask(`${what} also affects ${who.join(", ")}, because this folder is shared.`, {
      title: "Shared folder",
      kind: "warning",
      okLabel: "Continue",
      cancelLabel: "Cancel",
    })
  );
}

export type InstanceItem =
  | "mods"
  | "resourcepacks"
  | "shaderpacks"
  | "saves"
  | "screenshots"
  | "options.txt"
  | "servers.dat"
  | "config"
  | "logs";

export interface Installation {
  name: string;
  path: string;
  version_id: string | null;
  game_version: string | null;
  loader: string | null;
  icon: string | null;
  last_used: string | null;
  created: string | null;
  mods_count: number;
  /** which shareable items are links, and to what */
  links: Partial<Record<InstanceItem, { from: string; dir: string }>>;
  /** what it keeps itself, outside any standard */
  standalone: InstanceItem[];
  registered: boolean;
  linked: string[];
  unlinked: string[];
}

export interface GameVersion {
  id: string;
  type: string;
}

export interface LoaderVersion {
  version: string;
  stable: boolean;
}

export interface StandardEntry {
  name: string;
  rel_path: string;
  scope: string;
  is_dir: boolean;
  /** on Shared's list, but the Minecraft folder doesn't have it yet */
  missing: boolean;
}

export interface Standard {
  name: string;
  path: string;
  /** the Minecraft folder itself; its entries are the list the user keeps */
  builtin: boolean;
  installations: string[];
  /** installation -> the entries (rel_path) that are live links in it */
  linked: Record<string, string[]>;
  entries: StandardEntry[];
  /** image files at the standard's top level */
  images: string[];
}

export interface LinkState {
  /** free: nothing there yet · own: the installation's own copy (linking trashes it) ·
   * other: a link to somewhere else */
  state: "linked" | "free" | "own" | "other";
  /** for "other": the standard it's linked from */
  from: string | null;
}

export interface FolderLink {
  folder: string;
  /** the installation's folder is itself one link to the standard's */
  whole: boolean;
  /** what linking it whole would replace */
  in_way: string[];
}

/** Entries that apply to a game version: global ones plus that version's folder. */
export const entriesFor = (s: Standard, gameVersion: string | null) => {
  // Possible future feature: version-only items, kept in a subfolder like 1.21.10/.
  // Probably not needed, since a separate standard covers a one-version special case.
  // To bring it back, use this filter and restore the `{e.scope} only` chips:
  // return s.entries.filter((e) => !e.missing && (e.scope === "global" || e.scope === gameVersion));
  //
  // Old version subfolders still work, for every version. If several hold the
  // same item, the installation's own version wins, then the unversioned one.
  const rank = (e: StandardEntry) => (e.scope === gameVersion ? 2 : e.scope === "global" ? 1 : 0);
  const best = new Map<string, StandardEntry>();
  for (const e of s.entries) {
    const had = best.get(e.name);
    if (!e.missing && (!had || rank(e) > rank(had))) best.set(e.name, e);
  }
  return [...best.values()];
};

/** One installation's copy of something it could share. */
export interface InstCopy {
  installation: string;
  path: string;
  /** where it's linked from ("Shared", a standard, "elsewhere"); null: its own */
  link: string | null;
  size_bytes: number;
  /** unix seconds */
  modified: number;
  /** files: same hash, same content */
  hash: string;
  /** folders: what's inside */
  names: string[];
}

export interface Linkable {
  /** "options.txt", "config/sodium.json", "saves" */
  dest: string;
  is_dir: boolean;
  copies: InstCopy[];
  /** folders: what Shared already has */
  shared: string[];
}

export interface Pack {
  name: string;
  size_bytes: number;
  is_dir: boolean;
}

export interface PackInfo {
  file: string;
  path: string;
  description: string | null;
  icon: string | null;
  format: number | null;
  is_dir: boolean;
  size_bytes: number;
  modified: number;
}

export interface PackList {
  dir: string;
  /** the folder is a link to the shared one */
  linked: boolean;
  /** turned-on packs, top (winning) one first */
  enabled: string[];
  packs: PackInfo[];
}

export interface ConfigFile {
  /** relative to config/ */
  rel: string;
  path: string;
  size_bytes: number;
  modified: number;
  /** the standard its top-level entry in config/ is linked from */
  linked: string | null;
}

export interface ConfigOverview {
  dir: string;
  files: ConfigFile[];
  /** top-level things in the game folder Minecraft itself doesn't make */
  loose: FolderItem[];
}

export interface LogEntry {
  path: string;
  rel: string;
  name: string;
  kind: "game" | "crash" | "launcher" | "updater" | "debug";
  modified: string | null;
  size_bytes: number;
  sorted: boolean;
}

export type FolderCategory = "logs" | "cache" | "yours" | "game" | "launcher" | "other";

export interface FolderItem {
  name: string;
  path: string;
  category: FolderCategory;
  size_bytes: number;
  is_dir: boolean;
}

export interface World {
  folder: string;
  path: string;
  location: string;
  name: string;
  icon: string | null;
  last_played: number | null;
  game_mode: number | null;
  hardcore: boolean;
  cheats: boolean;
  version: string | null;
  seed: string | null;
  size_bytes: number;
}

export interface WorldDetails {
  parts: Pack[];
  datapacks: string[];
  players: number;
}

export interface OptionsSource {
  label: string;
  kind: "base" | "standard" | "installation";
  path: string;
  exists: boolean;
  /** where it's linked from ("Shared", a standard, "elsewhere"); null: its own */
  link: string | null;
  /** the real file, the same for every source linked to it */
  target: string;
}

export type OptionEntry = [string, string];

export interface Server {
  name: string;
  ip: string;
  icon: string | null;
  accept_textures: number | null;
  hidden: boolean;
}

export interface ServerList {
  installation: string | null;
  label: string;
  path: string;
  exists: boolean;
  servers: Server[];
  backup: Server[];
  archived: Server[];
}

export interface Ping {
  online: number;
  max: number;
  version: string;
  motd: string;
  latency_ms: number;
  favicon: string | null;
}

export interface Mod {
  file: string;
  path: string;
  enabled: boolean;
  id: string | null;
  name: string;
  version: string | null;
  description: string | null;
  authors: string[];
  loader: string | null;
  icon: string | null;
  size_bytes: number;
  /** unix seconds */
  modified: number;
  library: boolean;
}

export interface Screenshot {
  path: string;
  name: string;
  location: string;
  modified: string | null;
  size_bytes: number;
  width: number;
  height: number;
}

export interface ShaderPack {
  file: string;
  path: string;
  is_dir: boolean;
  size_bytes: number;
  modified: number;
}

export interface ShaderList {
  dir: string;
  linked: boolean;
  /** the pack Iris or OptiFine has on */
  active: string | null;
  /** settings files holding that choice; empty until a shader mod has run */
  configs: string[];
  packs: ShaderPack[];
}

export interface ShaderInfo {
  title: string;
  description: string;
  icon: string | null;
  page: string;
  downloads: number;
  images: { url: string; raw_url: string; title: string | null }[];
}

export interface Profile {
  id: string;
  name: string;
  kind: string;
  version_id: string | null;
  last_used: string | null;
  game_dir: string;
  shares_root: boolean;
  outside: boolean;
  missing: boolean;
  /** a launcher preset name or a data: URL */
  icon: string | null;
}

export interface ArchivedProfile {
  id: string;
  profile: { name?: string; lastVersionId?: string; icon?: string };
  game_dir: string;
  moved_dir: boolean;
  versions: string[];
  archived: string;
}

export interface ProfilesOverview {
  profiles: Profile[];
  archived: ArchivedProfile[];
  /** launcher preset name to its block texture */
  preset_icons: Record<string, string>;
  launcher_running: boolean;
  backups: string;
}

/** What a pasted Modrinth/CurseForge link points at. */
export interface LinkInfo {
  /** "mod", "modpack", "resourcepack", "shader", … or "collection" */
  kind: string;
  title: string;
  icon: string | null;
  projects: string[];
  game_versions: string[];
  loaders: string[];
  note: string | null;
}

export interface ImportReport {
  title: string;
  added: string[];
  skipped: string[];
}

/** "Added 3 from Sodium" — the skipped ones are listed separately. */
export const reportSummary = (r: ImportReport, verb = "Added") =>
  r.added.length === 0 && r.skipped.length === 0
    ? "Nothing to do — all up to date"
    : `${verb} ${r.added.length}${r.title ? ` from ${r.title}` : ""}` +
      (r.skipped.length ? ` · ${r.skipped.length} skipped` : "");

export interface UpgradeMod {
  file: string;
  name: string;
  icon: string | null;
  /** on Modrinth, so MIM can check and update it */
  known: boolean;
}

export interface UpgradeTarget {
  game: string;
  /** the installation's loader has a build for this version */
  loader_ok: boolean;
  /** files of known mods with no build for it */
  missing: string[];
}

export interface UpgradeScan {
  game: string;
  loader: string;
  mods: UpgradeMod[];
  /** newer releases, newest first */
  targets: UpgradeTarget[];
}

export type Loader = "vanilla" | "fabric" | "forge" | "neoforge";

export interface InstallSpec {
  name: string;
  game_version: string;
  loader: Loader;
  loader_version: string | null;
  /** linked: changes stay in sync */
  standards: string[];
  /** copied once, then the installation's own */
  copies: string[];
}

export const api = {
  listInstallations: () => invoke<Installation[]>("list_installations"),
  listGameVersions: () => invoke<GameVersion[]>("list_game_versions"),
  listLoaderVersions: (loader: Loader, gameVersion: string) =>
    invoke<LoaderVersion[]>("list_loader_versions", { loader, gameVersion }),
  createInstallation: (spec: InstallSpec) =>
    invoke<void>("create_installation", { spec }),
  /** Moves an installation's own saves/packs/screenshots into the Shared ones and
   * links them. Returns what was renamed to keep both. */
  mergeShared: (installation: string, folders: string[]) =>
    invoke<string[]>("merge_shared", { installation, folders }),
  listStandards: () => invoke<Standard[]>("list_standards"),
  ensureStandardsDir: () => invoke<string>("ensure_standards_dir"),
  createStandard: (name: string) => invoke<string>("create_standard", { name }),
  deleteStandard: (name: string) => invoke<void>("delete_standard", { name }),
  /** moves its folder and repoints every installation's links */
  renameStandard: (name: string, newName: string) =>
    invoke<void>("rename_standard", { name, newName }),
  /** Returns what's in the way; when non-empty and !replace, nothing was linked. */
  linkStandard: (name: string, installation: string, relPaths: string[], replace: boolean) =>
    invoke<string[]>("link_standard", { name, installation, relPaths, replace }),
  /** keep: leave the installation a real copy instead of removing the files.
   * relPaths: just those entries, otherwise all of it */
  unlinkStandard: (name: string, installation: string, keep: boolean, relPaths?: string[]) =>
    invoke<void>("unlink_standard", { name, installation, keep, relPaths }),
  /** how config folders stand in the installation; ones that can't be linked whole are left out */
  folderLinks: (name: string, installation: string, folders: [string, string[]][]) =>
    invoke<FolderLink[]>("folder_links", { name, installation, folders }),
  /** makes a config folder one link. Returns what's in the way; with !replace nothing changed then. */
  linkFolder: (name: string, installation: string, folder: string, relPaths: string[], replace: boolean) =>
    invoke<string[]>("link_folder", { name, installation, folder, relPaths, replace }),
  /** how each entry stands in the installation, in the order asked */
  linkStates: (name: string, installation: string, relPaths: string[]) =>
    invoke<LinkState[]>("link_states", { name, installation, relPaths }),
  /** what the installations could share, each one's copy side by side */
  scanLinkables: (installations: string[]) => invoke<Linkable[]>("scan_linkables", { installations }),
  /** copies the kept version of a file into a standard (the old one there goes to the Trash) */
  adoptFile: (standard: string, source: string, dest: string) =>
    invoke<void>("adopt_file", { standard, source, dest }),
  setCustomIcon: (name: string, imagePath: string) =>
    invoke<string>("set_custom_icon", { name, imagePath }),
  listPacks: (installation: string | null) => invoke<PackList>("list_packs", { installation }),
  /** top (winning) pack first */
  setPacks: (installation: string | null, enabled: string[]) =>
    invoke<void>("set_packs", { installation, enabled }),
  addPacks: (installation: string | null, files: string[]) =>
    invoke<number>("add_packs", { installation, files }),
  listConfig: (installation: string | null) => invoke<ConfigOverview>("list_config", { installation }),
  readConfig: (path: string) => invoke<string>("read_config", { path }),
  writeConfig: (path: string, text: string) => invoke<void>("write_config", { path, text }),
  /** saves a resolved file through any link; the old version goes to the Trash */
  writeMerged: (d: {
    path: string;
    text: string;
    whole: boolean;
    otherPath: string;
    take?: string[];
    skip?: string[];
    lists?: [string, [0 | 1, number][]][];
  }) =>
    invoke<void>("write_merged", {
      path: d.path,
      text: d.text,
      from: d.whole || d.take ? d.otherPath : null,
      take: d.take ?? null,
      skip: d.skip ?? null,
      lists: d.lists ?? null,
    }),
  /** every place that could hold a copy of this file */
  diffSources: (dest: string) => invoke<OptionsSource[]>("diff_sources", { dest }),
  /** Moves config/ entries into a standard and links them back. Returns the ones the
   * standard already has; when non-empty and !replace, nothing changed. */
  shareConfig: (installation: string, standard: string, names: string[], replace: boolean) =>
    invoke<string[]>("share_config", { installation, standard, names, replace }),
  /** Adds items to a standard, from an installation (moved in, linked back) or the
   * Minecraft folder (from = null). Returns what it already has; when non-empty and
   * neither replace nor merge settled it, nothing changed. */
  addToStandard: (standard: string, from: string | null, names: string[], replace: boolean, merge: boolean) =>
    invoke<string[]>("add_to_standard", { standard, from, names, replace, merge }),
  /** Takes items out of a standard. Installations using them keep a copy with `keep`,
   * otherwise lose them. A standard's files go to the Trash; Shared's stay put. */
  removeFromStandard: (name: string, relPaths: string[], keep: boolean) =>
    invoke<void>("remove_from_standard", { name, relPaths, keep }),
  /** Gives an installation its own copy of entries instead of links. */
  copyStandard: (name: string, installation: string, relPaths: string[]) =>
    invoke<void>("copy_standard", { name, installation, relPaths }),
  /** What's at the top of a game folder: [name, is folder] */
  listItems: (from: string | null) => invoke<[string, boolean][]>("list_items", { from }),
  adoptText: (standard: string, dest: string, text: string) =>
    invoke<void>("adopt_text", { standard, dest, text }),
  deleteInstallation: (name: string, removeProfile: boolean) =>
    invoke<void>("delete_installation", { name, removeProfile }),
  /** moves its folder and updates its launcher profile and standards */
  renameInstallation: (name: string, newName: string) =>
    invoke<void>("rename_installation", { name, newName }),
  /** copies its folder (links stay links), launcher profile and standards */
  duplicateInstallation: (name: string, newName: string) =>
    invoke<void>("duplicate_installation", { name, newName }),
  revealPath: (path: string, select = true) =>
    invoke<void>("reveal_path", { path, select }),
  openLauncher: () => invoke<void>("open_launcher"),
  minecraftDir: () => invoke<{ path: string; sample: boolean }>("minecraft_dir"),
  listSaves: () => invoke<World[]>("list_saves"),
  worldDetails: (path: string) => invoke<WorldDetails>("world_details", { path }),
  optionsSources: () => invoke<OptionsSource[]>("options_sources"),
  readOptions: (path: string) => invoke<OptionEntry[]>("read_options", { path }),
  writeOptions: (path: string, entries: OptionEntry[]) =>
    invoke<void>("write_options", { path, entries }),
  listServers: () => invoke<ServerList[]>("list_servers"),
  writeServers: (installation: string | null, servers: Server[]) =>
    invoke<void>("write_servers", { installation, servers }),
  setServerArchived: (installation: string | null, server: Server, archived: boolean) =>
    invoke<void>("set_server_archived", { installation, server, archived }),
  deleteArchivedServer: (installation: string | null, server: Server) =>
    invoke<void>("delete_archived_server", { installation, server }),
  restoreServersBackup: (installation: string | null) =>
    invoke<void>("restore_servers_backup", { installation }),
  pingServer: (address: string) => invoke<Ping>("ping_server", { address }),
  importWorld: (source: string, installation: string | null) =>
    invoke<string>("import_world", { source, installation }),
  backupWorld: (path: string, dest: string) => invoke<void>("backup_world", { path, dest }),
  trashItem: (path: string) => invoke<void>("trash_item", { path }),
  sharedWith: (paths: string[], followLinks: boolean) =>
    invoke<string[]>("shared_with", { paths, followLinks }),
  listMods: (installation: string | null) => invoke<Mod[]>("list_mods", { installation }),
  toggleMod: (path: string) => invoke<string>("toggle_mod", { path }),
  addMods: (installation: string | null, files: string[]) =>
    invoke<number>("add_mods", { installation, files }),
  resolveLink: (link: string) => invoke<LinkInfo>("resolve_link", { link }),
  /** mod, collection or modpack links, matched to the installation's version and loader */
  importLinks: (links: string[], installation: string, only: "resourcepack" | "shader" | null = null) =>
    invoke<ImportReport>("import_links", { links, installation, only }),
  updateMods: (installation: string) => invoke<ImportReport>("update_mods", { installation }),
  /** which newer game versions every enabled mod has a build for */
  scanUpgrade: (installation: string) => invoke<UpgradeScan>("scan_upgrade", { installation }),
  /** added: mods swapped for their new build · skipped: the `remove` ones, now in the Trash */
  upgradeInstallation: (installation: string, game: string, remove: string[]) =>
    invoke<ImportReport>("upgrade_installation", { installation, game, remove }),
  listScreenshots: () => invoke<Screenshot[]>("list_screenshots"),
  listShaders: (installation: string | null) => invoke<ShaderList>("list_shaders", { installation }),
  setShader: (installation: string | null, file: string | null) =>
    invoke<void>("set_shader", { installation, file }),
  addShaders: (installation: string | null, files: string[]) =>
    invoke<number>("add_shaders", { installation, files }),
  shaderGallery: () => invoke<Record<string, ShaderInfo>>("shader_gallery"),
  listLogs: (installation: string | null = null) =>
    invoke<LogEntry[]>("list_logs", { installation }),
  sortLogs: (installation: string | null = null) =>
    invoke<number>("sort_logs", { installation }),
  readLog: (path: string) => invoke<string>("read_log", { path }),
  purgeLogs: (installation: string | null = null) =>
    invoke<number>("purge_logs", { installation }),
  folderOverview: (installation: string | null = null) =>
    invoke<FolderItem[]>("folder_overview", { installation }),
  purgeCache: (installation: string | null = null) =>
    invoke<number>("purge_cache", { installation }),
  listProfiles: () => invoke<ProfilesOverview>("list_profiles"),
  relinkProfile: (id: string, dir: string) => invoke<void>("relink_profile", { id, dir }),
  /** returns the new folder */
  moveProfile: (id: string) => invoke<string>("move_profile", { id }),
  archiveProfile: (id: string) => invoke<void>("archive_profile", { id }),
  restoreProfile: (id: string) => invoke<void>("restore_profile", { id }),
  /** null puts the launcher's default image back */
  setProfileIcon: (id: string, imagePath: string | null) =>
    invoke<void>("set_profile_icon", { id, imagePath }),
  deleteArchivedProfile: (id: string) => invoke<void>("delete_archived_profile", { id }),
};

/** Links pasted together, split on spaces, commas or new lines. */
export const splitLinks = (text: string) => text.split(/[\s,]+/).filter(Boolean);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "never played";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
