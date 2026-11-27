import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "./session/vitest-compat.mjs";
import { fileURLToPath } from "node:url";
import { codegraphStatusLine, formatRunLogLine, resolveSessionDir, staleBaseLine } from "../plugins/session/scripts/worktree-setup-hook.mjs";

describe("resolveSessionDir", () => {
  it("prefers the session cwd from the hook input over the env and this file's repo", () => {
    expect(resolveSessionDir({ cwd: "/repo/.claude/worktrees/x" }, { CLAUDE_PROJECT_DIR: "/repo" }, "/repo")).toEqual({
      dir: "/repo/.claude/worktrees/x",
      via: "input-cwd",
    });
  });

  it("falls back to CLAUDE_PROJECT_DIR, then to this file's repo", () => {
    expect(resolveSessionDir({}, { CLAUDE_PROJECT_DIR: "/repo/.claude/worktrees/y" }, "/repo")).toEqual({
      dir: "/repo/.claude/worktrees/y",
      via: "project-dir",
    });
    expect(resolveSessionDir({ cwd: "" }, {}, "/repo")).toEqual({ dir: "/repo", via: "script" });
  });
});

describe("formatRunLogLine", () => {
  it("writes one tab-separated line with every field", () => {
    const line = formatRunLogLine({
      at: "2026-10-10T14:00:00.000Z",
      outcome: "ran",
      steps: ["install", "codegraph"],
      sessionId: "abc",
      source: "startup",
      top: "/repo/.claude/worktrees/x",
      via: "input-cwd",
      codegraphOnPath: true,
    });
    expect(line).toBe(
      "2026-10-10T14:00:00.000Z\tran\tinstall,codegraph\tabc\tstartup\t/repo/.claude/worktrees/x\tvia:input-cwd\tcodegraph:yes\n",
    );
  });

  it("marks missing values instead of leaving empty columns", () => {
    const line = formatRunLogLine({ at: "t", outcome: "main-checkout", steps: [], top: "/repo" });
    expect(line).toBe("t\tmain-checkout\t-\t-\t-\t/repo\tvia:?\tcodegraph:?\n");
  });
});

describe("codegraphStatusLine", () => {
  const wt = "/repo/.claude/worktrees/x";
  const read = (facts) => ({
    top: wt,
    facts: { hasCodegraph: true, codegraphOnPath: true, ...facts },
  });
  const status =
    "\nCodeGraph Status\n\nProject: /repo/.claude/worktrees/x\n\nIndex Statistics:\n  Files:     1,104\n  Nodes:     19,541\n";

  it("names the project and file count from codegraph status in a set-up worktree", () => {
    expect(codegraphStatusLine(read({}), status)).toBe("codegraph: /repo/.claude/worktrees/x, 1,104 files indexed");
  });

  it("falls back to the worktree top without a count when the status text does not parse", () => {
    expect(codegraphStatusLine(read({}), "something else")).toBe(`codegraph: ${wt}`);
    expect(codegraphStatusLine(read({}), null)).toBe(`codegraph: ${wt}`);
  });

  it("says why there is no index: none built, or no binary on PATH", () => {
    expect(codegraphStatusLine(read({ hasCodegraph: false }), null)).toBe("codegraph: no index here");
    expect(codegraphStatusLine(read({ codegraphOnPath: false }), null)).toBe("codegraph: not installed");
    expect(codegraphStatusLine(read({ hasCodegraph: false, codegraphOnPath: false }), null)).toBe(
      "codegraph: not installed",
    );
  });
});

describe("staleBaseLine", () => {
  it("warns only for a worktree with no commits of its own that its base moved past", () => {
    expect(staleBaseLine("dev", 0, 3)).toContain("starts 3 commit(s) behind dev; run `worktree-flow adopt dev`");
    expect(staleBaseLine("dev", 0, 0)).toBeNull();
    expect(staleBaseLine("dev", 2, 3)).toBeNull();
    expect(staleBaseLine("dev", null, 3)).toBeNull();
  });
});

