import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "./session/vitest-compat.mjs";
import {
  PR_CACHE_NAME,
  branchSessions,
  closeReason,
  gitCloseFacts,
  itemRefs,
  lastActive,
  parseMergeSubjects,
  splitItems,
} from "../plugins/session/scripts/ledger-autoclose.mjs";
import { doneMarks, markDone } from "../plugins/session/scripts/ledger-record.mjs";

const SCRIPTS = fileURLToPath(new URL("../plugins/session/scripts/", import.meta.url));
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-11T12:00:00Z");
const OPTIONS = { now: NOW, questionDays: 7 };
/** Facts that close nothing: the pure rules alone. */
const NO_FACTS = { prMerged: () => false, branchLanded: () => null, branchPushed: () => null };
const record = (day, lastAt = Date.parse(`${day}T00:00:00Z`) + DAY) => ({ day, lastAt });

describe("itemRefs", () => {
  it("reads the PR forms, a question and an until date", () => {
    const refs = itemRefs(
      "Open question at Stop: merge PR #12, pull request 13, acme/tools#14 and https://github.com/acme/app/pull/15? (until 2026-12-01)",
    );
    expect(refs.question).toBe(true);
    expect(refs.until).toBe("2026-12-01");
    expect(refs.prs).toEqual([
      { repo: "acme/app", n: 15 },
      { repo: "acme/tools", n: 14 },
      { repo: null, n: 12 },
      { repo: null, n: 13 },
    ]);
  });

  it("does not read an item number or a bare #n as a PR", () => {
    expect(itemRefs("see aaaa1111 #3 and issue #4").prs).toEqual([]);
  });

  it("collects backticked words and bare words with a slash as possible branches", () => {
    const refs = itemRefs("Land `claude/fix-a` on feat/APP-1-b, then `/close-out`.");
    expect(refs.branches).toEqual(["claude/fix-a", "/close-out", "feat/APP-1-b"]);
    expect(refs.landing).toBe(true);
  });

  it("leaves out a branch named in a condition", () => {
    const refs = itemRefs("`docs/a.md` — turn the box solid when `claude/x` lands; merge `claude/y` first.");
    expect(refs.branches).not.toContain("claude/x");
    expect(refs.branches).toContain("claude/y");
    expect(itemRefs("delete the entry once the item (`claude/z`) lands").branches).not.toContain("claude/z");
  });

  it("sees whether the item is about landing or pushing at all", () => {
    expect(itemRefs("`src/a.ts` — confirm the guard").landing).toBe(false);
    expect(itemRefs("`git push` of `feat/x` — not done").push).toBe(true);
  });
});

describe("closeReason: question", () => {
  const q = "Open question at Stop: Land it now?";

  it("expires an Open question at Stop once the record was idle for questionDays", () => {
    expect(closeReason(q, record("2026-11-01"), NO_FACTS, OPTIONS)).toBe("open question older than 7 days");
    expect(closeReason(q, record("2026-11-08"), NO_FACTS, OPTIONS)).toBeNull();
  });

  it("counts from the record's last file edit when that is later than its day", () => {
    const active = record("2026-11-01", Date.parse("2026-11-09T10:00:00Z"));
    expect(closeReason(q, active, NO_FACTS, OPTIONS)).toBeNull();
    expect(lastActive("2026-11-01", ["2026-11-09T10:00:00Z", null, "garbage"])).toBe(Date.parse("2026-11-09T10:00:00Z"));
    expect(lastActive("2026-11-01", [])).toBe(Date.parse("2026-11-02T00:00:00Z"));
  });

  it("takes questionDays from the options", () => {
    expect(closeReason(q, record("2026-11-08"), NO_FACTS, { ...OPTIONS, questionDays: 2 })).toBe(
      "open question older than 2 days",
    );
  });

  it("leaves a question that does not open the item alone", () => {
    expect(closeReason("Ask: Open question at Stop: x?", record("2026-01-01"), NO_FACTS, OPTIONS)).toBeNull();
  });
});

describe("closeReason: until", () => {
  it("closes the day after the date, not on it", () => {
    expect(closeReason("watch the dashboard (until 2026-11-10)", record("2026-11-01"), NO_FACTS, OPTIONS)).toBe(
      "until 2026-11-10 passed",
    );
    expect(closeReason("watch the dashboard (until 2026-11-11)", record("2026-11-01"), NO_FACTS, OPTIONS)).toBeNull();
  });
});

