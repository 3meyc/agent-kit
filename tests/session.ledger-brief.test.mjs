import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "./session/vitest-compat.mjs";
import {
  countUnverified,
  openNextItems,
  owedCountLine,
  removableLine,
  unmergedRecordNames,
  withComputedFacts,
  worktreeRoots,
} from "../plugins/session/scripts/ledger-brief.mjs";

const BRIEF = fileURLToPath(new URL("../plugins/session/scripts/ledger-brief.mjs", import.meta.url));
/** A `kit.json` that turns the ledger on, as every project using it has. */
const KIT_ON = JSON.stringify({ project: "t", ledger: true });

describe("owedCountLine", () => {
  it("stays silent at zero", () => {
    expect(owedCountLine(0, 0)).toBe("");
  });

  it("names the counts and the command that lists them", () => {
    expect(owedCountLine(3, 2)).toBe(
      "3 open Next items in 2 older records — session-ledger --owed",
    );
    expect(owedCountLine(1, 1)).toBe(
      "1 open Next item in 1 older record — session-ledger --owed",
    );
  });
});

describe("openNextItems", () => {
  it("leaves out items a later session marked done, and a None. section", () => {
    expect(openNextItems("1. (done 2026-10-23 abcd1234) a\n2. b").map((i) => i.n)).toEqual([2]);
    expect(openNextItems("None.")).toEqual([]);
  });
});

describe("countUnverified", () => {
  it("does not count an unverified item that was since marked done", () => {
    expect(countUnverified("1. (done 2026-10-23 abcd1234) (unverified) a\n2. (unverified) b")).toBe(1);
  });

  it("counts bullet and numbered items that open with the marker", () => {
    const body = [
      "- (unverified) The CI cache survives a rebase.",
      "- Checked: the test passes.",
      "1. (unverified) `/sdlc-plan x` — the API returns ISO dates.",
      "  * (Unverified) nested item",
    ].join("\n");
    expect(countUnverified(body)).toBe(3);
  });

  it("ignores the marker anywhere but the start of an item", () => {
    expect(countUnverified("- Ran the check (unverified on macOS).\nplain (unverified) prose")).toBe(0);
  });

  it("returns 0 for an empty section", () => {
    expect(countUnverified("")).toBe(0);
  });
});

describe("withComputedFacts", () => {
  const facts = {
    lastCommitSec: () => null,
    dirty: new Set(["a.ts"]),
    commitsBySession: new Map([["settled-id", ["abc1234"]]]),
  };
  const base = { id: "settled-id", flags: ["process-change"], commits: false, editedAt: new Map() };

  it("adds uncommitted and trailer commits to a settled record when read", () => {
    const r = withComputedFacts({ ...base, editedAt: new Map([["a.ts", "2026-09-27T10:00:00Z"]]) }, facts);
    expect(r.flags).toEqual(["process-change", "uncommitted"]);
    expect(r.commits).toBe(true);
  });

  it("leaves an older record's stored flags as they are", () => {
    const r = withComputedFacts({ ...base, id: "legacy", flags: ["uncommitted"] }, facts);
    expect(r.flags).toEqual(["uncommitted"]);
    expect(r.commits).toBe(false);
  });
});

describe("worktreeRoots", () => {
  const porcelain = [
    "worktree /repo",
    "HEAD 1111111",
    "branch refs/heads/main",
    "",
    "worktree /repo/.claude/worktrees/a",
    "HEAD 2222222",
    "branch refs/heads/chore/a",
    "",
    "worktree /tmp/detached",
    "HEAD 3333333",
    "detached",
    "",
    "worktree /srv/bare",
    "bare",
    "",
  ].join("\n");

  it("lists the other worktrees with their branch, skipping itself and bare ones", () => {
    expect(worktreeRoots(porcelain, "/repo")).toEqual([
      { path: "/repo/.claude/worktrees/a", branch: "chore/a" },
      { path: "/tmp/detached", branch: "detached" },
    ]);
  });

  it("returns nothing for a single checkout or no output", () => {
    expect(worktreeRoots("worktree /repo\nHEAD 1\nbranch refs/heads/main\n", "/repo")).toEqual([]);
    expect(worktreeRoots("", "/repo")).toEqual([]);
  });
});

