// One line for the codegraph skill: whether this repo has a CodeGraph index and the CLI is on
// PATH. Never fails: any problem reads as "missing".
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDirectRun, projectRoot } from "../lib/hook-utils.mjs";

export function codegraphState(root = projectRoot()) {
  const index = existsSync(join(root, ".codegraph"));
  const cli = spawnSync("codegraph", ["--version"], { encoding: "utf8", shell: process.platform === "win32", timeout: 5000 });
  return { index, cli: cli.status === 0 };
}

if (isDirectRun(import.meta.url)) {
  const { index, cli } = codegraphState();
  if (index && cli) console.log("present (.codegraph/ at the repo root, codegraph CLI on PATH)");
  else console.log(`missing (${index ? "" : "no .codegraph/ at the repo root"}${!index && !cli ? "; " : ""}${cli ? "" : "no codegraph CLI on PATH"})`);
}
