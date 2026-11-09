/**
 * Counters for a project's optional pre-commit steps (`preflight` on the Bash PATH, from the
 * plugin's `bin/`):
 *
 *   preflight [status]        each step and the commits made since it last ran
 *   preflight run <id>...     run the step's command from the repo root; exit 0 clears its count
 *   preflight done <id>...    clear the count of a step that ran another way (a skill, by hand)
 *
 * The steps come from `kit.json` `preflight`, never from a list of named tools:
 *
 *   "preflight": {
 *     "docs-review": { "description": "Docs review, the /docs-review skill", "match": ["docs/**", "*.md"], "remindAfter": 3 },
 *     "audit": { "description": "Dependency and dead-code audit", "command": "pnpm run audit" }
 *   }
 *
 * A step is optional, so nothing blocks a commit. `git-commit-session` calls `recordCommit` after
 * each new commit: every step the commit touches (`match`, or any path outside the ledger when it
 * has none) counts one more skip, and a step at `remindAfter` or above prints one `preflight:` line.
 * The counts live in the repository's common git folder (`<git-common-dir>/agent-kit/preflight.json`),
 * shared by the main checkout and its worktrees and never committed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDirectRun } from "../lib/hook-utils.mjs";
import { matchesAny } from "../lib/globs.mjs";
import { inLedger, readKit, rootFor } from "../lib/kit-config.mjs";

const USAGE = `Usage: preflight [status | run <id>... | done <id>...]

  status        each kit.json preflight step and the commits made since it last ran
  run <id>...   run the step's command from the repo root; exit 0 clears its count
  done <id>...  clear the count of a step that ran another way (a skill, by hand)`;

/**
 * Where the counts live: the common git folder, so a worktree and its main checkout share them.
 * Null outside git. @param {string} root
 */
export function countsFile(root) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const dir = result.stdout.trim();
  return join(isAbsolute(dir) ? dir : resolve(root, dir), "agent-kit", "preflight.json");
}

/** @typedef {Record<string, { skipped: number, lastRun: string | null }>} Counts */

/** The stored counts, or none. Never throws. @param {string | null} file @returns {Counts} */
export function readCounts(file) {
  if (!file || !existsSync(file)) return {};
  try {
    const steps = JSON.parse(readFileSync(file, "utf8"))?.steps;
    return steps && typeof steps === "object" ? steps : {};
  } catch {
    return {};
  }
}

/** @param {string | null} file @param {Counts} counts */
export function writeCounts(file, counts) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ steps: counts }, null, 2)}\n`);
}

/**
 * Whether a commit of these paths counts as a skip of this step: one path matches the step's
 * globs, or, without globs, one path lies outside the ledger folder. Pure.
 * @param {{ match: string[] }} step @param {string[]} paths @param {{ paths: { ledger: string } }} kit
 */
export function touches(step, paths, kit) {
  const outside = paths.filter((path) => !inLedger(path, kit));
  if (step.match.length === 0) return outside.length > 0;
  return outside.some((path) => matchesAny(path, step.match));
}

/**
 * The counts after one commit of `paths`: each step it touches counts one more skip. Pure; steps
 * no longer in kit.json are dropped. @param {import("../lib/kit-config.mjs").Kit} kit
 * @param {Counts} counts @param {string[]} paths @returns {Counts}
 */
export function countCommit(kit, counts, paths) {
  const next = {};
  for (const [id, step] of Object.entries(kit.preflight)) {
    const current = counts[id] ?? { skipped: 0, lastRun: null };
    next[id] = touches(step, paths, kit) ? { ...current, skipped: current.skipped + 1 } : { ...current };
  }
  return next;
}

/** How to clear one step's count. Pure. @param {string} id @param {{ description: string, command: string | null }} step */
function clearHint(id, step) {
  return step.command ? `\`preflight run ${id}\`` : `${step.description}, then \`preflight done ${id}\``;
}

/**
 * One line per step at or above its `remindAfter`, for the end of a commit's output. Pure.
 * @param {import("../lib/kit-config.mjs").Kit} kit @param {Counts} counts
 */
