// Run: bun scripts/check_compare.ts
import assert from "node:assert";
import { compare, mergeText, sameValue } from "../src/compare";

// order, comments, timestamps and number style aren't differences
assert.equal(compare(["#Mon Jan 1\na=1\nb=2\n", "#Fri Nov 22\nb=2.0\na=1\n"], "x.properties").kind, "same");

// the chesttracker case: one simply has two newer settings
const older = `{\n  // saves\n  gui: {\n    size: 1,\n  },\n}\n`;
const newer = `{\n  gui: {\n    size: 1,\n  },\n  async_saving: false,\n  entity_memories: true,\n}\n`;
const c = compare([newer, older], "config/chesttracker.json5");
assert.equal(c.kind, "additive");
assert.equal(c.superset, 0);
assert.deepEqual(c.keys, ["async_saving", "entity_memories"]);
assert.equal(c.mergeable, false); // json5 is kept whole, never rewritten

// array order does matter
assert.equal(compare([`{\n a: [\n 1,\n 2,\n ],\n}`, `{\n a: [\n 2,\n 1,\n ],\n}`], "a.json5").kind, "conflict");

// flat: each side's extras combine, picks settle clashes, layout stays
const a = "x:1\ny:old\nonlyA:1\n", b = "y:new\nx:1\nonlyB:2\n";
const flat = compare([a, b], "a.txt");
assert.equal(flat.kind, "conflict");
assert.deepEqual(flat.conflicts, ["y"]);
assert.equal(mergeText([a, b], flat, "a.txt", 0, { y: 1 }), "x:1\ny:new\nonlyA:1\nonlyB:2\n");
assert.equal(mergeText([a, b], flat, "a.txt", 0), "x:1\ny:old\nonlyA:1\nonlyB:2\n");

// options.txt: the data version is never a conflict, and the highest survives
const o1 = "version:3465\nfov:0.0\n", o2 = "version:4671\nfov:0\nnewOpt:true\n";
const oc = compare([o1, o2], "options.txt");
assert.equal(oc.kind, "additive");
assert.equal(mergeText([o1, o2], oc, "options.txt", 0), "version:4671\nfov:0.0\nnewOpt:true\n");

// json merges nested settings
const j1 = `{"a":{"x":1,"y":2},"l":[1]}`, j2 = `{"a":{"x":1,"z":3},"l":[2]}`;
const jc = compare([j1, j2], "m.json");
assert.deepEqual(jc.conflicts, ["l"]);
assert.deepEqual(JSON.parse(mergeText([j1, j2], jc, "m.json", 0, { l: 1 })!), { a: { x: 1, y: 2, z: 3 }, l: [2] });

// unreadable stays unknown
assert.equal(compare(["a=1", null], "a.properties").kind, "unknown");
assert.ok(sameValue("1", "1.0") && !sameValue("1", "2") && !sameValue("true", "1"));
console.log("compare ok");
