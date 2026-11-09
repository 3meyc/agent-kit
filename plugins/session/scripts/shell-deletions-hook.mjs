/**
 * Pre/PostToolUse hook (id `ledger-shell-deletions`): snapshot the tracked files missing from the working tree before and after
 * a shell call that runs a script, so the session ledger can credit the script's deletions.
 *
 * The ledger credits a script's writes by mtime inside its run window. A deleted file has no mtime,
 * so a script that deletes a generated file would leave the path uncredited and
 * `git-commit-session --worktree` would stop with exit 4. Only the Stop-time state is not
 * enough: it cannot tell this call's deletion from one a neighbour session made earlier in a
 * shared tree. The two snapshots can: `readShellDeletions` (`ledger-utils.mjs`) credits a path the
 * `post` line lists and the `pre` line does not.
 *
 * Only opaque commands (`shellWriteTargets(...).opaque`) are snapshotted: a command that names its
 * removals (`rm`, `git rm`, `mv`) is credited from the transcript, and one that runs no script
 * deletes nothing. Silent; a failure never blocks the call and only leaves the deletion uncredited.
 *
 * Both events run this file directly. Quiet unless `kit.json` sets `"ledger": true` and does not
 * list `ledger-shell-deletions` in `hooks.off`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SHELL_TOOLS, isDirectRun, readHookInput } from "../lib/hook-utils.mjs";
import { ledgerHookOn, readKit, rootFor } from "./kit-config.mjs";
import { shellDeletionsLog } from "./ledger-utils.mjs";

/** This plugin's hook id, as `kit.json` `hooks.off` names it. */
export const HOOK_ID = "ledger-shell-deletions";
import { shellWriteTargets } from "./shell-edits.mjs";

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
 * Snapshot the deletions for one hook payload; returns without touching the log when the call is
 * not a shell call, not an opaque command, or has no transcript to log beside.
 * @param {{ hook_event_name?: string, tool_name?: string, tool_input?: { command?: unknown }, tool_use_id?: unknown, transcript_path?: unknown, cwd?: string }} input
 */
export async function run(input) {
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
    const input = await readHookInput();
    if (!SHELL_TOOLS.has(input.tool_name ?? "")) return;
    if (!ledgerHookOn(HOOK_ID, readKit(rootFor(input.cwd)))) return;
    await run(input);
  } catch (error) {
    console.error(`shell-deletions-hook: ${error?.message ?? error}`);
  }
}

if (isDirectRun(import.meta.url)) await main();
