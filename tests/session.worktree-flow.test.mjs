import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "./session/vitest-compat.mjs";
import {
  adoptPlan,
  guessBase,
  integrationHolders,
  matchBranch,
  mergedCleanWorktrees,
  parseMergeTree,
  parseStatusZ,
  splitCommandArgs,
  verdictFor,
} from "../plugins/session/scripts/worktree-flow.mjs";

const SCRIPTS = fileURLToPath(new URL("../plugins/session/scripts/", import.meta.url));

const SCRIPT = join(SCRIPTS, "worktree-flow.mjs");

describe("matchBranch", () => {
  const branches = [
    "main",
    "feat/MYAPP-role-sync-APP-427",
    "claude/app-427-workflow-4cee79",
    "fix/MYAPP-APP-4270",
    "claude/app-472-x",
  ];

  it("prefers an exact name", () => {
    expect(matchBranch("main", branches)).toEqual({ branch: "main" });
  });

  it("matches a ticket as a whole segment and prefers integration branches over session ones", () => {
    expect(matchBranch("APP-427", branches)).toEqual({ branch: "feat/MYAPP-role-sync-APP-427" });
    expect(matchBranch("app-427", branches)).toEqual({ branch: "feat/MYAPP-role-sync-APP-427" });
  });

  it("falls back to a session branch when no integration branch carries the ticket", () => {
    expect(matchBranch("APP-472", branches)).toEqual({ branch: "claude/app-472-x" });
  });

  it("returns every candidate when the ticket is ambiguous, and none for a non-ticket miss", () => {
    expect(matchBranch("APP-1", ["feat/a-APP-1", "fix/b-APP-1"])).toEqual({
      candidates: ["feat/a-APP-1", "fix/b-APP-1"],
    });
    expect(matchBranch("nope", branches)).toEqual({ candidates: [] });
  });
});

describe("guessBase", () => {
  it("picks the candidate holding most of the branch", () => {
    expect(
      guessBase([
        { name: "main", ahead: 12, behind: 0 },
        { name: "feat/APP-427", ahead: 2, behind: 5 },
      ]),
    ).toBe("feat/APP-427");
  });

  it("picks main for a fresh worktree cut from main, which is zero ahead of both", () => {
    expect(
      guessBase([
        { name: "feat/APP-427", ahead: 0, behind: 330 },
        { name: "main", ahead: 0, behind: 0 },
      ]),
    ).toBe("main");
  });

  it("lets kit.json baseBranch win a tie, and only a tie", () => {
    const tied = [
      { name: "main", ahead: 0, behind: 0 },
      { name: "develop", ahead: 0, behind: 0 },
    ];
    expect(guessBase(tied, "develop")).toBe("develop");
    expect(guessBase(tied, "main")).toBe("main");
    expect(guessBase([{ name: "develop", ahead: 3, behind: 0 }, { name: "main", ahead: 1, behind: 0 }], "develop")).toBe(
      "main",
    );
  });

  it("returns null with no candidates", () => {
    expect(guessBase([])).toBeNull();
  });
});

describe("verdictFor", () => {
  const merged = {
    main: false,
    self: false,
    branch: "claude/x",
    base: "feat/APP-427",
    dirty: 0,
    dirtyLedger: 0,
    ahead: 0,
    unpushed: null,
    baseUnpushed: 0,
  };

  it("never offers the main checkout, this session or a dirty worktree for removal", () => {
    expect(verdictFor({ ...merged, main: true }).removable).toBe(false);
    expect(verdictFor({ ...merged, self: true }).removable).toBe(false);
    expect(verdictFor({ ...merged, dirty: 2 })).toEqual({ removable: false, verdict: "2 uncommitted file(s) — keep" });
  });

  it("keeps a worktree with commits its base lacks", () => {
    expect(verdictFor({ ...merged, ahead: 3, unpushed: 1 })).toEqual({
      removable: false,
      verdict: "3 commit(s) not in feat/APP-427 (1 unpushed) — land or keep",
    });
  });

  it("offers a merged worktree, naming an unpushed base and an uncommitted ledger record", () => {
    expect(verdictFor(merged)).toEqual({ removable: true, verdict: "merged into feat/APP-427" });
    expect(verdictFor({ ...merged, baseUnpushed: 4, dirtyLedger: 1 }).verdict).toBe(
      "merged into feat/APP-427 (push feat/APP-427: 4 ahead); 1 ledger record(s) uncommitted, lost on removal",
    );
  });

  it("offers a worktree whose work landed on another integration branch than its recorded base", () => {
    expect(verdictFor({ ...merged, base: "main", ahead: 249, landedIn: "feat/APP-427" })).toEqual({
      removable: true,
      verdict: "merged into feat/APP-427, not its base main",
    });
    expect(verdictFor({ ...merged, base: null, ahead: null, landedIn: "feat/APP-427" }).removable).toBe(true);
    expect(verdictFor({ ...merged, dirty: 1, landedIn: "feat/APP-427" }).removable).toBe(false);
  });

  it("leaves a detached, merged worktree to the app's reuse pool", () => {
    expect(verdictFor({ ...merged, branch: null, base: "feat/APP-427", ahead: 0 })).toEqual({
      removable: false,
      verdict: "idle in the app's reuse pool (detached, merged) — the app reuses or reaps it",
    });
    expect(verdictFor({ ...merged, branch: null, base: null, ahead: null, landedIn: "feat/APP-427" }).removable).toBe(
      false,
    );
  });
});

