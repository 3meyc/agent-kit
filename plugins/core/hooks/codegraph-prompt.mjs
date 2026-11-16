/**
 * UserPromptSubmit hook `codegraph-prompt`: hand the prompt to CodeGraph's own Claude Code hook,
 * `codegraph prompt-hook`, which adds CodeGraph context to a prompt about code structure.
 *
 * CodeGraph is a machine install and opt-in per repository (`codegraph init`). Without a
 * `.codegraph/` folder at or above the working folder, or without the `codegraph` CLI, this
 * returns at once and says nothing. While a settings file still holds a `codegraph prompt-hook`
 * entry (the user's own, written by hand or by an installer), this hook stands aside, so the
 * context is never added twice. Never blocks the prompt; a failure is one stderr line.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDirectRun, readHookInput } from "../lib/hook-utils.mjs";
import { hookOff, readKit, rootFor } from "../lib/kit-config.mjs";
import { ownHookPresent, settingsFiles } from "./own-hooks.mjs";

export const HOOK_ID = "codegraph-prompt";
export const OWN_HOOK = /(?:^|[\s"'/\\])codegraph(?:\.cmd)?["']?\s+prompt-hook\b/;
const isWindows = process.platform === "win32";
const TIMEOUT_MS = 15_000;

/**
 * The nearest folder at or above `dir` that holds a `.codegraph/` index, or null.
 * @param {unknown} dir @param {(path: string) => boolean} [exists]
 */
export function indexedRoot(dir, exists = existsSync) {
  if (typeof dir !== "string" || dir === "") return null;
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (exists(join(current, ".codegraph"))) return current;
    if (dirname(current) === current) return null;
  }
}

/** Run `codegraph prompt-hook` with `payload` on stdin; `.cmd` shims need a shell on Windows. */
function runCodegraph(payload) {
  const options = { input: payload, encoding: /** @type {const} */ ("utf8"), timeout: TIMEOUT_MS };
  return isWindows
    ? spawnSync("codegraph prompt-hook", { ...options, shell: true })
    : spawnSync("codegraph", ["prompt-hook"], options);
}

/**
 * CodeGraph's answer for this prompt (text for the hook's stdout), or "" when there is none.
 * @param {{ prompt?: unknown, cwd?: string }} input
 * @param {import("../lib/kit-config.mjs").Kit} config
 * @param {{ spawn?: (payload: string) => import("node:child_process").SpawnSyncReturns<string>, files?: string[], exists?: (path: string) => boolean }} [deps]
 */
export function run(input, config, { spawn = runCodegraph, files, exists = existsSync } = {}) {
  if (hookOff(HOOK_ID, config)) return "";
  if (typeof input?.prompt !== "string" || input.prompt.trim() === "") return "";
  const cwd = input.cwd ?? process.cwd();
  if (!indexedRoot(cwd, exists)) return "";
  if (ownHookPresent(OWN_HOOK, files ?? settingsFiles(rootFor(cwd)))) return "";
  const result = spawn(JSON.stringify(input));
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") return "";
  if (result.error) throw result.error;
  const stderr = String(result.stderr ?? "");
  if (result.status !== 0) {
    if (/not recognized|not found/i.test(stderr)) return "";
    throw new Error(stderr.trim().split(/\r?\n/)[0] || `codegraph prompt-hook exited ${result.status}`);
  }
  return String(result.stdout ?? "");
}

if (isDirectRun(import.meta.url)) {
  const input = await readHookInput();
  try {
    const out = run(input, readKit(rootFor(input?.cwd)));
    if (out) process.stdout.write(out);
  } catch (error) {
    console.error(`${HOOK_ID}: ${error instanceof Error ? error.message : error}`);
  }
}
