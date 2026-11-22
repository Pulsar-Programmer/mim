import { invoke } from "@tauri-apps/api/core";

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
}

export interface Standard {
  name: string;
  path: string;
  /** the Minecraft folder's own shared folders (saves, packs, screenshots) */
  builtin: boolean;
  installations: string[];
  /** installation -> number of its items that are live links into this standard */
  live: Record<string, number>;
  entries: StandardEntry[];
  /** image files at the standard's top level */
  images: string[];
}

/** Entries that apply to a game version: global ones plus that version's folder. */
export const entriesFor = (s: Standard, gameVersion: string | null) =>
  s.entries.filter((e) => e.scope === "global" || e.scope === gameVersion);

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
  kind: "base" | "installation";
  path: string;
  exists: boolean;
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
}

export interface ArchivedProfile {
  id: string;
  profile: { name?: string; lastVersionId?: string };
  game_dir: string;
  moved_dir: boolean;
  versions: string[];
  archived: string;
}

export interface ProfilesOverview {
  profiles: Profile[];
  archived: ArchivedProfile[];
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

export type Loader = "vanilla" | "fabric" | "forge" | "neoforge";

export interface InstallSpec {
  name: string;
  game_version: string;
  loader: Loader;
  loader_version: string | null;
  standards: string[];
}

export const api = {
  listInstallations: () => invoke<Installation[]>("list_installations"),
  listGameVersions: () => invoke<GameVersion[]>("list_game_versions"),
  listLoaderVersions: (loader: Loader, gameVersion: string) =>
    invoke<LoaderVersion[]>("list_loader_versions", { loader, gameVersion }),
  createInstallation: (spec: InstallSpec) =>
    invoke<void>("create_installation", { spec }),
  linkInstallation: (name: string) =>
    invoke<[string[], string[]]>("link_installation", { name }),
  listStandards: () => invoke<Standard[]>("list_standards"),
  ensureStandardsDir: () => invoke<string>("ensure_standards_dir"),
  createStandard: (name: string) => invoke<string>("create_standard", { name }),
  deleteStandard: (name: string) => invoke<void>("delete_standard", { name }),
  /** Returns what's in the way; when non-empty and !replace, nothing was linked. */
  linkStandard: (name: string, installation: string, relPaths: string[], replace: boolean) =>
    invoke<string[]>("link_standard", { name, installation, relPaths, replace }),
  /** keep: leave the installation a real copy instead of removing the files */
  unlinkStandard: (name: string, installation: string, keep: boolean) =>
    invoke<void>("unlink_standard", { name, installation, keep }),
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
  /** Moves config/ entries into a standard and links them back. Returns the ones the
   * standard already has; when non-empty and !replace, nothing changed. */
  shareConfig: (installation: string, standard: string, names: string[], replace: boolean) =>
    invoke<string[]>("share_config", { installation, standard, names, replace }),
  deleteInstallation: (name: string, removeProfile: boolean) =>
    invoke<void>("delete_installation", { name, removeProfile }),
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
  restoreServersBackup: (installation: string | null) =>
    invoke<void>("restore_servers_backup", { installation }),
  pingServer: (address: string) => invoke<Ping>("ping_server", { address }),
  importWorld: (source: string, installation: string | null) =>
    invoke<string>("import_world", { source, installation }),
  backupWorld: (path: string, dest: string) => invoke<void>("backup_world", { path, dest }),
  trashItem: (path: string) => invoke<void>("trash_item", { path }),
  listMods: (installation: string | null) => invoke<Mod[]>("list_mods", { installation }),
  toggleMod: (path: string) => invoke<string>("toggle_mod", { path }),
  addMods: (installation: string | null, files: string[]) =>
    invoke<number>("add_mods", { installation, files }),
  resolveLink: (link: string) => invoke<LinkInfo>("resolve_link", { link }),
  /** mod, collection or modpack links, matched to the installation's version and loader */
  importLinks: (links: string[], installation: string) =>
    invoke<ImportReport>("import_links", { links, installation }),
  updateMods: (installation: string) => invoke<ImportReport>("update_mods", { installation }),
  listScreenshots: () => invoke<Screenshot[]>("list_screenshots"),
  listLogs: (installation: string | null = null) =>
    invoke<LogEntry[]>("list_logs", { installation }),
  sortLogs: (installation: string | null = null) =>
    invoke<number>("sort_logs", { installation }),
  readLog: (path: string) => invoke<string>("read_log", { path }),
  purgeLogs: (installation: string | null = null) =>
    invoke<number>("purge_logs", { installation }),
  folderOverview: () => invoke<FolderItem[]>("folder_overview"),
  purgeCache: () => invoke<number>("purge_cache"),
  listProfiles: () => invoke<ProfilesOverview>("list_profiles"),
  relinkProfile: (id: string, dir: string) => invoke<void>("relink_profile", { id, dir }),
  /** returns the new folder */
  moveProfile: (id: string) => invoke<string>("move_profile", { id }),
  archiveProfile: (id: string) => invoke<void>("archive_profile", { id }),
  restoreProfile: (id: string) => invoke<void>("restore_profile", { id }),
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