describe("integrationHolders", () => {
  it("keeps only integration branches, never the worktree's own or another session's branch", () => {
    expect(integrationHolders(["claude/x", "claude/y", "feat/MYAPP-APP-427", "main", ""], "claude/x")).toEqual([
      "feat/MYAPP-APP-427",
      "main",
    ]);
  });
});

describe("parseMergeTree", () => {
  it("reads the conflicted paths between the tree line and the messages", () => {
    expect(
      parseMergeTree("abc123\nCHANGELOG.md\nsrc/a.ts\nCHANGELOG.md\n\nAuto-merging CHANGELOG.md\nCONFLICT (content)"),
    ).toEqual(["CHANGELOG.md", "src/a.ts"]);
  });
});

describe("parseStatusZ", () => {
  it("keeps the leading space of a worktree-only change and skips a rename's source", () => {
    expect(parseStatusZ(" M a.txt\0R  new.txt\0old.txt\0?? .codegraph/.gitignore\0")).toEqual([
      { code: " M", path: "a.txt" },
      { code: "R ", path: "new.txt" },
      { code: "??", path: ".codegraph/.gitignore" },
    ]);
  });
});

describe("adoptPlan", () => {
  it("drops an untracked copy identical to the target's and carries what the target lacks", () => {
    expect(
      adoptPlan([
        { code: "??", path: ".codegraph/.gitignore", target: "same" },
        { code: "??", path: ".codegraph/codegraph.db", target: "absent" },
        { code: "??", path: ".claude/ledger/INDEX.md", target: "absent" },
      ]),
    ).toEqual({ drop: [".codegraph/.gitignore"], blockers: [] });
  });

  it("blocks a tracked edit and an untracked file the target holds differently, never a ledger record", () => {
    expect(
      adoptPlan([
        { code: " M", path: "src/a.ts", target: null },
        { code: "??", path: "notes.md", target: "differs" },
        { code: " M", path: ".claude/ledger/2026-11-04-abc.md", target: null },
      ]),
    ).toEqual({ drop: [], blockers: ["src/a.ts", "notes.md"] });
  });
});

describe("splitCommandArgs", () => {
  it("splits a command's arguments from the flags it takes", () => {
    const split = splitCommandArgs("remove", ["../w1", "--drop-ledger"]);
    expect(split.args).toEqual(["../w1"]);
    expect([...split.flags]).toEqual(["--drop-ledger"]);
    expect(split.error).toBe("");
  });

  it("refuses a flag the command does not take, so a typo never runs the real thing", () => {
    expect(splitCommandArgs("land", ["--dryrun"]).error).toBe(
      'land does not take "--dryrun" (it takes --dry-run, --report); --help prints the usage',
    );
    expect(splitCommandArgs("adopt", ["dev", "--json"]).error).toBe(
      'adopt does not take "--json"; --help prints the usage',
    );
    expect(splitCommandArgs("resolve", ["-x"]).error).toContain('"-x"');
  });
});

describe("worktree-flow --help", () => {
  let dir;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-flow-help-")));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Outside any repository: a git call would fail, so exit 0 shows help came first.
  it("prints the usage and exits 0 for --help or -h, alone or after a command", () => {
    for (const args of [["--help"], ["-h"], ["land", "--help"], ["adopt", "-h"]]) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("worktree-flow land [--dry-run]");
      expect(result.stderr).toBe("");
    }
  });
});

