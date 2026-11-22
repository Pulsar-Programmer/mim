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

export interface Standards {
  path: string;
  exists: boolean;
  entries: StandardEntry[];
}

export interface Pack {
  name: string;
  size_bytes: number;
  is_dir: boolean;
}

export interface PacksOverview {
  shared_path: string;
  shared: Pack[];
  linked_installations: string[];
  local: { installation: string; packs: Pack[] }[];
}

export interface InstallSpec {
  name: string;
  game_version: string;
  fabric: boolean;
  loader_version: string | null;
  standards: string[];
}

export const api = {
  listInstallations: () => invoke<Installation[]>("list_installations"),
  listGameVersions: () => invoke<GameVersion[]>("list_game_versions"),
  listLoaderVersions: (gameVersion: string) =>
    invoke<LoaderVersion[]>("list_loader_versions", { gameVersion }),
  createInstallation: (spec: InstallSpec) =>
    invoke<void>("create_installation", { spec }),
  linkInstallation: (name: string) =>
    invoke<[string[], string[]]>("link_installation", { name }),
  listStandards: () => invoke<Standards>("list_standards"),
  ensureStandardsDir: () => invoke<string>("ensure_standards_dir"),
  applyStandards: (name: string, relPaths: string[]) =>
    invoke<void>("apply_standards", { name, relPaths }),
  setCustomIcon: (name: string, imagePath: string) =>
    invoke<string>("set_custom_icon", { name, imagePath }),
  listResourcepacks: () => invoke<PacksOverview>("list_resourcepacks"),
  deleteInstallation: (name: string, removeProfile: boolean) =>
    invoke<void>("delete_installation", { name, removeProfile }),
  revealPath: (path: string, select = true) =>
    invoke<void>("reveal_path", { path, select }),
  openLauncher: () => invoke<void>("open_launcher"),
  minecraftDir: () => invoke<string>("minecraft_dir"),
};

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
