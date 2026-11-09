/**
 * SessionStart hook of the core plugin. Its stdout is rendered into the session as context
 * (docs/spikes.md S1a), which is how the kit's always-on rules reach every session without a
 * copy in the project. Two duties, each with its own id for `kit.json` `hooks.off`:
 *
 * 1. `rules` — print `rules/always-on.md`.
 * 2. `update-check` — one short line per kit plugin whose installed commit differs from its
 *    marketplace ref now, with the two update commands (S8). Remote SHAs are cached for six hours
 *    in the plugin's data folder; offline or slow remotes print nothing.
 *
 * Never blocks the session: every failure goes to stderr and the hook exits 0.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun, projectRoot, readHookInput } from "../lib/hook-utils.mjs";
import { hookOff, readKitConfig } from "../src/kit-config.mjs";
import { checkUpdates, defaultCacheFile, updateCommands } from "../src/update-check.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function rulesText() {
  return readFileSync(join(pluginRoot, "rules", "always-on.md"), "utf8").trim();
}

/** @param {ReturnType<typeof checkUpdates>["lagging"]} lagging */
export function updateText(lagging) {
  if (lagging.length === 0) return "";
  const lines = ["## agent-kit updates", ""];
  lines.push(
    "Installed kit plugins differ from their channel. Tell the user once, briefly; updating is their step (new session after):",
  );
  const commands = new Set();
  for (const item of lagging) {
    lines.push(`- ${item.plugin}@${item.marketplace}: ${item.installed.slice(0, 12)} installed, ${item.ref} is ${item.latest.slice(0, 12)}`);
    for (const command of updateCommands(item)) commands.add(command);
  }
  lines.push("", ...[...commands].map((command) => `    ${command}`));
  return lines.join("\n");
}

export async function main(input) {
  const root = projectRoot();
  const config = readKitConfig(root);
  const parts = [];
  if (!hookOff(config, "rules")) {
    try {
      parts.push(rulesText());
    } catch (error) {
      console.error(`core rules: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (!hookOff(config, "update-check") && input?.source !== "compact") {
    try {
      parts.push(updateText(checkUpdates({ root, cacheFile: defaultCacheFile() }).lagging));
    } catch (error) {
      console.error(`core update-check: ${error instanceof Error ? error.message : error}`);
    }
  }
  const text = parts.filter(Boolean).join("\n\n");
  if (text) process.stdout.write(`${text}\n`);
}

if (isDirectRun(import.meta.url)) await main(await readHookInput());
