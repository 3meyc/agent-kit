// `git-branch-context`: branch, upstream and default base as JSON, for PR and commit prep. Refs go
// to git as argv, so `@{upstream}` needs no quoting on any shell. With a kit.json, its
// `baseBranch` is reported as well. Without one, the default base is `dev` when the repo has it
// (locally or on `origin`), else `origin/HEAD`, else `main` or `master`.
import { execFileSync } from "node:child_process";
import { readKit } from "../lib/kit-config.mjs";

/** @param {string[]} args @returns {string | null} */
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

const refExists = (ref) => git("rev-parse", "--verify", "--quiet", ref) !== null;

export function main() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!branch) {
    console.error("git-branch-context: not a git repository or git is unavailable.");
    return 1;
  }
  const top = git("rev-parse", "--show-toplevel");
  const upstream = git("rev-parse", "--abbrev-ref", "@{upstream}");
  const remoteHead = git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  const hasMain = refExists("refs/remotes/origin/main") || refExists("refs/heads/main");
  const hasMaster = refExists("refs/remotes/origin/master") || refExists("refs/heads/master");
  const hasDev = refExists("refs/heads/dev") || refExists("refs/remotes/origin/dev");
  const kitBase = top ? readKit(top).raw?.baseBranch : undefined;
  let defaultBase = null;
  if (typeof kitBase === "string" && kitBase) defaultBase = kitBase;
  else if (hasDev) defaultBase = "dev";
  else if (remoteHead) defaultBase = remoteHead.replace(/^origin\//, "");
  else if (hasMain) defaultBase = "main";
  else if (hasMaster) defaultBase = "master";
  console.log(JSON.stringify({ branch, upstream, defaultBase, kitBaseBranch: kitBase ?? null, hasMain, hasMaster }, null, 2));
  return 0;
}
