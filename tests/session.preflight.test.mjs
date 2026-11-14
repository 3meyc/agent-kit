// The session plugin's preflight counters, the ledger secret scanner without paths, and the
// `agent-kit` command a git hook calls from node_modules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeKit } from "../shared/kit-config.mjs";
import { countCommit, countsFile, main, recordCommit, reminderLines, statusLines, touches } from "../plugins/session/scripts/preflight.mjs";
import { parentFilesLine, parentOwned, roleOf, sessionRole } from "../plugins/session/scripts/session-role.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-kit-preflight-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd, ...args) =>
  spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function project(name, kit) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "core.hooksPath", "no-hooks");
  if (kit) writeFileSync(join(dir, "kit.json"), JSON.stringify(kit));
  return dir;
}

const KIT = {
  project: "t",
  preflight: {
    docs: { description: "Docs review, the docs-review skill", match: ["docs/**", "*.md"], remindAfter: 2 },
    audit: { description: "Audit", command: "node -e 0" },
  },
};

describe("preflight counts", () => {
  const kit = normalizeKit(KIT);

  it("counts a step only for a commit it touches, never for ledger records", () => {
    assert.equal(touches(kit.preflight.docs, ["src/a.ts"], kit), false);
    assert.equal(touches(kit.preflight.docs, ["README.md"], kit), true);
    assert.equal(touches(kit.preflight.audit, [".claude/ledger/2026-11-01-aaaaaaaa.md"], kit), false);
    assert.equal(touches(kit.preflight.audit, ["src/a.ts"], kit), true);
    const once = countCommit(kit, { gone: { skipped: 9, lastRun: null } }, ["src/a.ts"]);
    assert.deepEqual(once, { docs: { skipped: 0, lastRun: null }, audit: { skipped: 1, lastRun: null } });
    const twice = countCommit(kit, countCommit(kit, once, ["docs/x.md"]), ["docs/y.md"]);
    assert.deepEqual(reminderLines(kit, twice), [
      "preflight: docs skipped in 2 commit(s) since its last run; Docs review, the docs-review skill, then `preflight done docs`",
      "preflight: audit skipped in 3 commit(s) since its last run; `preflight run audit`",
    ]);
    assert.deepEqual(statusLines(normalizeKit({ project: "t" }), {}), ["No preflight steps in kit.json."]);
  });

  it("keeps the counts in the common git folder, shared with worktrees", () => {
    const dir = project("common", KIT);
    assert.equal(countsFile(dir), join(dir, ".git", "agent-kit", "preflight.json"));
    assert.equal(countsFile(join(scratch)), null);
  });

  it("runs a step and clears its count, and clears a step that ran another way", () => {
    const dir = project("cli", { ...KIT, preflight: { ...KIT.preflight, broken: { description: "Fails", command: 'node -e "process.exit(4)"' } } });
    const file = countsFile(dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ steps: { docs: { skipped: 4, lastRun: null }, audit: { skipped: 2, lastRun: null }, broken: { skipped: 1, lastRun: null } } }));
    const lines = [];
    const print = (line) => lines.push(line);
    assert.equal(main(["run", "audit"], dir, print), 0);
    assert.equal(main(["done", "docs"], dir, print), 0);
    assert.equal(main(["run", "broken"], dir, print), 1);
    assert.equal(main(["run", "docs"], dir, print), 1);
    assert.equal(main(["run", "nope"], dir, print), 1);
    const steps = JSON.parse(readFileSync(file, "utf8")).steps;
    assert.equal(steps.audit.skipped, 0);
    assert.equal(steps.docs.skipped, 0);
    assert.ok(steps.docs.lastRun);
    assert.equal(steps.broken.skipped, 1);
    assert.ok(lines.includes("preflight: cleared audit"));
    assert.ok(lines.some((line) => line.startsWith("preflight: broken failed (exit 4)")));
    assert.ok(lines.some((line) => line.startsWith("preflight: docs has no command")));
    assert.ok(lines.some((line) => line.startsWith("preflight: no step nope in kit.json")));
    lines.length = 0;
    assert.equal(main(["status"], dir, print), 0);
    assert.match(lines[0], /^1\. docs: up to date \(last run \d{4}-\d{2}-\d{2}\) — Docs review/);
    assert.match(lines[2], /^3\. broken: 1 commit\(s\) since its last run \(never run\) — `node -e "process.exit\(4\)"`$/);
  });
});