export function reminderLines(kit, counts) {
  const lines = [];
  for (const [id, step] of Object.entries(kit.preflight)) {
    const skipped = counts[id]?.skipped ?? 0;
    if (skipped < step.remindAfter) continue;
    lines.push(`preflight: ${id} skipped in ${skipped} commit(s) since its last run; ${clearHint(id, step)}`);
  }
  return lines;
}

/**
 * Count one new commit of `paths` and return the reminder lines. Never throws: a counter that
 * cannot be written must not turn a made commit into a failure.
 * @param {string} root @param {string[]} paths
 * @returns {string[]}
 */
export function recordCommit(root, paths) {
  try {
    const kit = readKit(root);
    if (Object.keys(kit.preflight).length === 0) return [];
    const file = countsFile(root);
    const counts = countCommit(kit, readCounts(file), paths);
    writeCounts(file, counts);
    return reminderLines(kit, counts);
  } catch (error) {
    return [`preflight: counts not updated (${error instanceof Error ? error.message : error})`];
  }
}

/** The status report, one numbered line per step. Pure. @param {import("../lib/kit-config.mjs").Kit} kit @param {Counts} counts */
export function statusLines(kit, counts) {
  const steps = Object.entries(kit.preflight);
  if (steps.length === 0) return ["No preflight steps in kit.json."];
  return steps.map(([id, step], index) => {
    const skipped = counts[id]?.skipped ?? 0;
    const last = counts[id]?.lastRun ? `last run ${counts[id].lastRun.slice(0, 10)}` : "never run";
    const state = skipped === 0 ? "up to date" : `${skipped} commit(s) since its last run`;
    const how = step.command ? `\`${step.command}\`` : step.description;
    return `${index + 1}. ${id}: ${state} (${last}) — ${how}`;
  });
}

/** Clear the counts of `ids`, stamping the time. Pure. @param {Counts} counts @param {string[]} ids @param {string} now */
export function clearCounts(counts, ids, now) {
  const next = { ...counts };
  for (const id of ids) next[id] = { skipped: 0, lastRun: now };
  return next;
}

/** @param {string[]} argv @returns {number} */
export function main(argv, root = rootFor(process.cwd()), print = console.log) {
  const [command = "status", ...ids] = argv;
  const kit = readKit(root);
  if (kit.error) {
    print(`${kit.error}: fix it first (\`kit doctor\` shows what is wrong).`);
    return 1;
  }
  const file = countsFile(root);
  const counts = readCounts(file);
  if (command === "status") {
    for (const line of statusLines(kit, counts)) print(line);
    return 0;
  }
  if (command !== "run" && command !== "done") {
    print(USAGE);
    return command === "--help" || command === "-h" || command === "help" ? 0 : 1;
  }
  const unknown = ids.filter((id) => !(id in kit.preflight));
  if (ids.length === 0 || unknown.length > 0) {
    print(ids.length === 0 ? USAGE : `preflight: no step ${unknown.join(", ")} in kit.json (${Object.keys(kit.preflight).join(", ") || "none"})`);
    return 1;
  }
  let status = 0;
  const cleared = [];
  for (const id of ids) {
    const step = kit.preflight[id];
    if (command === "done") {
      cleared.push(id);
      continue;
    }
    if (!step.command) {
      print(`preflight: ${id} has no command; ${step.description}, then \`preflight done ${id}\``);
      status = 1;
      continue;
    }
    const run = spawnSync(step.command, { cwd: root, shell: true, stdio: "inherit" });
    if (run.status === 0) cleared.push(id);
    else {
      print(`preflight: ${id} failed (exit ${run.status ?? run.error?.message}); its count stays`);
      status = 1;
    }
  }
  if (cleared.length > 0) {
    writeCounts(file, clearCounts(counts, cleared, new Date().toISOString()));
    print(`preflight: cleared ${cleared.join(", ")}`);
  }
  return status;
}

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
