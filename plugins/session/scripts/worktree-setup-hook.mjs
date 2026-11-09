/**
 * SessionStart hook (id `worktree-setup`): prepare a desktop-app worktree before the session's
 * first command. Runs whether or not the project has a `kit.json`; a project switches it off by
 * listing `worktree-setup` in `hooks.off`.
 *
 * Asking every worktree session to run `worktree-setup` does not work: sessions skip it, and a
 * worktree without `node_modules` (or, where CodeGraph is used, its own index) breaks the first
 * check. Running it here makes the setup unconditional. It is synchronous on purpose: a background
 * install would race the session's own package-manager commands, and an index builds in about two
 * seconds.
 *
 * Silent in the main checkout. In a linked worktree it prints one line naming the CodeGraph index
 * the session will read (`codegraph: <top>, <n> files indexed`, or why there is none), after the
 * setup line when the setup ran. Without an index in either checkout the line is skipped.
 *
 * The checkout is the session's, never this file's: a plugin's scripts live in the plugin cache.
 * The hook input's `cwd` comes first, then `CLAUDE_PROJECT_DIR`, then the process's cwd.
 *
 * Every run also appends one line to `worktree-setup-hook.log` in the git common dir (the main
 * checkout's `.git/`, shared by all worktrees and never tracked), naming which source gave the
 * checkout, so "never started" and "started in the wrong place" stay distinguishable.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun, readHookInput } from "../lib/hook-utils.mjs";
import { hookOff, readKit } from "../lib/kit-config.mjs";
import { codegraphStatus, planSetup, readFacts } from "./worktree-setup.mjs";

/** This plugin's hook id, as `kit.json` `hooks.off` names it. */
export const HOOK_ID = "worktree-setup";
const SETUP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worktree-setup.mjs");

// Under the hook's own timeout in hooks/hooks.json, so a slow install reports here instead
// of being killed without a word.
const SETUP_TIMEOUT_MS = 170_000;
const TAIL_LINES = 5;
export const RUN_LOG_NAME = "worktree-setup-hook.log";

/**
 * Where the session runs, and which source said so.
 * @param {{ cwd?: unknown }} input
 * @param {NodeJS.ProcessEnv} env
 * @param {string} fallback
 * @returns {{ dir: string, via: "input-cwd" | "project-dir" | "script" }}
 */
export function resolveSessionDir(input, env, fallback) {
  if (typeof input.cwd === "string" && input.cwd !== "") return { dir: input.cwd, via: "input-cwd" };
  if (env.CLAUDE_PROJECT_DIR) return { dir: env.CLAUDE_PROJECT_DIR, via: "project-dir" };
  return { dir: fallback, via: "script" };
}

/**
 * One tab-separated log line: time, outcome, planned steps, session, trigger, checkout, where the
 * checkout came from, and whether `codegraph` was on the hook's PATH.
 * @param {{ at: string, outcome: string, steps: string[], sessionId?: string, source?: string, top: string, via?: string, codegraphOnPath?: boolean }} run
 */
export function formatRunLogLine(run) {
  const fields = [
    run.at,
    run.outcome,
    run.steps.length ? run.steps.join(",") : "-",
    run.sessionId ?? "-",
    run.source ?? "-",
    run.top,
    `via:${run.via ?? "?"}`,
    run.codegraphOnPath === undefined ? "codegraph:?" : `codegraph:${run.codegraphOnPath ? "yes" : "no"}`,
  ];
  return `${fields.join("\t")}\n`;
}

/**
 * The one-line index summary for a linked worktree, from `readFacts` and the text of
 * `codegraph status` (null when it was not run or failed). Pure, so the wording is tested.
 * @param {{ top: string, facts: { hasCodegraph: boolean, codegraphOnPath: boolean } }} read
 * @param {string | null} statusText
 */
export function codegraphStatusLine(read, statusText) {
  if (!read.facts.codegraphOnPath) return "codegraph: not installed";
  if (!read.facts.hasCodegraph) return "codegraph: no index here";
  const project = statusText?.match(/^\s*Project:\s*(.+?)\s*$/m)?.[1] ?? read.top;
  const files = statusText?.match(/^\s*Files:\s*([\d,]+)\s*$/m)?.[1];
  return files === undefined ? `codegraph: ${project}` : `codegraph: ${project}, ${files} files indexed`;
}

/**
 * Print the index line for a linked worktree; `codegraph status` runs only when there is an index
 * to read. Silent when neither checkout has an index: CodeGraph is opt-in per repository.
 */
function printStatusLine(read) {
  const { facts } = read;
  if (!facts.mainHasCodegraph && !facts.hasCodegraph) return;
  const text = facts.codegraphOnPath && facts.hasCodegraph ? codegraphStatus(read.top) : null;
  console.log(codegraphStatusLine(read, text));
}

function appendRunLog(commonDir, line) {
  try {
    appendFileSync(join(commonDir, RUN_LOG_NAME), line);
  } catch (error) {
    // The log is diagnostic only; losing it must not stop the session from starting.
    console.error(
      `worktree-setup-hook: could not write ${RUN_LOG_NAME}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function main() {
  const input = await readHookInput();
  const session = resolveSessionDir(input, process.env, process.cwd());
  const read = readFacts(session.dir);
  if (!read) return;
  if (hookOff(HOOK_ID, readKit(read.top))) return;
  const log = (outcome, steps = []) =>
    appendRunLog(
      read.commonDir,
      formatRunLogLine({
        at: new Date().toISOString(),
        outcome,
        steps,
        sessionId: input.session_id,
        source: input.source,
        top: read.top,
        via: session.via,
        codegraphOnPath: read.facts.codegraphOnPath,
      }),
    );
  if (!read.facts.linked) return log("main-checkout");
  const steps = planSetup(read.facts).filter((step) => !step.endsWith("-hint"));
  if (steps.length === 0) {
    log("already-set-up");
    return printStatusLine(read);
  }
  const result = spawnSync(process.execPath, [SETUP_SCRIPT], {
    cwd: read.top,
    encoding: "utf8",
    timeout: SETUP_TIMEOUT_MS,
  });
  if (result.status === 0) {
    log("ran", steps);
    console.log(`worktree-setup ran in this new worktree (${steps.join(", ")}).`);
    // The setup may have built the index: read the facts again rather than reuse the pre-setup ones.
    return printStatusLine(readFacts(session.dir) ?? read);
  }
  const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-TAIL_LINES).join("\n");
  const reason = result.error ? result.error.message : `exit ${result.status}`;
  log(`failed:${reason}`, steps);
  console.log(
    `worktree-setup failed (${steps.join(", ")}, ${reason}); run \`worktree-setup\` in this worktree:\n${tail}`,
  );
}

if (isDirectRun(import.meta.url)) await main();
