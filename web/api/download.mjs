// Resolves /download/<platform> to the newest published installer. Reads the
// same latest.json the in-app updater uses, so it needs no GitHub API quota.
const RELEASES = "https://github.com/Pulsar-Programmer/mim/releases";

export const FILES = {
  "mac-arm": "aarch64.dmg",
  "mac-intel": "x64.dmg",
  "win-x64": "x64-setup.exe",
  "win-arm": "arm64-setup.exe",
  "linux-x64-appimage": "amd64.AppImage",
  "linux-arm-appimage": "aarch64.AppImage",
  "linux-x64-deb": "amd64.deb",
  "linux-arm-deb": "arm64.deb",
};

const CACHED = "public, s-maxage=300, stale-while-revalidate=3600";

async function latestVersion() {
  const res = await fetch(`${RELEASES}/latest/download/latest.json`);
  if (!res.ok) throw new Error(`latest.json: ${res.status}`);
  const { version } = await res.json();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("bad version");
  return version;
}

export async function GET(request) {
  const platform = new URL(request.url).searchParams.get("p");
  if (platform && !Object.hasOwn(FILES, platform)) {
    return new Response("Unknown platform", { status: 404 });
  }
  try {
    const version = await latestVersion();
    if (!platform) return Response.json({ version }, { headers: { "Cache-Control": CACHED } });
    const location = `${RELEASES}/download/v${version}/MIM_${version}_${FILES[platform]}`;
    return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": CACHED } });
  } catch {
    // GitHub is unreachable or mid-release: the releases page still works.
    if (!platform) return Response.json({ version: null }, { status: 502 });
    return new Response(null, { status: 302, headers: { Location: `${RELEASES}/latest`, "Cache-Control": "no-store" } });
  }
}