describe("preflight steps scoped to the main session", () => {
  const kit = normalizeKit({
    project: "t",
    preflight: {
      docs: { description: "Docs review, the docs-review skill", scope: "main" },
      audit: { description: "Audit", command: "node -e 0" },
    },
  });
  const counts = { docs: { skipped: 2, lastRun: null }, audit: { skipped: 1, lastRun: null } };

  it("reminds the main session with a scope note, and a sub-session of the other steps only", () => {
    assert.deepEqual(reminderLines(kit, counts), [
      "preflight: docs skipped in 2 commit(s) since its last run; Docs review, the docs-review skill, then `preflight done docs` (main session only: a sub-session leaves it to its parent's /close-siblings)",
      "preflight: audit skipped in 1 commit(s) since its last run; `preflight run audit`",
    ]);
    assert.deepEqual(reminderLines(kit, counts, "child"), ["preflight: audit skipped in 1 commit(s) since its last run; `preflight run audit`"]);
  });

  it("tags main-scoped steps in status and filters by scope", () => {
    assert.match(statusLines(kit, counts)[0], /^1\. docs \[main session\]: 2 commit\(s\)/);
    assert.deepEqual(statusLines(kit, counts, "main").length, 1);
    assert.deepEqual(statusLines(normalizeKit({ project: "t", preflight: { a: { description: "A" } } }), {}, "main"), ["No main-scoped preflight steps in kit.json."]);
    const dir = project("scoped", { project: "t", preflight: { docs: { description: "Docs", scope: "main" }, audit: { description: "Audit" } } });
    const lines = [];
    assert.equal(main(["status", "--scope", "main"], dir, (line) => lines.push(line)), 0);
    assert.deepEqual(lines, ["1. docs [main session]: up to date (never run) — Docs"]);
    assert.equal(main(["status", "--scope", "child"], dir, () => {}), 1);
    assert.equal(main(["status", "--bogus"], dir, () => {}), 1);
  });

  it("counts a sub-session's commit but prints no reminder for a main-scoped step", () => {
    const dir = project("child-commit", { project: "t", preflight: { docs: { description: "Docs", scope: "main" } } });
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
    git(dir, "checkout", "-q", "-b", "claude/child");
    git(dir, "config", "branch.claude/child.kitBase", "claude/parent");
    assert.deepEqual(recordCommit(dir, ["docs/a.md"]), []);
    assert.equal(JSON.parse(readFileSync(countsFile(dir), "utf8")).steps.docs.skipped, 1);
    git(dir, "config", "branch.claude/child.kitRole", "main");
    assert.equal(recordCommit(dir, ["docs/a.md"]).length, 1);
  });
});

