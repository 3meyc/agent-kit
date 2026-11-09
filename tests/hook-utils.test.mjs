import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isInCheckout,
  isProcessPath,
  linkedWorktreeScript,
  parseWorktrees,
  repoRelativePath,
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
});