describe("closeReason: PR and branch facts", () => {
  it("names the merged PR", () => {
    const facts = { ...NO_FACTS, prMerged: (ref) => ref.n === 7 };
    expect(closeReason("wait for PR #6, then PR #7", record("2026-11-01"), facts, OPTIONS)).toBe("PR #7 merged");
    expect(closeReason("acme/app#7 review", record("2026-11-01"), facts, OPTIONS)).toBe("PR acme/app#7 merged");
  });

  it("closes a landing item by its landed branch, and passes the record's day", () => {
    const days = [];
    const facts = {
      ...NO_FACTS,
      branchLanded: (name, day) => (days.push(day), name === "claude/x" ? { branch: name, into: "main" } : null),
    };
    expect(closeReason("`/close-out` — land `claude/x`", record("2026-11-01"), facts, OPTIONS)).toBe(
      "branch claude/x landed in main",
    );
    expect(days).toContain("2026-11-01");
    expect(closeReason("`claude/x` — read the notes", record("2026-11-01"), facts, OPTIONS)).toBeNull();
  });

  it("asks the push fact only for an item that says push", () => {
    const facts = { ...NO_FACTS, branchPushed: (name) => ({ branch: name, to: `origin/${name}` }) };
    expect(closeReason("`git push` of `feat/x` — not done", record("2026-11-01"), facts, OPTIONS)).toBe(
      "branch feat/x pushed to origin/feat/x",
    );
    expect(closeReason("land `feat/x`", record("2026-11-01"), facts, OPTIONS)).toBeNull();
  });

  it("splits a record's items, skipping done ones", () => {
    const items = [
      { n: 1, text: "Open question at Stop: x?", done: false },
      { n: 2, text: "(done 2026-11-02 abcd1234) y", done: true },
      { n: 3, text: "fix `src/a.ts`", done: false },
    ];
    const { open, closed } = splitItems(items, record("2026-10-01"), NO_FACTS, OPTIONS);
    expect(open.map((i) => i.n)).toEqual([3]);
    expect(closed.map(({ item, reason }) => [item.n, reason])).toEqual([[1, "open question older than 7 days"]]);
  });
});

describe("parseMergeSubjects and branchSessions", () => {
  it("reads PR merges, branch merges and squash merges", () => {
    const log = [
      "2026-11-02T10:00:00Z\tMerge pull request #12 from acme/claude/fix-a",
      "2026-11-03T10:00:00Z\tMerge branch 'feat/b' into main",
      "2026-11-04T10:00:00Z\tMerge remote-tracking branch 'origin/feat/c'",
      "2026-11-05T10:00:00Z\tfeat: add d (#13)",
      "2026-11-06T10:00:00Z\tplain commit",
    ].join("\n");
    const { branches, prs } = parseMergeSubjects(log);
    expect([...branches.keys()]).toEqual(["claude/fix-a", "feat/b", "feat/c"]);
    expect([...prs.keys()]).toEqual([12, 13]);
  });

  it("maps a branch to the sessions whose records name it", () => {
    const map = branchSessions([
      { branch: "claude/a", id: "s1" },
      { branch: "claude/a", id: "s2" },
      { branch: "unknown", id: "s3" },
      { branch: null, id: "s4" },
    ]);
    expect([...map]).toEqual([["claude/a", ["s1", "s2"]]]);
  });
});

describe("the --sweep mark", () => {
  it("is a done mark with a reason that doneMarks still reads as the signer's", () => {
    const before = "# x\n\n## Next\n\n1. land `claude/x`\n";
    const after = markDone(before, 1, "2026-11-11 abcd1234 auto: branch claude/x landed in main");
    expect(after).toContain("1. (done 2026-11-11 abcd1234 auto: branch claude/x landed in main) land `claude/x`");
    expect(doneMarks(before, after)).toEqual(["abcd1234"]);
  });
});

