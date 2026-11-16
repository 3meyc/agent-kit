/**
 * PreToolUse dispatcher for Bash / PowerShell: one node process for three duties.
 *
 * Each hook entry is its own `node` spawn, about 40 ms even when the script leaves at once, and
 * every duty reads the same payload and leaves on the same no-op path, so more processes would
 * decide nothing new on every shell call. Running them here, in this order, saves the spawns:
 *
 * 1. `shell-deletions` — the `pre` snapshot must be taken before anything the call does.
 * 2. `rtk-rewrite` — RTK's answer for the call (a rewritten command), printed as this hook's output.
 * 3. `codegraph-sync` — may take seconds (sync, lock retries); nothing waits on it now.
 *
 * kit.json is read once, from the checkout holding the payload's cwd (`rootFor`, as the lint hook
 * does), and handed to every duty. Each duty runs behind its own try/catch: one failing
 * never skips the others, and none ever blocks the tool call (one stderr line, exit 0). A duty
 * that returns an object hands it on as the hook's JSON output; the last one wins.
 */
import { isDirectRun, readHookInput } from "../lib/hook-utils.mjs";
import { readKit, rootFor } from "../lib/kit-config.mjs";
import { run as runSync } from "./codegraph-sync.mjs";
import { run as runRtk } from "./rtk-rewrite.mjs";
import { run as runDeletions } from "./shell-deletions.mjs";

/** The duties, in the order they run; each is `[hook id, async (input, config) => output | void]`. */
export const DUTIES = [
  ["shell-deletions", runDeletions],
  ["rtk-rewrite", runRtk],
  ["codegraph-sync", runSync],
];

/**
 * Run every duty on one parsed payload, in order, each isolated from the others' failures.
 * @param {Record<string, unknown>} input
 * @param {Array<[string, (input: Record<string, unknown>, config: import("../lib/kit-config.mjs").Kit) => unknown]>} [duties]
 * @param {import("../lib/kit-config.mjs").Kit} [config]
 * @returns {Promise<Record<string, unknown> | null>} The hook output to print, or null.
 */
export async function dispatch(input, duties = DUTIES, config = readKit(rootFor(input?.cwd))) {
  let output = null;
  for (const [name, duty] of duties) {
    try {
      const result = await duty(input, config);
      if (result && typeof result === "object") output = result;
    } catch (error) {
      console.error(`${name}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return output;
}

if (isDirectRun(import.meta.url)) {
  const output = await dispatch(await readHookInput());
  if (output) process.stdout.write(JSON.stringify(output));
}
