import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);

describe("frontend document", () => {
  it("contains syntactically valid inline JavaScript", () => {
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0]));
  });

  it("has unique IDs and all referenced IDs exist", () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    const referenced = [...scripts[0].matchAll(/\$\$?\("#([A-Za-z][\w-]*)/g)].map(match => match[1]);
    const missing = [...new Set(referenced.filter(id => !ids.includes(id)))];

    assert.deepEqual(duplicates, []);
    assert.deepEqual(missing, []);
  });

  it("escapes persisted feedback comments before inserting HTML", () => {
    assert.match(scripts[0], /r\.comment\s*\?\s*"—— " \+ esc\(r\.comment\)/);
  });
});
