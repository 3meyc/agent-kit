import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "./session/vitest-compat.mjs";
import { editedFilesInTranscript, readCommitFacts } from "../plugins/session/scripts/ledger-utils.mjs";
import { projectRoot } from "../shared/hook-utils.mjs";

// The session plugin's ledger helpers (`ledger-utils.mjs`). Tests of the shared helpers they lean
// on are in `tests/hook-utils.test.mjs`.
const REPO_ROOT = projectRoot();

let root;
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const write = (rel, text = "x\n") => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "watched-"));
  git("init", "-q");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readCommitFacts", () => {
  const commit = (message, trailer) =>
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
      ...(trailer ? ["--trailer", trailer] : []),
    );

  it("finds a session's commits on every branch, and gives the window's start", () => {
    write("a.txt");
    git("add", "a.txt");
    commit("base", "Session-Id: on-main");
    git("switch", "-q", "-c", "side");
    commit("side work", "Session-Id: on-side");
    git("switch", "-q", "-");

    const facts = readCommitFacts(root);

    expect([...facts.commitsBySession.keys()].sort()).toEqual(["on-main", "on-side"]);
    expect(facts.lastCommit.has("a.txt")).toBe(true);
    expect(facts.sinceSec).toBeLessThan(Date.now() / 1000);
  });

  it("gives a path a merge commit changed against its first parent that merge's time", () => {
    // After every commit the test makes, so the merge is the newest whatever the clock says.
    const mergeSec = Math.floor(Date.now() / 1000) + 3600;
    write("a.txt");
    git("add", "a.txt");
    commit("base");
    git("switch", "-q", "-c", "side");
    write("brought.txt");
    git("add", "brought.txt");
    commit("side work");
    git("switch", "-q", "-");
    commit("our work");
    spawnSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=T", "merge", "-q", "--no-ff", "-m", "merge", "side"],
      {
        cwd: root,
        env: { ...process.env, GIT_COMMITTER_DATE: `@${mergeSec} +0000` },
      },
    );

    const facts = readCommitFacts(root);

    expect(facts.lastCommit.get("brought.txt")).toBe(mergeSec);
    expect(facts.lastCommit.get("a.txt")).toBeLessThan(mergeSec);
  });
});

describe("editedFilesInTranscript", () => {
  it("includes a sub-agent's edits and skips an isolated sub-agent's worktree", () => {
    const transcript = join(root, "session.jsonl");
    const edit = (file, cwd) =>
      JSON.stringify({
        type: "assistant",
        cwd,
        message: {
          content: [{ type: "tool_use", id: file, name: "Edit", input: { file_path: join(REPO_ROOT, file) } }],
        },
      });
    writeFileSync(transcript, edit(".claude/rules/a.md", REPO_ROOT) + "\n");
    write("session/subagents/agent-1.jsonl", edit(".claude/rules/b.md", REPO_ROOT) + "\n");
    write(
      "session/subagents/agent-2.jsonl",
      edit(".claude/rules/c.md", join(REPO_ROOT, ".claude", "worktrees", "x")) + "\n",
    );

    expect([...editedFilesInTranscript(transcript)].sort()).toEqual([".claude/rules/a.md", ".claude/rules/b.md"]);
  });
});
