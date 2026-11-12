/**
 * PreToolUse hook `codegraph-sync`: bring a linked worktree's CodeGraph index up to date right
 * before a query reads it.
 *
 * CodeGraph is a machine install and opt-in per repository (`codegraph init`). Without a
 * `.codegraph/codegraph.db` in the session's linked worktree, or without the `codegraph` CLI, this
 * returns at once and says nothing, so the hook stays harmless where no index exists.
 *
 * Where an index exists: the main checkout's index is kept current by the watcher of a
 * `codegraph serve --mcp` process, but nothing watches a worktree's own index. It is a snapshot,
 * so it misses the session's edits and every commit a branch move brings in (a base sync, a
 * merge). A CLI query that finds it stale syncs in the background only after answering, so that
 * answer is stale. Syncing before each query covers edits and branch moves alike, costs about
 * 0.4 s when nothing changed, and costs nothing between queries.
 *
 * Triggers: a shell command that runs a reading `codegraph` subcommand, and a CodeGraph MCP tool
 * call whose `projectPath` lies in a linked worktree. Silent; a failed sync is reported on stderr
 * and never blocks the query. For shell calls the dispatcher `shell-pre.mjs` calls `run()`
 * in-process after the deletions snapshot; MCP calls run this file directly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SHELL_TOOLS, isDirectRun, readHookInput } from "../lib/hook-utils.mjs";
import { hookOff, readKit, rootFor } from "../lib/kit-config.mjs";
import { stripHeredocs } from "../lib/shell-edits.mjs";

export const HOOK_ID = "codegraph-sync";
const isWindows = process.platform === "win32";
const SYNC_TIMEOUT_MS = 40_000;
const LOCK_RETRIES = 10;
const LOCK_RETRY_MS = 500;
const READING_SUBCOMMANDS = "query|explore|context|node|files|callers|callees|impact|affected";
const READING_CALL = new RegExp(`(?:^|[\\s;&|(])codegraph\\s+(?:${READING_SUBCOMMANDS})\\b`);
const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/;
const MCP_TOOL = /^mcp__.*codegraph.*__/i;

/**
 * The directory whose index the tool call is about to read, or null when it reads none.
 * @param {{ tool_name?: string, tool_input?: { command?: unknown, projectPath?: unknown }, cwd?: string }} input
 * @returns {string | null}
 */
export function codegraphQueryDir(input) {
  const cwd = input.cwd ?? process.cwd();
  const tool = input.tool_name ?? "";
  if (MCP_TOOL.test(tool)) {
    const path = input.tool_input?.projectPath;
    return typeof path === "string" && path !== "" ? resolve(cwd, path) : null;
  }
  if (!SHELL_TOOLS.has(tool)) return null;
  const command = input.tool_input?.command;
  if (typeof command !== "string") return null;
  const shell = stripHeredocs(command);
  if (!READING_CALL.test(shell)) return null;
  const cd = shell.match(LEADING_CD)?.[1].replace(/^["']|["']$/g, "");
  return cd ? resolve(cwd, expandHome(cd)) : cwd;
}

/** A leading `~` or `~/…` as the shell expands it (an unquoted one; the quote is gone by now). */
function expandHome(dir, home = homedir()) {
  return dir === "~" ? home : /^~[\\/]/.test(dir) ? join(home, dir.slice(2)) : dir;
}

/** Top of the linked worktree containing `dir` when it has its own index; null otherwise. */
function worktreeWithIndex(dir) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) return null;
  const top = result.stdout.trim();
  // A linked worktree has a `.git` file pointing at the common dir; the main checkout has a folder.
  const dotGit = join(top, ".git");
  if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return null;
  return existsSync(join(top, ".codegraph", "codegraph.db")) ? top : null;
}

/**
 * Sync the worktree index a reading call is about to query; returns at once for any other call.
 * @param {{ tool_name?: string, tool_input?: { command?: unknown, projectPath?: unknown }, cwd?: string }} input
 * @param {import("../lib/kit-config.mjs").Kit} [config]
 */
export async function run(input, config) {
  const dir = codegraphQueryDir(input);
  if (dir === null || !isAbsolute(dir) || !existsSync(dir)) return;
  if (hookOff(HOOK_ID, config === undefined ? readKit(rootFor(input.cwd)) : config)) return;
  const top = worktreeWithIndex(dir);
  if (top === null) return;
  syncWorktree(top);
}

/**
 * Sync the index of `top`, waiting out a lock held by another sync; warns on stderr when it still
 * fails. `sync` and `wait` stand in for the CLI and the pause in tests.
 * @param {string} top
 * @param {{ sync?: (top: string) => { status: number | null, stdout?: string, stderr?: string, error?: Error }, wait?: (ms: number) => void, warn?: (line: string) => void }} [options]
 * @returns {number} how many times the sync ran
 */
export function syncWorktree(top, { sync = syncIndex, wait = pause, warn = console.error } = {}) {
  let result = sync(top);
  let attempts = 1;
  // A query that finds the index stale starts a background sync of its own after answering; its
  // lock makes ours fail. That sync is already bringing the index up to date, so wait it out.
  for (let retry = 0; retry < LOCK_RETRIES && isLockBusy(result); retry++) {
    wait(LOCK_RETRY_MS);
    result = sync(top);
    attempts += 1;
  }
  // No CLI on this machine: nothing can read the index either, so there is nothing to warn about.
  if (result.error && "code" in result.error && result.error.code === "ENOENT") return attempts;
  if (result.status !== 0) {
    const reason = result.error ? result.error.message : `exit ${result.status}`;
    warn(`${HOOK_ID}: sync of ${top} failed (${reason}); the query may read a stale index`);
  }
  return attempts;
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Not `-q`: the quiet flag also hides the lock message the retry looks for. */
function syncIndex(top) {
  // codegraph is a `.cmd` shim on Windows, spawned through a shell.
  return isWindows
    ? spawnSync(`codegraph sync "${top}"`, { encoding: "utf8", shell: true, timeout: SYNC_TIMEOUT_MS })
    : spawnSync("codegraph", ["sync", top], { encoding: "utf8", timeout: SYNC_TIMEOUT_MS });
}

function isLockBusy(result) {
  return result.status !== 0 && /could not acquire the file lock/i.test(`${result.stdout ?? ""}${result.stderr ?? ""}`);
}

async function main() {
  try {
    await run(await readHookInput());
  } catch (error) {
    console.error(`${HOOK_ID}: ${error instanceof Error ? error.message : error}`);
  }
}

if (isDirectRun(import.meta.url)) await main();