describe("unmergedRecordNames", () => {
  it("leaves out another worktree's records older than the cut-off day", () => {
    // An abandoned worktree, or one on the integration branch, would feed old sessions forever.
    const names = ["2026-08-01-eeeeeeee.md", "2026-09-27-ffffffff.md"];
    expect(unmergedRecordNames(names, new Set(), "2026-09-13")).toEqual(["2026-09-27-ffffffff.md"]);
  });

  it("keeps another worktree's records this checkout does not have yet, newest first", () => {
    const own = new Set(["2026-09-26-aaaaaaaa.md", "2026-09-27-bbbbbbbb.md"]);
    const theirs = [
      "2026-09-26-aaaaaaaa.md",
      "2026-09-27-cccccccc.md",
      "INDEX.md",
      "notes.txt",
      "2026-09-27-dddddddd.md",
    ];
    expect(unmergedRecordNames(theirs, own)).toEqual(["2026-09-27-dddddddd.md", "2026-09-27-cccccccc.md"]);
  });
});

describe("removableLine", () => {
  it("stays silent with nothing to remove", () => {
    expect(removableLine(0)).toBe("");
  });

  it("names the count and the command that lists them", () => {
    expect(removableLine(1)).toBe(
      "1 other worktree is merged and clean — safe to remove: worktree-flow status (✓ rows).",
    );
    expect(removableLine(7)).toContain("7 other worktrees are merged and clean");
  });
});

