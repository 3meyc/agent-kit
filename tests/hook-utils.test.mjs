import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  appendHookLog,
  isDirectRun,
  isInCheckout,
  isProcessPath,
  linkedWorktreeScript,
  parseWorktrees,
  repoRelativePath,
  transcriptDirs,
  transcriptRoot,
} from "../shared/hook-utils.mjs";

const root = "/work/my-app";

test("repoRelativePath keeps paths inside the root only", () => {
  assert.equal(repoRelativePath("src/a.ts", root, root), "src/a.ts");
  assert.equal(repoRelativePath("/work/my-app/docs/x.md", "/", root), "docs/x.md");
  assert.equal(repoRelativePath("/work/other/x.md", "/", root), null);
  assert.equal(repoRelativePath("..", root, root), null);
  assert.equal(repoRelativePath("", root, root), null);
});

test("parseWorktrees reads main, linked and detached entries", () => {
  const porcelain = [
    "worktree /work/my-app\nHEAD aaa\nbranch refs/heads/main",
    "worktree /work/my-app/.claude/worktrees/w1\nHEAD bbb\nbranch refs/heads/feature/x",
    "worktree /work/my-app/.claude/worktrees/w2\nHEAD ccc\ndetached",
    "",
  ].join("\n\n");
  const trees = parseWorktrees(porcelain);
  assert.equal(trees.length, 3);
  assert.deepEqual(trees[0], { path: "/work/my-app", head: "aaa", branch: "main", main: true, bare: false });
  assert.equal(trees[1].branch, "feature/x");
  assert.equal(trees[2].branch, null);
});

test("isInCheckout excludes linked worktrees", () => {
  assert.equal(isInCheckout("/work/my-app/src", root), true);
  assert.equal(isInCheckout("/work/my-app/.claude/worktrees/w1", root), false);
  assert.equal(isInCheckout("/work/elsewhere", root), false);
});

test("linkedWorktreeScript finds a worktree's own copy", () => {
  const exists = (path) => path === "/work/my-app/.claude/worktrees/w1/scripts/hook.mjs";
  assert.deepEqual(linkedWorktreeScript("/work/my-app/.claude/worktrees/w1/src", "scripts/hook.mjs", root, exists), {
    dir: "/work/my-app/.claude/worktrees/w1",
    script: "/work/my-app/.claude/worktrees/w1/scripts/hook.mjs",
  });
  assert.equal(linkedWorktreeScript("/work/my-app/.claude/worktrees/w2", "scripts/hook.mjs", root, exists), null);
  assert.equal(linkedWorktreeScript("/work/my-app/src", "scripts/hook.mjs", root, exists), null);
});

test("isProcessPath matches defaults, directories and extras", () => {
  assert.equal(isProcessPath("CLAUDE.md"), true);
  assert.equal(isProcessPath(".claude/skills/x/SKILL.md"), true);
  assert.equal(isProcessPath("kit.json"), true);
  assert.equal(isProcessPath("src/app.ts"), false);
  assert.equal(isProcessPath("tools/release.mjs", ["tools"]), true);
  // Passed straight to .some(), the index lands in `extra`; it must be ignored, not spread.
  assert.equal(["src/a.ts", "CLAUDE.md"].some(isProcessPath), true);
  assert.equal(["src/a.ts", "src/b.ts"].some(isProcessPath), false);
});

// Ported from the source projects' suites for these helpers.
describe("with a scratch git repository", () => {
  let scratch;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "hook-utils-"));
    spawnSync("git", ["init", "-q"], { cwd: scratch });
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  test("appendHookLog appends one line to the named log in the git common dir", () => {
    assert.equal(appendHookLog("probe.log", "a\tb", scratch), true);
    assert.equal(appendHookLog("probe.log", "c", scratch), true);
    assert.equal(readFileSync(join(scratch, ".git", "probe.log"), "utf8"), "a\tb\nc\n");
  });

  test("appendHookLog reports false outside a git repository instead of throwing", () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    try {
      assert.equal(appendHookLog("probe.log", "x", plain), false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("isDirectRun recognises the entry file through a symlinked path, and not an imported module", () => {
    const real = join(scratch, "real");
    mkdirSync(real);
    const hookUtils = new URL("../shared/hook-utils.mjs", import.meta.url);
    writeFileSync(
      join(real, "hook.mjs"),
      `import { isDirectRun } from ${JSON.stringify(hookUtils.href)};\nconsole.log(isDirectRun(import.meta.url));\n`,
    );
    symlinkSync(real, join(scratch, "link"));
    const viaLink = spawnSync(process.execPath, [join(scratch, "link", "hook.mjs")], { encoding: "utf8" });
    assert.equal(viaLink.stdout.trim(), "true");
    // An imported module is not the entry: hook-utils.mjs itself, asked from this test process.
    assert.equal(isDirectRun(hookUtils.href), false);
  });

  describe("transcriptDirs and transcriptRoot", () => {
    const slug = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");
    const checkout = () => join(scratch, "repo");
    const worktree = () => join(checkout(), ".claude", "worktrees", "wt");
    const projects = () => join(scratch, "home", ".claude", "projects");
    const transcript = (cwds) => {
      const path = join(projects(), slug(worktree()), "s.jsonl");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, cwds.map((cwd) => JSON.stringify({ type: "user", cwd })).join("\n") + "\n");
      return path;
    };

    test("lists this checkout's folder and its worktrees' folders, nothing else", () => {
      for (const dir of [checkout(), worktree(), `${checkout()}-other`, join(scratch, "elsewhere")]) {
        mkdirSync(join(projects(), slug(dir)), { recursive: true });
      }
      assert.deepEqual(
        transcriptDirs(checkout(), join(scratch, "home")).sort(),
        [join(projects(), slug(checkout())), join(projects(), slug(worktree()))].sort(),
      );
      assert.deepEqual(transcriptDirs(checkout(), join(scratch, "no-home")), []);
    });

    test("resolves a transcript to the worktree its first turn ran in, even a removed one", () => {
      assert.equal(transcriptRoot(transcript([undefined, join(worktree(), "src"), checkout()]), checkout()), worktree());
    });

    test("keeps this checkout for a session that started here, or names no directory", () => {
      assert.equal(transcriptRoot(transcript([checkout(), worktree()]), checkout()), checkout());
      assert.equal(transcriptRoot(transcript([undefined]), checkout()), checkout());
    });
  });
});

describe("parseWorktrees edge cases", () => {
  test("tolerates CRLF and blank-line padding, and marks a bare repository's entry", () => {
    const porcelain = "worktree /srv/bare\r\nbare\r\n\r\nworktree /srv/a\r\nHEAD ddd\r\nbranch refs/heads/x\r\n \r\n";
    assert.deepEqual(parseWorktrees(porcelain), [
      { path: "/srv/bare", head: null, branch: null, main: true, bare: true },
      { path: "/srv/a", head: "ddd", branch: "x", main: false, bare: false },
    ]);
  });

  test("returns nothing for no output", () => {
    assert.deepEqual(parseWorktrees(""), []);
  });
});
