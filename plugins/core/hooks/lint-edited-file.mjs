/**
 * PostToolUse hook `lint-edited-file`: lint the file an Edit/Write/MultiEdit call just changed.
 *
 * The command comes from `kit.json` `lintOnEdit`:
 *
 *   "lintOnEdit": { "command": "pnpm exec eslint --no-warn-ignored {file}", "match": ["*.ts", "*.svelte"] }
 *
 * `{file}` is replaced by the repo-relative path, quoted; without it the path is appended. `match`
 * holds globs over the repo-relative path (a pattern without `/` matches the basename anywhere);
 * left out, every edited file inside the repo is linted. No `lintOnEdit`: the hook does nothing.
 *
 * A failing lint exits 2, which shows stderr to the agent without undoing the edit. The command
 * runs from the project root through the shell, with the hook's own timeout as the only limit.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EDIT_TOOLS, editedFilePath, isDirectRun, projectRoot, readHookInput } from "../lib/hook-utils.mjs";
import { hookOff, lintOnEdit, readKit } from "../lib/kit-config.mjs";
import { matchesAny, withFile } from "../src/lint-match.mjs";

export const HOOK_ID = "lint-edited-file";
const MAX_OUTPUT = 4000;

/**
 * The shell command to run for this payload, or null when there is nothing to lint.
 * @param {Record<string, any>} input @param {import("../lib/kit-config.mjs").Kit | Record<string, any>} config @param {string} root
 */
export function lintCommandFor(input, config, root) {
  if (hookOff(HOOK_ID, config)) return null;
  if (!EDIT_TOOLS.has(input?.tool_name ?? "")) return null;
  const lint = lintOnEdit(config);
  if (lint === null) return null;
  const file = editedFilePath(input);
  if (file === null || !existsSync(resolve(root, file))) return null;
  if (!matchesAny(file, lint.match)) return null;
  return { file, command: withFile(lint.command, file) };
}

export async function main(input) {
  const root = projectRoot();
  const target = lintCommandFor(input, readKit(root), root);
  if (target === null) return;
  const result = spawnSync(target.command, { cwd: root, encoding: "utf8", shell: true });
  if (result.status === 0) return;
  let output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) output = `${output}\n${result.error.message}`.trim();
  if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n… (${output.length - MAX_OUTPUT} more characters)`;
  console.error(`lint failed for ${target.file} (\`${target.command}\`):\n${output}`);
  process.exit(2);
}

if (isDirectRun(import.meta.url)) await main(await readHookInput());