describe("ledger-brief.mjs as a process", () => {
  const record = (id8, date, title, next) =>
    `---\nid: ${id8}-1111-2222-3333-444444444444\ndate: ${date}\ntitle: "${title}"\nflags: []\n---\n\n# ${date} · ${id8}\n\n## Intent\n\nx\n\n## Decisions\n\ny\n\n## Next\n\n${next}\n\n## Files (0)\n`;

  it("reads the ledger of the checkout the session's cwd is in, a worktree's for a worktree session", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ledger-brief-"));
    const main = join(realpathSync(tmp), "main");
    const wt = join(main, ".claude", "worktrees", "x");
    try {
      for (const dir of [main, wt]) {
        mkdirSync(join(dir, "src"), { recursive: true });
        spawnSync("git", ["init", "-q"], { cwd: dir });
        writeFileSync(join(dir, "kit.json"), KIT_ON);
        mkdirSync(join(dir, ".claude", "ledger"), { recursive: true });
      }
      writeFileSync(
        join(main, ".claude", "ledger", "2026-10-20-aaaaaaaa.md"),
        record("aaaaaaaa", "2026-10-20", "Main record", "None."),
      );
      writeFileSync(
        join(wt, ".claude", "ledger", "2026-10-21-bbbbbbbb.md"),
        record("bbbbbbbb", "2026-10-21", "Worktree record", "None."),
      );
      const result = spawnSync(process.execPath, [BRIEF], {
        cwd: main,
        encoding: "utf8",
        input: JSON.stringify({ cwd: join(wt, "src") }),
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("- 2026-10-21 Worktree record");
      expect(result.stdout).not.toContain("Main record");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ranks and counts live records only, never reading an archived record", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ledger-brief-"));
    const repo = join(realpathSync(tmp), "repo");
    try {
      mkdirSync(repo, { recursive: true });
      spawnSync("git", ["init", "-q"], { cwd: repo });
      writeFileSync(join(repo, "kit.json"), KIT_ON);
      const ledger = join(repo, ".claude", "ledger");
      mkdirSync(join(ledger, "archive"), { recursive: true });
      writeFileSync(join(ledger, "2026-10-20-aaaaaaaa.md"), record("aaaaaaaa", "2026-10-20", "Live session", "None."));
      writeFileSync(
        join(ledger, "archive", "2026-06-01-cccccccc.md"),
        record("cccccccc", "2026-06-01", "Archived session", "1. still open"),
      );
      const result = spawnSync(process.execPath, [BRIEF], {
        cwd: repo,
        encoding: "utf8",
        input: JSON.stringify({ cwd: repo }),
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("- 2026-10-20 Live session");
      expect(result.stdout).not.toContain("Archived session");
      expect(result.stdout).not.toContain("open Next item");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("ledger-brief.mjs and kit.json", () => {
  const record = `---\nid: aaaaaaaa-1\ndate: 2026-10-20\ntitle: "A session"\nflags: []\n---\n\n## Next\n\nNone.\n`;
  const run = (kit) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "ledger-brief-kit-")));
    try {
      spawnSync("git", ["init", "-q"], { cwd: repo });
      if (kit) writeFileSync(join(repo, "kit.json"), JSON.stringify(kit));
      const dir = join(repo, ...(kit?.paths?.ledger ?? ".claude/ledger").split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2026-10-20-aaaaaaaa.md"), record);
      return spawnSync(process.execPath, [BRIEF], { cwd: repo, encoding: "utf8", input: JSON.stringify({ cwd: repo }) });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };

  it("prints nothing without kit.json, with the ledger off, or with ledger-brief in hooks.off", () => {
    for (const kit of [null, { project: "t" }, { project: "t", ledger: true, hooks: { off: ["ledger-brief"] } }]) {
      const result = run(kit);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("reads the ledger folder kit.json names", () => {
    const result = run({ project: "t", ledger: true, paths: { ledger: "notes/sessions" } });
    expect(result.stdout).toContain("Recent sessions in this repo (from notes/sessions/");
    expect(result.stdout).toContain("- 2026-10-20 A session");
  });
});

describe("ledger-brief.mjs brief sections (characterization)", () => {
  const record = (
    id8,
    date,
    title,
    { next = "None.", decisions = "None.", files = [] , flags = "[]", commits = "[]" } = {},
  ) =>
    `---\nid: ${id8}-1111-2222-3333-444444444444\ndate: ${date}\ntitle: "${title}"\nflags: ${flags}\ncommits: ${commits}\n---\n\n# ${date} · ${id8}\n\n## Intent\n\nx\n\n## Decisions\n\n${decisions}\n\n## Next\n\n${next}\n\n## Files (${files.length})\n\n${files.map((f) => `- ${f}`).join("\n")}\n`;
  const git = (cwd, ...args) =>
    spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
    });
  const setUp = (tmp) => {
    const repo = join(realpathSync(tmp), "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "kit.json"), KIT_ON);
    writeFileSync(join(repo, ".gitignore"), ".claude/\n");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    mkdirSync(join(repo, ".claude", "ledger"), { recursive: true });
    return repo;
  };
  const brief = (repo) =>
    spawnSync(process.execPath, [BRIEF], {
      cwd: repo,
      encoding: "utf8",
      input: JSON.stringify({ cwd: repo }),
    });
  const long = `${"a long instruction ".repeat(8)}end`;

  it("ranks, lists owed items, counts older and unverified ones, and names shared files and other worktrees", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ledger-brief-"));
    try {
      const repo = setUp(tmp);
      const ledger = join(repo, ".claude", "ledger");
      const write = (name, text) => writeFileSync(join(ledger, name), text);
      write("2026-10-25-a1a1a1a1.md", record("a1a1a1a1", "2026-10-25", "Newest quiet"));
      write(
        "2026-10-24-a2a2a2a2.md",
        record("a2a2a2a2", "2026-10-24", "Second newest", {
          next: `1. (unverified) check the thing\n2. (done 2026-10-25 a1a1a1a1) finished\n3. ${long}\n4. fourth item`,
          files: ["src/shared.ts", "src/a.ts"],
          flags: "[process-change]",
        }),
      );
      write("2026-10-23-a3a3a3a3.md", record("a3a3a3a3", "2026-10-23", "Low signal"));
      write(
        "2026-10-22-a4a4a4a4.md",
        record("a4a4a4a4", "2026-10-22", "Decided something", { decisions: "Chose X.", files: ["src/shared.ts"] }),
      );
      write(
        "2026-10-21-a5a5a5a5.md",
        record("a5a5a5a5", "2026-10-21", "Owes work", {
          next: "1. one\n2. two\n3. three",
          files: ["src/shared.ts", "src/b.ts"],
        }),
      );
      write(
        "2026-10-20-a6a6a6a6.md",
        record("a6a6a6a6", "2026-10-20", "Touched files", { files: ["src/b.ts"], commits: "[abc1234]" }),
      );
      write("2026-10-19-a7a7a7a7.md", record("a7a7a7a7", "2026-10-19", "Older owed", { next: "1. seven\n2. eight" }));
      write("2026-10-18-a8a8a8a8.md", record("a8a8a8a8", "2026-10-18", "Owes too", { next: "1. nine" }));
      const wt = join(realpathSync(tmp), "wt");
      git(repo, "worktree", "add", "-q", wt, "-b", "feat-x");
      mkdirSync(join(wt, ".claude", "ledger"), { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(
        join(wt, ".claude", "ledger", `${today}-b1b1b1b1.md`),
        record("b1b1b1b1", "2026-10-26", "Neighbour work", { files: ["src/b.ts"] }),
      );

      const result = brief(repo);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatchInlineSnapshot(`
        "Recent sessions in this repo (from .claude/ledger/, by what they left behind):

        - 2026-10-25 Newest quiet
        - 2026-10-24 Second newest [process-change]
        - 2026-10-22 Decided something
        - 2026-10-21 Owes work
        - 2026-10-19 Older owed

        In other worktrees, not merged here:
        - 2026-10-26 Neighbour work @feat-x

        1 other worktree is merged and clean — safe to remove: worktree-flow status (✓ rows).

        Left owed by those sessions:
          1. (unverified) check the thing
          3. a long instruction a long instruction a long instruction a long instruction a long instruction a long instruction a l…
          4. fourth item
          1. one
          2. two
          3. three
          … more in the records below

        1 open Next item in 1 older record — session-ledger --owed

        1 item(s) marked (unverified) — confirm before relying on them.

        Touched by more than one of the last 6 sessions and other worktrees — check before editing:
          src/shared.ts (3)
          src/b.ts (3)

        Open the record under .claude/ledger/ before reopening any topic above.
        "
      `);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("names merged clean worktrees and scopes shared files to the recent sessions alone", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ledger-brief-"));
    try {
      const repo = setUp(tmp);
      const ledger = join(repo, ".claude", "ledger");
      writeFileSync(
        join(ledger, "2026-10-25-c1c1c1c1.md"),
        record("c1c1c1c1", "2026-10-25", "One", { files: ["src/x.ts"] }),
      );
      writeFileSync(
        join(ledger, "2026-10-24-c2c2c2c2.md"),
        record("c2c2c2c2", "2026-10-24", "Two", { files: ["src/x.ts"] }),
      );
      git(repo, "worktree", "add", "-q", join(realpathSync(tmp), "done"), "-b", "landed");

      const result = brief(repo);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatchInlineSnapshot(`
        "Recent sessions in this repo (from .claude/ledger/, by what they left behind):

        - 2026-10-25 One
        - 2026-10-24 Two

        1 other worktree is merged and clean — safe to remove: worktree-flow status (✓ rows).

        Touched by more than one of the last 6 sessions — check before editing:
          src/x.ts (2)

        Open the record under .claude/ledger/ before reopening any topic above.
        "
      `);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
