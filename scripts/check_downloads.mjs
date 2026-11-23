// node scripts/check_downloads.mjs: every site download must resolve to a real release file.
import assert from "node:assert";
import { FILES, downloadUrl, latestVersion } from "../web/lib/release.ts";

assert.equal(await downloadUrl("nope"), null);
assert.equal(await downloadUrl("constructor"), null);
const version = await latestVersion();
assert.match(version, /^\d+\.\d+\.\d+$/);

for (const p of Object.keys(FILES)) {
  const url = await downloadUrl(p);
  assert.ok(url.endsWith(FILES[p]), `${p} fell back to ${url}`);
  const file = await fetch(url, { method: "HEAD" });
  assert.ok(file.ok, `${p}: ${url} returned ${file.status}`);
}
console.log(`ok: ${Object.keys(FILES).length} downloads for ${version}`);
