// Reads the same latest.json the in-app updater uses, so it needs no GitHub API quota.
export const RELEASES = "https://github.com/Pulsar-Programmer/mim/releases";

export const FILES: Record<string, string> = {
  "mac-arm": "aarch64.dmg",
  "mac-intel": "x64.dmg",
  "win-x64": "x64-setup.exe",
  "win-arm": "arm64-setup.exe",
  "linux-x64-appimage": "amd64.AppImage",
  "linux-arm-appimage": "aarch64.AppImage",
  "linux-x64-deb": "amd64.deb",
  "linux-arm-deb": "arm64.deb",
};

export async function latestVersion(): Promise<string> {
  const init = { next: { revalidate: 300 } } as RequestInit;
  const res = await fetch(`${RELEASES}/latest/download/latest.json`, init);
  if (!res.ok) throw new Error(`latest.json: ${res.status}`);
  const { version } = await res.json();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("bad version");
  return version;
}

/** The installer URL, the releases page if GitHub is unreachable, or null for an unknown platform. */
export async function downloadUrl(platform: string): Promise<string | null> {
  if (!Object.hasOwn(FILES, platform)) return null;
  try {
    const version = await latestVersion();
    return `${RELEASES}/download/v${version}/MIM_${version}_${FILES[platform]}`;
  } catch {
    return `${RELEASES}/latest`;
  }
}
