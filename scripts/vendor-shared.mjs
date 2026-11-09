#!/usr/bin/env node
// Copies shared code into the plugins, so each plugin is self-contained once installed (a plugin
// cannot read files outside its own folder):
//   - each file in shared/ into plugins/<name>/lib/, with a header naming the source, for the
//     plugins `SHARED_TARGETS` lists (a file not listed goes to every plugin);
//   - schema/kit.schema.json into plugins/core/schema/, byte for byte, for `kit doctor`.
// `--check` writes nothing and exits 1 when a copy is missing or stale; `npm run check` and CI run it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

/** Which plugins get which shared file. A plugin that needs one more adds itself here. */
export const SHARED_TARGETS = {
  "globs.mjs": ["core", "session"],
  "kit-config.mjs": ["core", "sdlc", "session"],
  "shell-edits.mjs": ["core", "session"],
};

const sharedDir = join(root, "shared");
const pluginsDir = join(root, "plugins");
const sources = readdirSync(sharedDir).filter((name) => !name.startsWith(".")).sort();
const plugins = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, ".claude-plugin", "plugin.json")))
  .map((entry) => entry.name)
  .sort();

const header = (name) =>
  `// GENERATED from shared/${name} by scripts/vendor-shared.mjs. Edit shared/${name} and run \`npm run vendor\`.\n`;

/** `[source, target, wanted content]` for every copy that should exist. */
const copies = [];
for (const name of sources) {
  const wanted = header(name) + readFileSync(join(sharedDir, name), "utf8");
  for (const plugin of SHARED_TARGETS[name] ?? plugins) {
    if (!plugins.includes(plugin)) throw new Error(`SHARED_TARGETS names plugin "${plugin}", which has no plugin.json`);
    copies.push([`shared/${name}`, `plugins/${plugin}/lib/${name}`, wanted]);
  }
}
copies.push(["schema/kit.schema.json", "plugins/core/schema/kit.schema.json", readFileSync(join(root, "schema", "kit.schema.json"), "utf8")]);

const stale = [];
for (const [, rel, wanted] of copies) {
  const target = join(root, rel);
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === wanted) continue;
  if (check) {
    stale.push(rel);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, wanted);
  console.log(`wrote ${rel}`);
}

if (check && stale.length > 0) {
  console.error(`vendored copies out of date (run \`npm run vendor\`):\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
if (check) console.log(`ok   ${copies.length} vendored copies match shared/ and schema/`);
