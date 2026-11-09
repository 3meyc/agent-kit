/**
 * Pre-commit backstop for the ledger's secret redaction: run it from a project's pre-commit hook,
 * or by hand, over the staged ledger records (`kit.json` `paths.ledger`, default `.claude/ledger/`).
 *
 *   node <plugin>/scripts/scan-ledger-secrets.mjs [<path>...]
 *   scan-ledger-secrets [<path>...]             # the same, from a Claude Code session (plugin `bin/`)
 *   agent-kit ledger-scan-secrets [<path>...]   # the same, from a git hook (this repo as a dev dependency)
 *
 * Without paths it scans the staged files in the ledger folder.
 *
 * Both ledger writers redact before writing, so this should never fire. It exists for what they do
 * not see: a record edited by hand, a writer that regressed. It reads the
 * **staged** blob, not the working copy — the index is what the commit will push — and fails with
 * the path and kind of each match, never the match itself, so the log does not leak it either.
 */
import { execFileSync } from "node:child_process";
import { isDirectRun } from "../lib/hook-utils.mjs";
import { readKit, rootFor } from "../lib/kit-config.mjs";
import { findSecrets } from "./ledger-text.mjs";

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** @param {string} root @param {string} path */
function stagedText(root, path) {
  try {
    return git(root, ["show", `:${path.replace(/\\/g, "/")}`]);
  } catch {
    // Deleted or not staged: nothing of it will be committed.
    return "";
  }
}

/** The staged (added, copied, modified, renamed) files in the ledger folder. @param {string} root */
export function stagedLedgerFiles(root) {
  try {
    const ledger = readKit(root).paths.ledger;
    return git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--", ledger]).split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `<path>: <kind>` for each secret-shaped match in the staged copy of each path; without paths,
 * the staged files in the ledger folder (`kit.json` `paths.ledger`).
 * @param {string} root @param {string[]} paths
 */
export function scanStaged(root, paths) {
  const hits = [];
  for (const path of paths.length > 0 ? paths : stagedLedgerFiles(root)) {
    for (const { kind } of findSecrets(stagedText(root, path))) hits.push(`${path}: ${kind}`);
  }
  return hits;
}

/** Exit code 1 and the hits on stderr when anything matched. @param {string[]} paths */
export function main(paths, root = rootFor(process.cwd())) {
  const hits = scanStaged(root, paths);
  if (hits.length === 0) return 0;
  console.error("Secret-shaped text in staged ledger files — redact it before committing:");
  for (const hit of hits) console.error(`  ${hit}`);
  return 1;
}

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