// The git side runs against a throwaway repository with commit dates set by hand.
describe("gitCloseFacts", () => {
  let repo;
  const env = (date) => ({
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const git = (args, date = "2026-11-01T10:00:00Z") => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: env(date) });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (file, date, message = `edit ${file}`) => {
    writeFileSync(join(repo, file), `${file} ${date}\n`);
    git(["add", file], date);
    git(["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", message], date);
  };

  beforeEach(() => {
    repo = join(realpathSync(mkdtempSync(join(tmpdir(), "ledger-autoclose-"))), "repo");
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"]);
    commit("base.md", "2026-10-01T10:00:00Z");
  });

  afterEach(() => {
    rmSync(join(repo, ".."), { recursive: true, force: true });
  });

  it("closes a session branch that landed after the record's day began", () => {
    git(["checkout", "-q", "-b", "claude/x"]);
    commit("x.md", "2026-11-05T10:00:00Z");
    const facts = () => gitCloseFacts(repo, "main");
    expect(facts().branchLanded("claude/x", "2026-11-05")).toBeNull();
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--ff-only", "claude/x"], "2026-11-05T12:00:00Z");
    expect(facts().branchLanded("claude/x", "2026-11-05")).toEqual({ branch: "claude/x", into: "main" });
    // An item written after the branch had landed is not about landing it.
    expect(facts().branchLanded("claude/x", "2026-11-06")).toBeNull();
  });

  it("counts any integration branch for a session branch, the base only for others", () => {
    git(["branch", "feat/big"]);
    git(["checkout", "-q", "-b", "claude/y"]);
    commit("y.md", "2026-11-05T10:00:00Z");
    git(["checkout", "-q", "feat/big"]);
    git(["merge", "-q", "--ff-only", "claude/y"]);
    expect(gitCloseFacts(repo, "main").branchLanded("claude/y", "2026-11-05")).toEqual({
      branch: "claude/y",
      into: "feat/big",
    });
    expect(gitCloseFacts(repo, "main").branchLanded("feat/big", "2026-11-05")).toBeNull();
  });

  it("names the branch the work landed in first, not one cut from it later", () => {
    git(["branch", "feat/big"]);
    git(["checkout", "-q", "-b", "claude/w"]);
    commit("w.md", "2026-11-05T10:00:00Z", "feat: w\n\nSession-Id: sess-w");
    git(["checkout", "-q", "feat/big"]);
    git(["merge", "-q", "--ff-only", "claude/w"], "2026-11-05T12:00:00Z");
    // Sorts before feat/big, holds the same commits, and was created a day after the landing.
    git(["branch", "chore/later", "feat/big"], "2026-11-06T09:00:00Z");
    expect(gitCloseFacts(repo, "main").branchLanded("claude/w", "2026-11-05")?.into).toBe("feat/big");
    git(["branch", "-q", "-D", "claude/w"]);
    const sessionsByBranch = new Map([["claude/w", ["sess-w"]]]);
    expect(gitCloseFacts(repo, "main", { sessionsByBranch }).branchLanded("claude/w", "2026-11-05")?.into).toBe(
      "feat/big",
    );
  });

  it("does not close a branch cut from the base with no commits of its own", () => {
    git(["branch", "claude/empty"]);
    expect(gitCloseFacts(repo, "main").branchLanded("claude/empty", "2026-11-05")).toBeNull();
  });

  it("uses the base worktree-flow recorded for the branch", () => {
    git(["branch", "feat/other"]);
    git(["checkout", "-q", "-b", "claude/z"]);
    commit("z.md", "2026-11-05T10:00:00Z");
    git(["config", "branch.claude/z.kitBase", "feat/other"]);
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--ff-only", "claude/z"]);
    // Landed in main, but its recorded base is feat/other.
    expect(gitCloseFacts(repo, "main").branchLanded("claude/z", "2026-11-05")).toBeNull();
  });

  it("proves a deleted branch landed through its sessions' Session-Id commits", () => {
    git(["checkout", "-q", "-b", "claude/gone"]);
    commit("g.md", "2026-11-05T10:00:00Z", "feat: g\n\nSession-Id: sess-1");
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--ff-only", "claude/gone"]);
    git(["branch", "-q", "-d", "claude/gone"]);
    const sessionsByBranch = new Map([["claude/gone", ["sess-1"]]]);
    expect(gitCloseFacts(repo, "main", { sessionsByBranch }).branchLanded("claude/gone", "2026-11-05")).toEqual({
      branch: "claude/gone",
      into: "main",
    });
    expect(gitCloseFacts(repo, "main").branchLanded("claude/gone", "2026-11-05")).toBeNull();
  });

  it("finds a deleted branch in a merge subject on the base", () => {
    git(["checkout", "-q", "-b", "feat/m"]);
    commit("m.md", "2026-11-05T10:00:00Z");
    git(["checkout", "-q", "main"]);
    git(["-c", "user.email=t@example.com", "-c", "user.name=T", "merge", "-q", "--no-ff", "-m", "Merge branch 'feat/m'", "feat/m"], "2026-11-05T12:00:00Z");
    git(["branch", "-q", "-D", "feat/m"]);
    expect(gitCloseFacts(repo, "main").branchLanded("feat/m", "2026-11-05")?.branch).toBe("feat/m");
    expect(gitCloseFacts(repo, "main").branchLanded("feat/m", "2026-11-06")).toBeNull();
  });

  it("sees a push once the remote-tracking ref holds the branch as it stood that day", () => {
    git(["checkout", "-q", "-b", "feat/p"]);
    commit("p.md", "2026-11-05T10:00:00Z");
    expect(gitCloseFacts(repo, "main").branchPushed("feat/p", "2026-11-05")).toBeNull();
    git(["update-ref", "refs/remotes/origin/feat/p", "feat/p"]);
    expect(gitCloseFacts(repo, "main").branchPushed("origin/feat/p", "2026-11-05")).toEqual({
      branch: "feat/p",
      to: "origin/feat/p",
    });
  });

  it("reads a merged PR from the base's merge subjects, without gh", () => {
    git(["checkout", "-q", "-b", "claude/pr"]);
    commit("pr.md", "2026-11-05T10:00:00Z");
    git(["checkout", "-q", "main"]);
    git(["-c", "user.email=t@example.com", "-c", "user.name=T", "merge", "-q", "--no-ff", "-m", "Merge pull request #12 from acme/claude/pr", "claude/pr"], "2026-11-05T12:00:00Z");
    const facts = gitCloseFacts(repo, "main", { network: true, gh: join(repo, "no-such-gh") });
    expect(facts.prMerged({ repo: null, n: 12 }, "2026-11-05")).toBe(true);
    expect(facts.prMerged({ repo: null, n: 12 }, "2026-11-06")).toBe(false);
    expect(facts.prMerged({ repo: null, n: 99 }, "2026-11-05")).toBe(false);
  });

  it("asks gh only with network on, caches a merged answer, and survives a missing gh", () => {
    const calls = join(repo, "..", "gh-calls");
    const gh = join(repo, "..", "gh");
    writeFileSync(
      gh,
      `#!/bin/sh\necho "$@" >> "${calls}"\necho '{"state":"MERGED","mergedAt":"2026-11-07T09:00:00Z"}'\n`,
    );
    chmodSync(gh, 0o755);
    const ref = { repo: "acme/app", n: 5 };
    expect(gitCloseFacts(repo, "main", { network: false, gh }).prMerged(ref, "2026-11-05")).toBe(false);
    expect(existsSync(calls)).toBe(false);

    const online = gitCloseFacts(repo, "main", { network: true, gh });
    expect(online.prMerged(ref, "2026-11-05")).toBe(true);
    online.save();
    expect(readFileSync(calls, "utf8")).toContain("pr view 5 --json state,mergedAt --repo acme/app");
    const cached = JSON.parse(readFileSync(join(repo, ".git", PR_CACHE_NAME), "utf8"));
    expect(cached["acme/app#5"].state).toBe("MERGED");

    // The brief's view: no network, the cached answer still counts.
    expect(gitCloseFacts(repo, "main", { network: false, gh }).prMerged(ref, "2026-11-05")).toBe(true);
    expect(gitCloseFacts(repo, "main", { network: true, gh: join(repo, "no-such-gh") }).prMerged({ repo: null, n: 6 }, "2026-11-05")).toBe(false);
  });
});

