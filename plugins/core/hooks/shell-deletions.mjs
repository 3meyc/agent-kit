/**
 * Pre/PostToolUse hook `shell-deletions`: snapshot the tracked files missing from the working tree
 * before and after a shell call that runs a script, so the session ledger can credit the
 * script's deletions.
 *
 * A ledger credits a script's writes by mtime inside its run window. A deleted file has no mtime,
 * so a script that deletes a generated file would leave the path uncredited. The Stop-time state
 * alone cannot tell this call's deletion from one a neighbour session made earlier in a shared
 * tree; the two snapshots can: a path the `post` line lists and the `pre` line does not.
 *
 * Only opaque commands (`shellWriteTargets(...).opaque`) are snapshotted: a command that names its
 * removals (`rm`, `git rm`, `mv`) is credited from the transcript, and one that runs no script
 * deletes nothing. Runs only when `kit.json` sets `ledger: true`, since nothing else reads the log.
 * Silent; a failure never blocks the call and only leaves the deletion uncredited.
 *
 * The log is `<transcript dir>/<session id>/shell-deletions.jsonl` (a sub-agent's transcript logs
 * into its parent session's folder), one JSON line `{ id, phase: "pre" | "post", deleted }` per
 * snapshot, `deleted` holding absolute paths. The session plugin reads it; this is the only hook
 * that writes it (the session plugin, which depends on core, has no copy of its own).
 *
 * At PreToolUse the dispatcher `shell-pre.mjs` calls `run()` in-process before the CodeGraph sync,
 * so the `pre` snapshot precedes anything the call does; PostToolUse runs this file directly.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SHELL_TOOLS, isDirectRun, readHookInput, shellDeletionsLog } from "../lib/hook-utils.mjs";
import { hookOff, ledgerHookOn, readKit, rootFor } from "../lib/kit-config.mjs";
import { shellWriteTargets } from "../lib/shell-edits.mjs";

export { shellDeletionsLog };
export const HOOK_ID = "shell-deletions";
/**
 * The id the session plugin's copy of this hook had; it was removed because both copies ran and
 * logged every snapshot twice. Listing it in `hooks.off` still switches this one off.
 */
export const OLD_SESSION_HOOK_ID = "ledger-shell-deletions";
const PHASES = { PreToolUse: "pre", PostToolUse: "post" };

/**
 * Absolute paths of tracked files deleted in the tree containing `cwd`, staged or not, plus the old
 * side of a rename. `--untracked-files=no` keeps it cheap, since it runs twice per script call.
 * @param {string} cwd
 * @returns {string[] | null}
 */
function deletedTracked(cwd) {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (top.status !== 0) return null;
  const root = top.stdout.trim();
  const status = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.status !== 0) return null;
  const deleted = [];
  const entries = status.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i += 1) {
    const code = entries[i].slice(0, 2);
    if (code.includes("D")) deleted.push(join(root, entries[i].slice(3)));
    // `R  new\0old`: the original path follows as its own entry and no longer exists.
    if (code.includes("R") || code.includes("C")) {
      if (code.includes("R") && entries[i + 1] !== undefined) deleted.push(join(root, entries[i + 1]));
      i += 1;
    }
  }
  return deleted;
}

/**
 * Snapshot the deletions for one hook payload; returns without touching the log when the hook is
 * off, the call is not an opaque shell call, or it has no transcript to log beside.
 * @param {{ hook_event_name?: string, tool_name?: string, tool_input?: { command?: unknown }, tool_use_id?: unknown, transcript_path?: unknown, cwd?: string }} input
 * @param {import("../lib/kit-config.mjs").Kit} [config]
 */
export async function run(input, config = readKit(rootFor(input.cwd))) {
  if (!ledgerHookOn(HOOK_ID, config) || hookOff(OLD_SESSION_HOOK_ID, config)) return;
  const phase = PHASES[input.hook_event_name];
  const command = input.tool_input?.command;
  if (!phase || !SHELL_TOOLS.has(input.tool_name ?? "") || typeof command !== "string") return;
  if (typeof input.tool_use_id !== "string" || typeof input.transcript_path !== "string") return;
  const cwd = input.cwd ?? process.cwd();
  if (!shellWriteTargets(command, { cwd, powershell: input.tool_name === "PowerShell" }).opaque) return;
  const deleted = deletedTracked(cwd);
  if (deleted === null) return;
  const log = shellDeletionsLog(input.transcript_path);
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ id: input.tool_use_id, phase, deleted })}\n`);
}

async function main() {
  try {
    await run(await readHookInput());
  } catch (error) {
    console.error(`${HOOK_ID}: ${error instanceof Error ? error.message : error}`);
  }
}

if (isDirectRun(import.meta.url)) await main();
