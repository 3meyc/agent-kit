/**
 * PreToolUse duty `rtk-rewrite`: hand a shell call to RTK's own Claude Code hook,
 * `rtk hook claude`, and pass its answer on.
 *
 * RTK rewrites a command it has a filter for (`git status` → `rtk git status`) so its output
 * reaches the agent compressed. It answers `permissionDecision: "allow"` only for a command the
 * user's own permission rules already allow, so the rewrite never widens what runs unasked.
 *
 * RTK is a machine install. Without the `rtk` binary this returns at once and says nothing. RTK's
 * installer (`rtk init -g`) writes the same hook into `~/.claude/settings.json`, with the matcher
 * `Bash` only, so PowerShell calls skip it; the kit's entry matches both shells. While a settings
 * file still holds an `rtk hook claude` entry, this duty stands aside, so RTK never runs twice.
 *
 * Runs in-process from the dispatcher `shell-pre.mjs`, which prints the returned output.
 */
import { spawnSync } from "node:child_process";
import { SHELL_TOOLS } from "../lib/hook-utils.mjs";
import { hookOff, rootFor } from "../lib/kit-config.mjs";
import { ownHookPresent, settingsFiles } from "./own-hooks.mjs";

export const HOOK_ID = "rtk-rewrite";
export const OWN_HOOK = /(?:^|[\s"'/\\])rtk(?:\.exe)?["']?\s+hook\s+claude\b/;
const TIMEOUT_MS = 10_000;

/**
 * RTK's hook output for this shell call, or null when RTK has nothing to say or does not run here.
 * @param {{ tool_name?: string, tool_input?: { command?: unknown }, cwd?: string }} input
 * @param {import("../lib/kit-config.mjs").Kit} config
 * @param {{ spawn?: typeof spawnSync, files?: string[] }} [deps]
 * @returns {Record<string, unknown> | null}
 */
export function run(input, config, { spawn = spawnSync, files } = {}) {
  if (hookOff(HOOK_ID, config)) return null;
  if (!SHELL_TOOLS.has(input?.tool_name ?? "")) return null;
  if (typeof input.tool_input?.command !== "string" || input.tool_input.command.trim() === "") return null;
  if (ownHookPresent(OWN_HOOK, files ?? settingsFiles(rootFor(input.cwd)))) return null;
  const result = spawn("rtk", ["hook", "claude"], { input: JSON.stringify(input), encoding: "utf8", timeout: TIMEOUT_MS });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") return null;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr ?? "").trim().split(/\r?\n/)[0] || `rtk hook claude exited ${result.status}`);
  }
  const out = String(result.stdout ?? "").trim();
  return out ? JSON.parse(out) : null;
}