describe("session-ledger --owed, --sweep and the brief", () => {
  let repo;
  let home;
  const today = new Date().toISOString().slice(0, 10);
  const run = (script, args = [], input) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, LEDGER_GH: join(home, "no-such-gh") };
    delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: repo, encoding: "utf8", env, input });
  };
  const ledger = () => join(repo, ".claude", "ledger");
  const writeRecord = (name, next) =>
    writeFileSync(
      join(ledger(), name),
      `---\nid: ${name.slice(11, 19)}-0000\ndate: ${name.slice(0, 10)}\nbranch: main\nflags: []\n---\n\n# x\n\n## Intent\n\nx\n\n## Next\n\n${next}\n`,
    );

  beforeEach(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ledger-sweep-")));
    repo = join(root, "repo");
    home = join(root, "home");
    mkdirSync(repo);
    mkdirSync(home);
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "kit.json"), JSON.stringify({ project: "t", ledger: true, ledgerAutoClose: { questionDays: 3 } }));
    mkdirSync(ledger(), { recursive: true });
    writeRecord("2026-01-02-aaaa0001.md", "_(from the session's last recap)_\n1. Open question at Stop: Push now?");
    writeRecord(`${today}-bbbb0002.md`, "1. Open question at Stop: Merge it?\n2. watch the logs (until 2026-01-05)\n3. `src/a.ts` — fix the guard");
  });

  afterEach(() => {
    rmSync(join(repo, ".."), { recursive: true, force: true });
  });

  it("--owed lists open items first, then the auto-closed ones with their reason", () => {
    const lines = run("session-ledger.mjs", ["--owed"]).stdout.split("\n");
    expect(lines).toContain(`${today} bbbb0002  1. Open question at Stop: Merge it?`);
    expect(lines).toContain(`${today} bbbb0002  3. \`src/a.ts\` — fix the guard`);
    const header = lines.indexOf("Auto-closed (hidden from the brief; `session-ledger --sweep` marks them done):");
    expect(header).toBeGreaterThan(0);
    expect(lines.slice(header)).toContain(`${today} bbbb0002  2. watch the logs (until 2026-01-05) — until 2026-01-05 passed`);
    expect(lines.slice(header)).toContain("2026-01-02 aaaa0001  1. Open question at Stop: Push now? — open question older than 3 days");
  });

  it("the brief hides the auto-closed items and counts them in one line", () => {
    const out = run("ledger-brief.mjs", [], JSON.stringify({ cwd: repo })).stdout;
    expect(out).toContain("bbbb0002 #3");
    expect(out).not.toContain("bbbb0002 #2");
    expect(out).not.toContain("aaaa0001 #1");
    expect(out).toMatch(/^2 Next items auto-closed .* --sweep marks them done$/m);
  });

  it("--sweep --dry-run says what it would mark and changes nothing", () => {
    const before = readFileSync(join(ledger(), "2026-01-02-aaaa0001.md"), "utf8");
    const out = run("session-ledger.mjs", ["--sweep", "--dry-run"]).stdout;
    expect(out).toContain("would mark 2 auto-closed item(s) done in 2 record(s)");
    expect(readFileSync(join(ledger(), "2026-01-02-aaaa0001.md"), "utf8")).toBe(before);
  });

  it("--sweep writes each done mark with its reason, deleting nothing", () => {
    const out = run("session-ledger.mjs", ["--sweep", "--as", "cccc0003"]).stdout;
    expect(out).toContain("marked 2 auto-closed item(s) done in 2 record(s)");
    const swept = readFileSync(join(ledger(), `${today}-bbbb0002.md`), "utf8");
    expect(swept).toContain(`2. (done ${today} cccc0003 auto: until 2026-01-05 passed) watch the logs (until 2026-01-05)`);
    expect(swept).toContain("1. Open question at Stop: Merge it?");
    expect(swept).toContain("3. `src/a.ts` — fix the guard");
    expect(readFileSync(join(ledger(), "2026-01-02-aaaa0001.md"), "utf8")).toContain(
      `1. (done ${today} cccc0003 auto: open question older than 3 days) Open question at Stop: Push now?`,
    );
    // A second sweep finds nothing left, and --owed has no auto-closed section.
    expect(run("session-ledger.mjs", ["--sweep", "--as", "cccc0003"]).stdout).toContain("marked 0 auto-closed item(s)");
    expect(run("session-ledger.mjs", ["--owed"]).stdout).not.toContain("Auto-closed");
  });

  it("signs a sweep run outside a session as sweep", () => {
    run("session-ledger.mjs", ["--sweep"]);
    expect(readFileSync(join(ledger(), "2026-01-02-aaaa0001.md"), "utf8")).toContain(`(done ${today} sweep auto: `);
  });
});