const HOOK = fileURLToPath(new URL("../plugins/session/scripts/worktree-setup-hook.mjs", import.meta.url));

describe("worktree-setup-hook.mjs as a process", () => {
  it("prints nothing for a main checkout (a repository that is not a linked worktree)", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktree-setup-hook-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      const result = spawnSync(process.execPath, [HOOK], {
        encoding: "utf8",
        input: JSON.stringify({ cwd: dir }),
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs in a linked worktree, and does nothing at all once kit.json lists worktree-setup in hooks.off", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-setup-hook-")));
    const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
    try {
      const main = join(dir, "main");
      const wt = join(dir, "wt");
      git(dir, "init", "-q", "-b", "dev", main);
      git(main, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "a");
      git(main, "worktree", "add", "-q", "-b", "claude/wt", wt);
      const log = join(main, ".git", "worktree-setup-hook.log");
      const run = () => spawnSync(process.execPath, [HOOK], { encoding: "utf8", input: JSON.stringify({ cwd: wt }) });

      expect(run().status).toBe(0);
      expect(existsSync(log)).toBe(true);
      rmSync(log);

      expect(run().stdout).not.toContain("behind");
      git(main, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "b");
      expect(run().stdout).toContain("this worktree starts 1 commit(s) behind dev; run `worktree-flow adopt dev`");
      rmSync(log);

      // A linked worktree writes the common dir's info/attributes, the main checkout's .git (#56).
      writeFileSync(join(wt, "kit.json"), JSON.stringify({ project: "t" }));
      expect(run().status).toBe(0);
      expect(readFileSync(join(main, ".git", "info", "attributes"), "utf8")).toMatch(/^docs\/sdlc\/backlog\.md merge=text$/m);
      rmSync(log);

      writeFileSync(join(wt, "kit.json"), JSON.stringify({ project: "t", hooks: { off: ["worktree-setup"] } }));
      const off = run();
      expect(off.status).toBe(0);
      expect(off.stdout).toBe("");
      expect(existsSync(log)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes the clone merge the backlog as text, so a branch still carrying merge=union conflicts (#56, C7)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-setup-hook-")));
    const git = (...args) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd: dir, encoding: "utf8" });
    const table = (...rows) => `| Source | What |\n| --- | --- |\n${rows.map((s) => `| ${s} | w |\n`).join("")}`;
    try {
      git("init", "-q", "-b", "dev");
      const run = () => spawnSync(process.execPath, [HOOK], { encoding: "utf8", input: JSON.stringify({ cwd: dir }) });
      const attributes = join(dir, ".git", "info", "attributes");
      expect(run().status).toBe(0);
      expect(existsSync(attributes) && readFileSync(attributes, "utf8").includes("backlog.md")).toBe(false);

      writeFileSync(join(dir, "kit.json"), JSON.stringify({ project: "t", paths: { sdlc: "work" } }));
      expect(run().stdout).toBe("");
      run();
      expect(readFileSync(attributes, "utf8").match(/^work\/backlog\.md merge=text$/gm)).toHaveLength(1);

      mkdirSync(join(dir, "work"));
      writeFileSync(join(dir, ".gitattributes"), "work/backlog.md merge=union\n");
      writeFileSync(join(dir, "work", "backlog.md"), table("a 1", "a 2"));
      git("add", ".");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "older");
      writeFileSync(join(dir, "work", "backlog.md"), table("a 1", "a 2", "b 1"));
      git("commit", "-q", "-am", "append");
      git("checkout", "-q", "dev");
      writeFileSync(join(dir, "work", "backlog.md"), table());
      git("rm", "-q", ".gitattributes");
      git("commit", "-q", "-am", "pick, drop union");
      git("checkout", "-q", "older");
      expect(git("merge", "--no-edit", "dev").status).not.toBe(0);
      expect(git("diff", "--name-only", "--diff-filter=U").stdout.trim()).toBe("work/backlog.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