describe("worktree-flow in a real repository", () => {
  let root;
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const flow = (cwd, ...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  const commit = (cwd, file, text) => {
    writeFileSync(join(cwd, file), text);
    git(cwd, "add", file);
    git(cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", `edit ${file}`);
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-flow-")));
    const main = join(root, "main");
    spawnSync("git", ["init", "-q", "-b", "main", main]);
    git(main, "config", "user.email", "t@example.com");
    git(main, "config", "user.name", "t");
    commit(main, "a.txt", "one\n");
    git(main, "branch", "feat/MYAPP-APP-9");
    git(main, "checkout", "-q", "feat/MYAPP-APP-9");
    commit(main, "b.txt", "integration\n");
    git(main, "checkout", "-q", "main");
    git(main, "worktree", "add", "-q", "-b", "claude/w1", join(root, "w1"), "main");
    git(main, "worktree", "add", "-q", "-b", "claude/w2", join(root, "w2"), "feat/MYAPP-APP-9");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("adopts a fresh worktree onto the ticket's branch and records it as the base", () => {
    const w1 = join(root, "w1");
    expect(flow(w1, "adopt", "APP-9").status).toBe(0);
    expect(git(w1, "rev-parse", "HEAD").stdout).toBe(git(w1, "rev-parse", "feat/MYAPP-APP-9").stdout);
    expect(flow(w1, "base").stdout.trim()).toBe("feat/MYAPP-APP-9 (recorded)");
  });

  it("adopts again as a no-op, so a brief can always open with adopt", () => {
    const w1 = join(root, "w1");
    const before = git(w1, "rev-parse", "HEAD").stdout;
    expect(flow(w1, "adopt", "APP-9").status).toBe(0);
    expect(git(w1, "rev-parse", "HEAD").stdout).toBe(before);
  });

  it("predicts a conflict between two worktrees that edit the same line", () => {
    const w1 = join(root, "w1");
    const w2 = join(root, "w2");
    commit(w1, "b.txt", "from w1\n");
    commit(w2, "b.txt", "from w2\n");
    const report = flow(w1, "conflicts");
    expect(report.stdout).toContain("✗ claude/w1 × claude/w2 (worktree): b.txt");
    expect(report.stdout).toContain("✓ claude/w1 × feat/MYAPP-APP-9 (base)");
  });

  it("refuses to adopt once the worktree has commits of its own", () => {
    expect(flow(join(root, "w1"), "adopt", "main").stderr).toContain("commit(s) not in main");
  });

  it("refuses a mistyped land flag instead of landing, while w1 has a commit to land", () => {
    const w1 = join(root, "w1");
    const before = git(join(root, "main"), "rev-parse", "feat/MYAPP-APP-9").stdout;
    const result = flow(w1, "land", "--dryrun");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('land does not take "--dryrun"');
    expect(git(join(root, "main"), "rev-parse", "feat/MYAPP-APP-9").stdout).toBe(before);
  });

  it("only reports with --report, even without --dry-run, while w1 has a commit to land", () => {
    const w1 = join(root, "w1");
    const before = git(join(root, "main"), "rev-parse", "feat/MYAPP-APP-9").stdout;
    const result = flow(w1, "land", "--report");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would fast-forward feat/MYAPP-APP-9 by 1 commit(s)");
    expect(git(join(root, "main"), "rev-parse", "feat/MYAPP-APP-9").stdout).toBe(before);
  });

  it("lands by fast-forward only, moving the branch checked out in the main checkout", () => {
    const main = join(root, "main");
    git(main, "checkout", "-q", "feat/MYAPP-APP-9");
    const w1 = join(root, "w1");
    const landed = flow(w1, "land");
    expect(landed.stdout).toContain("landed 1 commit(s) on feat/MYAPP-APP-9");
    expect(git(main, "rev-parse", "HEAD").stdout).toBe(git(w1, "rev-parse", "HEAD").stdout);
    expect(git(main, "status", "--porcelain").stdout).toBe("");
  });

  it("counts a landed, clean worktree as removable for the brief, and not one with unlanded commits", () => {
    const listed = mergedCleanWorktrees(join(root, "main")).map((tree) => tree.branch);
    expect(listed).toContain("claude/w1");
    expect(listed).not.toContain("claude/w2");
  });

  it("refuses to land while the base has commits the branch lacks", () => {
    const w2 = join(root, "w2");
    git(w2, "config", "branch.claude/w2.kitBase", "feat/MYAPP-APP-9");
    expect(flow(w2, "land").stderr).toContain("merge it in here first");
    const dryRun = flow(w2, "land", "--dry-run");
    expect(dryRun.status).toBe(1);
    expect(dryRun.stderr).toContain("merge it in here first");
  });

  // /close-out preloads this, and Claude Code refuses to load a command whose preload exits non-zero.
  it("reports the base being ahead and exits 0 under --dry-run --report", () => {
    const report = flow(join(root, "w2"), "land", "--dry-run", "--report");
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("cannot land yet: feat/MYAPP-APP-9 has commits this branch lacks");
    expect(report.stderr).toBe("");
  });

  it("reports uncommitted files and exits 0 under --report, where a plain dry run refuses", () => {
    const w2 = join(root, "w2");
    writeFileSync(join(w2, "b.txt"), "uncommitted\n");
    expect(flow(w2, "land", "--dry-run").status).toBe(1);
    const report = flow(w2, "land", "--dry-run", "--report");
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("cannot land yet: commit everything first");
    git(w2, "checkout", "--", "b.txt");
  });

  it("removes a merged worktree and its branch, and refuses an unmerged one", () => {
    const main = join(root, "main");
    expect(flow(main, "remove", join(root, "w2")).stderr).toContain("refusing to remove");
    expect(flow(main, "remove", join(root, "w1")).stdout).toContain("and branch claude/w1");
    expect(git(main, "branch", "--list", "claude/w1").stdout).toBe("");
  });
});

describe("adopt in a worktree cut from main", () => {
  // A proposal card's worktree is cut from `main`, and the SessionStart hooks have already
  // written `.codegraph/` and the ledger INDEX into it.
  let root;
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const adoptFromStdin = (cwd, ref) => spawnSync(process.execPath, [SCRIPT, "adopt", ref], { cwd, encoding: "utf8" });
  const hookFiles = (cwd, gitignore) => {
    mkdirSync(join(cwd, ".codegraph"), { recursive: true });
    mkdirSync(join(cwd, ".claude", "ledger"), { recursive: true });
    writeFileSync(join(cwd, ".codegraph", ".gitignore"), gitignore);
    writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "index");
    writeFileSync(join(cwd, ".claude", "ledger", "INDEX.md"), "# brief\n");
  };
  const GITIGNORE = "*\n!.gitignore\n";

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-flow-adopt-")));
    const main = join(root, "main");
    spawnSync("git", ["init", "-q", "-b", "main", main]);
    git(main, "config", "user.email", "t@example.com");
    git(main, "config", "user.name", "t");
    writeFileSync(join(main, "a.txt"), "one\n");
    git(main, "add", "a.txt");
    git(main, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "a");
    git(main, "checkout", "-q", "-b", "dev");
    mkdirSync(join(main, ".codegraph"));
    writeFileSync(join(main, ".codegraph", ".gitignore"), GITIGNORE);
    git(main, "add", ".codegraph/.gitignore");
    git(main, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "codegraph");
    git(main, "checkout", "-q", "main");
    for (const name of ["ok", "differs", "edited"]) {
      git(main, "worktree", "add", "-q", "-b", `claude/${name}`, join(root, name), "main");
    }
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("moves onto dev past the hook's files, keeping the ones dev does not track", () => {
    const ok = join(root, "ok");
    hookFiles(ok, GITIGNORE);
    const run = adoptFromStdin(ok, "dev");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(git(ok, "rev-parse", "HEAD").stdout).toBe(git(ok, "rev-parse", "dev").stdout);
    expect(git(ok, "config", "--get", "branch.claude/ok.kitBase").stdout.trim()).toBe("dev");
    expect(existsSync(join(ok, ".codegraph", "codegraph.db"))).toBe(true);
    expect(existsSync(join(ok, ".claude", "ledger", "INDEX.md"))).toBe(true);
    expect(git(ok, "status", "--porcelain", "--", ".codegraph").stdout).toBe("");
  });

  it("refuses when an untracked file differs from the target's copy, and leaves it in place", () => {
    const differs = join(root, "differs");
    hookFiles(differs, "local\n");
    const run = adoptFromStdin(differs, "dev");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(".codegraph/.gitignore");
    expect(readFileSync(join(differs, ".codegraph", ".gitignore"), "utf8")).toBe("local\n");
  });

  it("refuses a tracked edit", () => {
    const edited = join(root, "edited");
    writeFileSync(join(edited, "a.txt"), "changed\n");
    const run = adoptFromStdin(edited, "dev");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("a.txt");
  });

  it("refuses the main checkout", () => {
    expect(adoptFromStdin(join(root, "main"), "dev").stderr).toContain("never the main checkout");
  });

  it("steps past a ledger kept where kit.json says, not only the default folder", () => {
    const edited = join(root, "edited");
    git(edited, "checkout", "--", "a.txt");
    writeFileSync(join(edited, "kit.json"), JSON.stringify({ project: "t", paths: { ledger: "notes/ledger" } }));
    git(edited, "add", "kit.json");
    git(edited, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "kit");
    git(edited, "branch", "-f", "dev-kit", "HEAD");
    git(edited, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(edited, "kit.json"), JSON.stringify({ project: "t", paths: { ledger: "notes/ledger" } }));
    mkdirSync(join(edited, "notes", "ledger"), { recursive: true });
    writeFileSync(join(edited, "notes", "ledger", "INDEX.md"), "# brief\n");
    const run = adoptFromStdin(edited, "dev-kit");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(existsSync(join(edited, "notes", "ledger", "INDEX.md"))).toBe(true);
  });
});
