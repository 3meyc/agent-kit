// The marketplace catalog lists every plugin with the description its own plugin.json gives.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readJson = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"));

test("marketplace.json descriptions match each plugin.json", () => {
  for (const entry of readJson(".claude-plugin/marketplace.json").plugins) {
    const manifest = readJson(`${entry.source.replace(/^\.\//, "")}/.claude-plugin/plugin.json`);
    assert.equal(entry.name, manifest.name);
    assert.equal(entry.description, manifest.description, `${entry.name}: refresh the description in marketplace.json`);
  }
});
