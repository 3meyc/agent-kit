import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "./session/vitest-compat.mjs";
import { editedFilesInTranscript, readCommitFacts } from "../plugins/session/scripts/ledger-utils.mjs";
import {
  appendHookLog,
  isDirectRun,
  parseWorktrees,
  projectRoot,
  transcriptDirs,
  transcriptRoot,
} from "../shared/hook-utils.mjs";

// The session plugin's ledger helpers (`ledger-utils.mjs`), plus the source projects' tests of the
// shared helpers they lean on, which `tests/hook-utils.test.mjs` does not cover yet.
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

describe("appendHookLog", () => {
  it("appends one line to the named log in the git common dir", () => {
    expect(appendHookLog("probe.log", "a\tb", root)).toBe(true);
    expect(appendHookLog("probe.log", "c", root)).toBe(true);
    expect(readFileSync(join(root, ".git", "probe.log"), "utf8")).toBe("a\tb\nc\n");
  });

  it("reports false outside a git repository instead of throwing", () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    try {
      expect(appendHookLog("probe.log", "x", plain)).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
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

describe("isDirectRun", () => {
  it("recognises the entry file through a symlinked path, and not an imported module", () => {
    const real = join(root, "real");
    mkdirSync(real);
    writeFileSync(
      join(real, "hook.mjs"),
      'import { isDirectRun } from "HOOK_UTILS";\nconsole.log(isDirectRun(import.meta.url));\n'.replace(
        "HOOK_UTILS",
        join(REPO_ROOT, "shared", "hook-utils.mjs"),
      ),
    );
    symlinkSync(real, join(root, "link"));
    const viaLink = spawnSync(process.execPath, [join(root, "link", "hook.mjs")], { encoding: "utf8" });
    expect(viaLink.stdout.trim()).toBe("true");
    // An imported module is not the entry: hook-utils.mjs itself, asked from this test process.
    expect(isDirectRun(new URL("../shared/hook-utils.mjs", import.meta.url).href)).toBe(false);
  });
});

describe("transcriptDirs and transcriptRoot", () => {
  const slug = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");
  const checkout = () => join(root, "repo");
  const worktree = () => join(checkout(), ".claude", "worktrees", "wt");
  const projects = () => join(root, "home", ".claude", "projects");
  const transcript = (cwds) => {
    const path = join(projects(), slug(worktree()), "s.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, cwds.map((cwd) => JSON.stringify({ type: "user", cwd })).join("\n") + "\n");
    return path;
  };

  it("lists this checkout's folder and its worktrees' folders, nothing else", () => {
    for (const dir of [checkout(), worktree(), `${checkout()}-other`, join(root, "elsewhere")]) {
      mkdirSync(join(projects(), slug(dir)), { recursive: true });
    }
    expect(transcriptDirs(checkout(), join(root, "home")).sort()).toEqual(
      [join(projects(), slug(checkout())), join(projects(), slug(worktree()))].sort(),
    );
    expect(transcriptDirs(checkout(), join(root, "no-home"))).toEqual([]);
  });

  it("resolves a transcript to the worktree its first turn ran in, even a removed one", () => {
    expect(transcriptRoot(transcript([undefined, join(worktree(), "src"), checkout()]), checkout())).toBe(worktree());
  });

  it("keeps this checkout for a session that started here, or names no directory", () => {
    expect(transcriptRoot(transcript([checkout(), worktree()]), checkout())).toBe(checkout());
    expect(transcriptRoot(transcript([undefined]), checkout())).toBe(checkout());
  });
});

describe("parseWorktrees", () => {
  it("reads branches, a detached HEAD, and marks the first entry as the main checkout", () => {
    const porcelain = [
      "worktree /repo\nHEAD aaa\nbranch refs/heads/feat/MYAPP-APP-427",
      "worktree /repo/.claude/worktrees/a\nHEAD bbb\nbranch refs/heads/claude/a-1",
      "worktree /repo/.claude/worktrees/b\nHEAD ccc\ndetached",
      "",
    ].join("\n\n");
    expect(parseWorktrees(porcelain)).toEqual([
      { path: "/repo", head: "aaa", branch: "feat/MYAPP-APP-427", main: true, bare: false },
      { path: "/repo/.claude/worktrees/a", head: "bbb", branch: "claude/a-1", main: false, bare: false },
      { path: "/repo/.claude/worktrees/b", head: "ccc", branch: null, main: false, bare: false },
    ]);
  });

  it("tolerates CRLF and blank-line padding, and marks a bare repository's entry", () => {
    const porcelain = "worktree /srv/bare\r\nbare\r\n\r\nworktree /srv/a\r\nHEAD ddd\r\nbranch refs/heads/x\r\n \r\n";
    expect(parseWorktrees(porcelain)).toEqual([
      { path: "/srv/bare", head: null, branch: null, main: true, bare: true },
      { path: "/srv/a", head: "ddd", branch: "x", main: false, bare: false },
    ]);
  });

  it("returns nothing for no output", () => {
    expect(parseWorktrees("")).toEqual([]);
  });
});
