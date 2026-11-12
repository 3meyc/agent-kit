/**
 * SessionStart hook of the core plugin. Its stdout is rendered into the session as context
 * (docs/spikes.md S1a), which is how the kit's always-on rules reach every session without a
 * copy in the project. Two duties, each with its own id for `kit.json` `hooks.off`:
 *
 * 1. `rules` — print `rules/always-on.md`.
 * 2. `update-check` — one short line per kit plugin whose installed commit differs from its
 *    channel (the project's declared marketplace ref, else the registered one) now, with the
 *    update commands (S8). Only the copy this session loads and the user-scope copy are named
 *    (S11); the update names `--scope user`, and a project-scope copy is cleared with
 *    `kit installs --clean`. Remote SHAs are cached for six hours in the plugin's data folder;
 *    offline or slow remotes print nothing.
 *
 * Never blocks the session: every failure goes to stderr and the hook exits 0.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun, projectRoot, readHookInput } from "../lib/hook-utils.mjs";
import { hookOff, readKit } from "../lib/kit-config.mjs";
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
    const copy = item.scope === "user" || item.scope === "managed" || !item.scope ? "" : ` (${item.scope}-scope copy${item.loaded ? ", loaded instead of the user copy" : ""})`;
    lines.push(`- ${item.plugin}@${item.marketplace}${copy}: ${item.installed.slice(0, 12)} installed, ${item.ref} is ${item.latest.slice(0, 12)}`);
    for (const command of updateCommands(item)) commands.add(command);
  }
  lines.push("", ...[...commands].map((command) => `    ${command}`));
  if (commands.has("kit installs --clean")) {
    lines.push("", "`kit installs --clean` (a kit command in the session's shell) uninstalls stale project-scope copies and keeps each folder's .claude/settings.json as it was.");
  }
  const misregistered = [...new Set(lagging.filter((item) => item.registeredRef && item.registeredRef !== item.ref).map((item) => `${item.marketplace} (${item.registeredRef}, project wants ${item.ref})`))];
  if (misregistered.length > 0) {
    lines.push("", `This machine registered ${misregistered.join(", ")} at another ref, so these commands alone won't reach it; \`kit doctor\` gives the fix.`);
  }
  return lines.join("\n");
}

/**
 * All remote reads of the update check together stay under this, well inside the hook's 15 s
 * timeout in hooks.json, so a run of slow remotes cannot get the hook killed.
 */
export const UPDATE_BUDGET_MS = 8000;

export async function main(input, { budgetMs = UPDATE_BUDGET_MS } = {}) {
  const root = projectRoot();
  const config = readKit(root);
  let printed = false;
  const print = (text) => {
    if (!text) return;
    process.stdout.write(`${printed ? "\n" : ""}${text}\n`);
    printed = true;
  };
  if (!hookOff("rules", config)) {
    try {
      // Written before the update check starts, so the rules reach the session even if the
      // network makes that check slow.
      print(rulesText());
    } catch (error) {
      console.error(`core rules: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (!hookOff("update-check", config) && input?.source !== "compact") {
    try {
      // The copy this session runs and the user copy the kit installs; other worktrees' copies are
      // `kit doctor`'s and `kit installs`'s to report.
      const { lagging } = checkUpdates({ root, cacheFile: defaultCacheFile(), budgetMs });
      print(updateText(lagging.filter((item) => item.loaded || item.scope === "user")));
    } catch (error) {
      console.error(`core update-check: ${error instanceof Error ? error.message : error}`);
    }
  }
}

if (isDirectRun(import.meta.url)) await main(await readHookInput());
