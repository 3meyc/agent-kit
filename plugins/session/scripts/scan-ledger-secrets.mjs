/**
 * Pre-commit backstop for the ledger's secret redaction: run it from a project's pre-commit hook,
 * or by hand, over the staged ledger records (`kit.json` `paths.ledger`, default `.claude/ledger/`).
 *
 *   node <plugin>/scripts/scan-ledger-secrets.mjs <path>...
 *   scan-ledger-secrets <path>...       # the same, from a Claude Code session (plugin `bin/`)
 *
 * Both ledger writers redact before writing, so this should never fire. It exists for what they do
 * not see: a record edited by hand, a writer that regressed. It reads the
 * **staged** blob, not the working copy — the index is what the commit will push — and fails with
 * the path and kind of each match, never the match itself, so the log does not leak it either.
 */
import { execFileSync } from "node:child_process";
import { rootFor } from "./kit-config.mjs";

const REPO_ROOT = rootFor(process.cwd());
import { findSecrets } from "./ledger-text.mjs";

/** @param {string} path */
function stagedText(path) {
  try {
    return execFileSync("git", ["show", `:${path.replace(/\\/g, "/")}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Deleted or not staged: nothing of it will be committed.
    return "";
  }
}

const hits = [];
for (const path of process.argv.slice(2)) {
  for (const { kind } of findSecrets(stagedText(path))) hits.push(`${path}: ${kind}`);
}
if (hits.length > 0) {
  console.error("Secret-shaped text in staged ledger files — redact it before committing:");
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
