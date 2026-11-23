// node scripts/check_downloads.mjs: every site download must resolve to a real release file.
import assert from "node:assert";
import { FILES, GET } from "../web/api/download.mjs";

const call = (q) => GET(new Request(`https://mim.test/api/download${q}`));

assert.equal((await call("?p=nope")).status, 404);
assert.equal((await call("?p=constructor")).status, 404);
const { version } = await (await call("")).json();
assert.match(version, /^\d+\.\d+\.\d+$/);

for (const p of Object.keys(FILES)) {
  const res = await call(`?p=${p}`);
  assert.equal(res.status, 302, p);
  const url = res.headers.get("location");
  assert.ok(url.endsWith(FILES[p]), `${p} fell back to ${url}`);
  const file = await fetch(url, { method: "HEAD" });
  assert.ok(file.ok, `${p}: ${url} returned ${file.status}`);
}
console.log(`ok: ${Object.keys(FILES).length} downloads for ${version}`);
