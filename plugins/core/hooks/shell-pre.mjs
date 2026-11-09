/**
 * PreToolUse dispatcher for Bash / PowerShell: one node process for two duties.
 *
 * Each hook entry is its own `node` spawn, about 40 ms even when the script leaves at once, and
 * both duties read the same payload and leave on the same no-op path, so a second process would
 * decide nothing new on every shell call. Running them here, in this order, halves the spawns:
 *
 * 1. `shell-deletions` — the `pre` snapshot must be taken before anything the call does.
 * 2. `codegraph-sync` — may take seconds (sync, lock retries); nothing waits on it now.
 *
 * kit.json is read once and handed to both. Each duty runs behind its own try/catch: one failing
 * never skips the other, and neither ever blocks the tool call (one stderr line, exit 0).
 */
import { isDirectRun, projectRoot, readHookInput } from "../lib/hook-utils.mjs";
import { readKit } from "../lib/kit-config.mjs";
import { run as runSync } from "./codegraph-sync.mjs";
import { run as runDeletions } from "./shell-deletions.mjs";

/** The duties, in the order they run; each is `[hook id, async (input, config) => void]`. */
export const DUTIES = [
  ["shell-deletions", runDeletions],
  ["codegraph-sync", runSync],
];

/**
 * Run every duty on one parsed payload, in order, each isolated from the others' failures.
 * @param {Record<string, unknown>} input
 * @param {Array<[string, (input: Record<string, unknown>, config: import("../lib/kit-config.mjs").Kit) => Promise<void> | void]>} [duties]
 * @param {import("../lib/kit-config.mjs").Kit} [config]
 */
export async function dispatch(input, duties = DUTIES, config = readKit(projectRoot())) {
  for (const [name, duty] of duties) {
    try {
      await duty(input, config);
    } catch (error) {
      console.error(`${name}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

if (isDirectRun(import.meta.url)) await dispatch(await readHookInput());
