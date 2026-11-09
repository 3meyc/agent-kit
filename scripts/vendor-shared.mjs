#!/usr/bin/env node
// Copies every file in shared/ into plugins/<name>/lib/, with a header naming the source, so each
// plugin is self-contained once installed (a plugin cannot read files outside its own folder).
// `--check` writes nothing and exits 1 when a copy is missing or stale; CI runs it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const sharedDir = join(root, "shared");
const pluginsDir = join(root, "plugins");
const sources = readdirSync(sharedDir).filter((name) => !name.startsWith(".")).sort();
const plugins = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, ".claude-plugin", "plugin.json")))
  .map((entry) => entry.name)
  .sort();

const header = (name) =>
  `// GENERATED from shared/${name} by scripts/vendor-shared.mjs. Edit shared/${name} and run \`npm run vendor\`.\n`;

const stale = [];
for (const plugin of plugins) {
  for (const name of sources) {
    const target = join(pluginsDir, plugin, "lib", name);
    const wanted = header(name) + readFileSync(join(sharedDir, name), "utf8");
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === wanted) continue;
    const rel = `plugins/${plugin}/lib/${name}`;
    if (check) {
      stale.push(rel);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, wanted);
    console.log(`wrote ${rel}`);
  }
}

if (check && stale.length > 0) {
  console.error(`vendored copies out of date (run \`npm run vendor\`):\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
if (check) console.log(`ok   ${sources.length} shared file(s) vendored into ${plugins.length} plugins`);