describe("session-role", () => {
  it("is child when recorded so or when the base is another session's branch, else main", () => {
    assert.deepEqual(roleOf({}), { role: "main", source: "default" });
    assert.deepEqual(roleOf({ base: "dev" }), { role: "main", source: "default" });
    assert.deepEqual(roleOf({ base: "claude/parent-1a2b" }), { role: "child", source: "base" });
    assert.deepEqual(roleOf({ recorded: "main", base: "claude/parent-1a2b" }), { role: "main", source: "recorded" });
    assert.deepEqual(roleOf({ recorded: "child", base: "dev" }), { role: "child", source: "recorded" });
    assert.equal(sessionRole(scratch).role, "main");
  });

  it("names the parent-owned files a commit holds: parentFiles and top-level <sdlc>/*.md", () => {
    const kit = normalizeKit({ project: "t", parentFiles: ["CHANGELOG.md", "docs/roadmap*.md"], paths: { sdlc: "work" } });
    assert.deepEqual(parentOwned(["CHANGELOG.md", "docs/roadmap-2027.md", "work/backlog.md", "work/my-item/plan.md", "src/a.ts"], kit), [
      "CHANGELOG.md",
      "docs/roadmap-2027.md",
      "work/backlog.md",
    ]);
    assert.equal(parentFilesLine([]), null);
    assert.match(parentFilesLine(["CHANGELOG.md"]), /^parent-files: CHANGELOG\.md belong to the main session/);
  });

  it("lets a sub-session mark only its own ledger items done", () => {
    const dir = project("ledger-guard", { project: "t", ledger: true });
    mkdirSync(join(dir, ".claude", "ledger"), { recursive: true });
    const record = (id) =>
      writeFileSync(join(dir, ".claude", "ledger", `2026-11-01-${id}.md`), `---\nsession: ${id}-0000\n---\n\n## Next\n\n1. first\n2. second\n`);
    record("aaaa0001");
    record("bbbb0002");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "checkout", "-q", "-b", "claude/child");
    git(dir, "config", "branch.claude/child.kitBase", "claude/parent");
    const ledger = join(repo, "plugins", "session", "scripts", "session-ledger.mjs");
    const cli = (...args) => spawnSync(process.execPath, [ledger, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "" } });
    const refused = cli("--done", "aaaa0001", "1", "--as", "bbbb0002");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /sub-session, so it leaves aaaa0001 1 to its parent/);
    assert.equal(cli("--done", "bbbb0002", "1", "--as", "bbbb0002").status, 0);
    assert.equal(cli("--done", "aaaa0001", "2", "--as", "bbbb0002", "--in-child").status, 0);
    git(dir, "config", "branch.claude/child.kitRole", "main");
    assert.equal(cli("--done", "aaaa0001", "1", "--as", "bbbb0002").status, 0);
  });
});

describe("agent-kit ledger-scan-secrets", () => {
  const bin = join(repo, "bin", "agent-kit.mjs");
  const run = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });

  it("is the root package's bin, executable, with a node shebang", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    assert.deepEqual(pkg.bin, { "agent-kit": "bin/agent-kit.mjs" });
    assert.ok(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
    if (process.platform !== "win32") assert.ok(statSync(bin).mode & 0o111);
  });

  it("fails on a staged ledger record with a secret, by path or with no paths, and passes a clean one", () => {
    const dir = project("scan", { project: "t", ledger: true, paths: { ledger: "notes/ledger" } });
    mkdirSync(join(dir, "notes", "ledger"), { recursive: true });
    const record = "notes/ledger/2026-11-01-aaaaaaaa.md";
    writeFileSync(join(dir, record), "token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    writeFileSync(join(dir, "other.md"), "ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    git(dir, "add", "-A");
    const byPath = run(dir, "ledger-scan-secrets", record);
    assert.equal(byPath.status, 1);
    assert.match(byPath.stderr, new RegExp(`${record}: `));
    assert.doesNotMatch(byPath.stderr, /ghp_/);
    const staged = run(dir, "ledger-scan-secrets");
    assert.equal(staged.status, 1);
    assert.match(staged.stderr, /notes\/ledger\/2026-11-01-aaaaaaaa\.md/);
    assert.doesNotMatch(staged.stderr, /other\.md/);
    writeFileSync(join(dir, record), "clean\n");
    git(dir, "add", "-A");
    assert.equal(run(dir, "ledger-scan-secrets").status, 0);
  });

  it("prints its usage for no command and refuses an unknown one", () => {
    assert.equal(run(repo).status, 1);
    assert.equal(run(repo, "--help").status, 0);
    const unknown = run(repo, "nope");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown command nope/);
  });
});
