// Session-start output stays under Claude Code's hook-output cap (docs/spikes.md S10): a hook's
// plain stdout over 10,000 characters is saved to a file and the session sees only a preview of
// about 2,000, so the rest never reaches the model. Each hook is measured on its own, so each kit
// SessionStart hook gets the kit budget below, which leaves headroom under the cap.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { rulesText, updateText } from "../plugins/core/hooks/session-start.mjs";
import { failureText } from "../plugins/session/scripts/worktree-setup-hook.mjs";

/** Claude Code's cap on one hook's plain stdout, in characters (docs/spikes.md S10). */
export const HOOK_OUTPUT_CAP = 10_000;
/** What one kit SessionStart hook may print at most: the cap less a margin for growth. */
export const KIT_HOOK_BUDGET = 8_000;

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-kit-start-size-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd, ...args) =>
  spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });

/** Print the measured sizes, so a run shows how close each hook is. */
function report(name, text) {
  console.log(`# ${name}: ${text.length} characters (budget ${KIT_HOOK_BUDGET}, cap ${HOOK_OUTPUT_CAP})`);
  return text.length;
}

describe("session-start output size", () => {
  it("keeps the budget under the cap", () => {
    assert.ok(KIT_HOOK_BUDGET < HOOK_OUTPUT_CAP);
  });

  it("core: the rules plus a worst-case update notice fit the budget", () => {
    const lagging = Array.from({ length: 12 }, (_, i) => ({
      plugin: `plugin-with-a-long-name-${i}`,
      marketplace: `marketplace-with-a-long-name-${i % 3}`,
      scope: i % 2 ? "local" : "project",
      installed: "0123456789abcdef0123456789abcdef01234567",
      latest: "fedcba9876543210fedcba9876543210fedcba98",
      ref: "stable",
    }));
    const text = `${rulesText()}\n\n${updateText(lagging)}\n`;
    assert.ok(report("core session-start (rules + 12 lagging plugins)", text) <= KIT_HOOK_BUDGET);
  });

  it("core: the hook as a process prints the rules within the budget", () => {
    const project = join(scratch, "core-project");
    mkdirSync(project, { recursive: true });
    const result = spawnSync(process.execPath, [join(repo, "plugins", "core", "hooks", "session-start.mjs")], {
      encoding: "utf8",
      input: JSON.stringify({ source: "startup", cwd: project }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: join(scratch, "no-config"), CLAUDE_PLUGIN_DATA: join(scratch, "data") },
    });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes(rulesText().slice(0, 40)));
    assert.ok(report("core session-start (as run)", result.stdout) <= KIT_HOOK_BUDGET);
  });

  it("session: the ledger brief of a crowded ledger fits the budget", () => {
    const project = join(scratch, "crowded");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "kit.json"), JSON.stringify({ project: "t", ledger: true }));
    writeFileSync(join(project, ".gitignore"), ".claude/\n");
    git(project, "init", "-q", "-b", "main");
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", "init");
    const ledger = join(project, ".claude", "ledger");
    mkdirSync(ledger, { recursive: true });
    const long = (word) => `${`${word} `.repeat(60)}end`;
    const paths = Array.from({ length: 30 }, (_, i) => `src/${"deeply/nested/folder/".repeat(6)}file-number-${i}.ts`);
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-10-${String(day).padStart(2, "0")}`;
      const id8 = String(day).padStart(8, "a");
      const next = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${i % 2 ? "(unverified) " : ""}${long("owed")}`).join("\n");
      writeFileSync(
        join(ledger, `${date}-${id8}.md`),
        `---\nid: ${id8}-1111-2222-3333-444444444444\ndate: ${date}\ntitle: "${long("title")}"\nflags: [process-change]\ncommits: []\n---\n\n# ${date} · ${id8}\n\n## Intent\n\nx\n\n## Decisions\n\n${long("decided")}\n\n## Next\n\n${next}\n\n## Files (${paths.length})\n\n${paths.map((path) => `- ${path}`).join("\n")}\n`,
      );
    }
    const result = spawnSync(process.execPath, [join(repo, "plugins", "session", "scripts", "ledger-brief.mjs")], {
      cwd: project,
      encoding: "utf8",
      input: JSON.stringify({ cwd: project }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length > 0, "the brief printed nothing: the fixture no longer exercises it");
    assert.ok(report("session ledger-brief (28 crowded records)", result.stdout) <= KIT_HOOK_BUDGET);
  });

  it("session: a failed worktree set-up reports within the budget, however long its output", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(2_000)}`).join("\n");
    const text = `${failureText(["install", "codegraph"], "exit 1", output)}\n`;
    assert.ok(report("session worktree-setup (failure)", text) <= KIT_HOOK_BUDGET);
  });
});
