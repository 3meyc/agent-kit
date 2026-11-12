/**
 * The branch facts `/git` reads before a git chore, as JSON (`git-branch-context` on the Bash PATH,
 * from the plugin's `bin/`): the current branch, its upstream, the project's base branch from
 * `kit.json` (`baseBranch`, default `main`) and whether it exists locally or on `origin`, the
 * work-item prefix (`itemPrefix`), the commit subject form (`commitSubject`, null for Conventional
 * Commits), and whether this checkout is a linked worktree.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isDirectRun } from "../lib/hook-utils.mjs";
import { readKit, rootFor } from "../lib/kit-config.mjs";

/** @param {string[]} args @returns {string | null} */
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/** @param {string} ref @returns {boolean} */
function refExists(ref) {
  return git("rev-parse", "--verify", "--quiet", ref) !== null;
}

function main() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!branch) {
    console.error("git-branch-context: not a git repository or git is unavailable.");
    process.exit(1);
  }
  const kit = readKit(rootFor(process.cwd()));
  const base = kit.baseBranch;
  const gitDir = git("rev-parse", "--path-format=absolute", "--git-dir");
  const commonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const context = {
    branch,
    upstream: git("rev-parse", "--abbrev-ref", "@{upstream}"),
    baseBranch: base,
    baseLocal: refExists(`refs/heads/${base}`),
    baseOnOrigin: refExists(`refs/remotes/origin/${base}`),
    itemPrefix: kit.itemPrefix,
    commitSubject: kit.commitSubject,
    linkedWorktree: Boolean(gitDir && commonDir && resolve(gitDir) !== resolve(commonDir)),
    kitJson: kit.found ? "found" : kit.error ?? "missing",
  };
  console.log(JSON.stringify(context, null, 2));
}

if (isDirectRun(import.meta.url)) main();
