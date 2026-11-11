/**
 * `kit-repo <plugin|plugin@marketplace|path> [--json]` (on the Bash PATH, from the plugin's `bin/`):
 * the GitHub repository a kit gap is opened in, from the plugin's marketplace source. `/close-out`
 * and `/handoff` call it before `gh issue create`; exit 1 with the reason when there is none.
 */
import { isDirectRun } from "../lib/hook-utils.mjs";
import { rootFor } from "../lib/kit-config.mjs";
import { formatKitRepo, kitRepo } from "../lib/kit-repo.mjs";

/** @param {string[]} argv @param {{ root?: string | null, dir?: string, out?: (line: string) => void }} [opts] */
export function main(argv, { root = rootFor(process.cwd()), dir, out = console.log } = {}) {
  const json = argv.includes("--json");
  const target = argv.find((a) => !a.startsWith("-")) ?? "";
  const result = kitRepo(target, dir ? { root, dir } : { root });
  out(json ? JSON.stringify(result, null, 2) : formatKitRepo(result));
  return result.repo ? 0 : 1;
}

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
