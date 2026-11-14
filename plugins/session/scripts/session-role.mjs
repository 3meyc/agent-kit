/**
 * Whether this checkout's session is a sub-session (a child whose parent lands its branch) or the
 * main session, as far as git can tell. The agent's own check is the desktop app's `get_session`
 * (`/close-out` § 2 step 6); scripts cannot call it, so they read what git records:
 *
 *   1. `branch.<branch>.kitRole` (`child` or `main`), written by `worktree-flow role <child|main>`;
 *   2. else `branch.<branch>.kitBase`, the base `worktree-flow base`/`adopt` recorded: another
 *      session's `claude/…` branch means a child, which lands into its parent's branch;
 *   3. else main.
 *
 * Main is the safe default: a step scoped to the main session then runs, as it did before scopes.
 */
import { spawnSync } from "node:child_process";
import { matchesAny } from "../lib/globs.mjs";

/** The git config key of a branch's recorded role. @param {string} branch */
export const ROLE_KEY = (branch) => `branch.${branch}.kitRole`;
/** The git config key of a branch's recorded base, shared with `worktree-flow`. @param {string} branch */
export const BASE_KEY = (branch) => `branch.${branch}.kitBase`;

/**
 * The role from the recorded facts. Pure.
 * @param {{ recorded?: string | null, base?: string | null }} facts
 * @returns {{ role: "child" | "main", source: "recorded" | "base" | "default" }}
 */
export function roleOf({ recorded = null, base = null }) {
  if (recorded === "child" || recorded === "main") return { role: recorded, source: "recorded" };
  if (base && base.startsWith("claude/")) return { role: "child", source: "base" };
  return { role: "main", source: "default" };
}

function gitOut(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * The role of the session working in `cwd`. Never throws; outside git or on a detached HEAD it is
 * main. @param {string} cwd
 */
export function sessionRole(cwd) {
  try {
    const branch = gitOut(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
    if (!branch) return { role: /** @type {const} */ ("main"), source: /** @type {const} */ ("default"), branch: null };
    const facts = { recorded: gitOut(["config", "--get", ROLE_KEY(branch)], cwd), base: gitOut(["config", "--get", BASE_KEY(branch)], cwd) };
    return { ...roleOf(facts), branch };
  } catch {
    return { role: /** @type {const} */ ("main"), source: /** @type {const} */ ("default"), branch: null };
  }
}

/** Whether the session in `cwd` is a sub-session. @param {string} cwd */
export function isChildSession(cwd) {
  return sessionRole(cwd).role === "child";
}

/**
 * The paths only the main session edits: `kit.json` `parentFiles` (roadmaps, a changelog, release
 * notes), and every top-level `<paths.sdlc>/*.md` (an index or backlog beside the item folders,
 * never a file inside one). Pure.
 * @param {string[]} paths @param {{ parentFiles: string[], paths: { sdlc: string } }} kit
 */
export function parentOwned(paths, kit) {
  const sdlc = `${kit.paths.sdlc}/`;
  const topLevelSdlc = (path) => path.startsWith(sdlc) && path.endsWith(".md") && !path.slice(sdlc.length).includes("/");
  return paths.filter((path) => topLevelSdlc(path) || matchesAny(path, kit.parentFiles));
}

/**
 * The line a sub-session's commit prints when it holds parent-owned files, or none. Pure.
 * @param {string[]} owned
 */
export function parentFilesLine(owned) {
  if (owned.length === 0) return null;
  return (
    `parent-files: ${owned.join(", ")} belong to the main session; this sub-session undoes those edits in its ` +
    "next commit and lists each in its record's ## Next for the parent, which writes it at /close-siblings"
  );
}
