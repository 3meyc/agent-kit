/**
 * PostToolUse hook `lint-edited-file`: lint the file an Edit/Write/MultiEdit call just changed.
 *
 * The commands come from `kit.json` `lintOnEdit`, one rule or a list of rules:
 *
 *   "lintOnEdit": { "command": "pnpm exec eslint --no-warn-ignored {file}", "match": ["*.ts", "*.svelte"] }
 *   "lintOnEdit": [
 *     { "command": "pnpm exec eslint --no-warn-ignored {file}", "match": ["src/**"] },
 *     { "command": "pnpm run i18n:check", "match": ["src/locales/*.json"] }
 *   ]
 *
 * `{file}` is replaced by the repo-relative path, quoted; without it the path is appended. `match`
 * holds globs over the repo-relative path (a pattern without `/` matches the basename anywhere);
 * left out, the rule takes every edited file inside the repo. Every rule that matches runs, in the
 * listed order, and a failing one does not stop the next. No `lintOnEdit`: the hook does nothing.
 *
 * Any failing rule exits 2, which shows stderr to the agent without undoing the edit. Each command
 * runs from the root of the checkout that holds the edited file, through the shell, with the hook's
 * own timeout as the only limit. That checkout, not the session's project, gives the root: in a
 * worktree nested under the main checkout (`.claude/worktrees/…`) the session's project is the
 * outer checkout, and paths relative to it never match the globs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { EDIT_TOOLS, isDirectRun, readHookInput, repoRelativePath } from "../lib/hook-utils.mjs";
import { checkoutRoot, hookOff, lintOnEdit, readKit, rootFor } from "../lib/kit-config.mjs";
import { matchesAny, withFile } from "../src/lint-match.mjs";

export const HOOK_ID = "lint-edited-file";
const MAX_OUTPUT = 4000;

/**
 * The checkout the edited file belongs to; without a file path, the one holding the payload's cwd.
 * @param {Record<string, any>} input
 */
export function lintRootFor(input) {
  const edited = editedAbsolutePath(input);
  return (edited && checkoutRoot(dirname(edited))) || rootFor(input?.cwd ?? process.cwd());
}

/** The edited file as an absolute path, or null. @param {Record<string, any>} input */
function editedAbsolutePath(input) {
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath === "") return null;
  return isAbsolute(filePath) ? filePath : resolve(input?.cwd ?? process.cwd(), filePath);
}

/** @param {string} path */
function realOrSame(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The shell commands to run for this payload, in rule order; empty when there is nothing to lint.
 * @param {Record<string, any>} input @param {import("../lib/kit-config.mjs").Kit | Record<string, any>} config @param {string} root
 * @returns {Array<{ file: string, command: string }>}
 */
export function lintCommandsFor(input, config, root) {
  if (hookOff(HOOK_ID, config)) return [];
  if (!EDIT_TOOLS.has(input?.tool_name ?? "")) return [];
  const rules = lintOnEdit(config);
  if (rules.length === 0) return [];
  const edited = editedAbsolutePath(input);
  if (edited === null) return [];
  // git prints the resolved top level (/private/var on macOS) while the payload may hold a symlinked path.
  const file = repoRelativePath(realOrSame(edited), root, realOrSame(root));
  if (file === null || !existsSync(resolve(root, file))) return [];
  return rules.filter((rule) => matchesAny(file, rule.match)).map((rule) => ({ file, command: withFile(rule.command, file) }));
}

/** Run one lint command; the failure text, or null when it passed. @param {{ file: string, command: string }} target @param {string} root */
function runLint(target, root) {
  const result = spawnSync(target.command, { cwd: root, encoding: "utf8", shell: true });
  if (result.status === 0) return null;
  let output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) output = `${output}\n${result.error.message}`.trim();
  if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n… (${output.length - MAX_OUTPUT} more characters)`;
  return `lint failed for ${target.file} (\`${target.command}\`):\n${output}`;
}

export async function main(input) {
  let failures;
  try {
    const root = lintRootFor(input);
    failures = lintCommandsFor(input, readKit(root), root)
      .map((target) => runLint(target, root))
      .filter((failure) => failure !== null);
  } catch (error) {
    // A hook fault (a bad `match` glob, say) is one stderr line, never a stack trace on every edit.
    console.error(`${HOOK_ID}: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (failures.length === 0) return;
  console.error(failures.join("\n\n"));
  process.exit(2);
}

if (isDirectRun(import.meta.url)) await main(await readHookInput());
