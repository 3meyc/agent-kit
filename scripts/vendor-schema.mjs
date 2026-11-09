#!/usr/bin/env node
// Copies schema/kit.schema.json into plugins/core/schema/, so `kit doctor` can validate kit.json
// once the plugin is installed (an installed plugin cannot read files outside its own folder).
// `--check` writes nothing and exits 1 when the copy is missing or stale; `npm run check` runs it.
// Candidate to fold into scripts/vendor-shared.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "schema", "kit.schema.json");
const target = join(root, "plugins", "core", "schema", "kit.schema.json");
const wanted = readFileSync(source, "utf8");
const current = existsSync(target) ? readFileSync(target, "utf8") : null;

if (current === wanted) {
  console.log("ok   plugins/core/schema/kit.schema.json matches schema/kit.schema.json");
} else if (process.argv.includes("--check")) {
  console.error("plugins/core/schema/kit.schema.json is out of date (run `node scripts/vendor-schema.mjs`)");
  process.exit(1);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, wanted);
  console.log("wrote plugins/core/schema/kit.schema.json");
}
