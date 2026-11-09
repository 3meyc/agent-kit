import { describe, expect, it } from "./session/vitest-compat.mjs";
import {
  claimStillOpen,
  collectClaims,
  formatShared,
  landedElsewhere,
  openPaths,
  parseCommitLog,
  sharedPaths,
} from "../plugins/session/scripts/ledger-claims.mjs";

const other = { id: "aaaaaaaa-1111", label: "import converter", paths: ["CHANGELOG.md", "src/a.ts"] };

describe("sharedPaths", () => {
  it("reports a dirty path another session also claims", () => {
    const dirty = new Set(["CHANGELOG.md", "src/mine.ts"]);
    expect(sharedPaths(["CHANGELOG.md", "src/mine.ts"], [other], dirty)).toEqual([
      { path: "CHANGELOG.md", sessions: [{ id: "aaaaaaaa-1111", label: "import converter" }] },
    ]);
  });

  it("ignores a claim on a path that is clean again", () => {
    expect(sharedPaths(["src/a.ts"], [other], new Set())).toEqual([]);
  });

  it("ignores paths nobody else claims", () => {
    expect(sharedPaths(["src/mine.ts"], [other], new Set(["src/mine.ts"]))).toEqual([]);
  });

  it("skips a path the user allowed", () => {
    expect(sharedPaths(["src/a.ts"], [other], new Set(["src/a.ts"]), new Set(["src/a.ts"]))).toEqual([]);
  });

  it("lists each session once and each path once", () => {
    const again = { id: "aaaaaaaa-1111", paths: ["src/a.ts"] };
    const third = { id: "bbbbbbbb-2222", paths: ["src/a.ts"] };
    const result = sharedPaths(["src/a.ts", "src/a.ts"], [other, again, third], new Set(["src/a.ts"]));
    expect(result).toHaveLength(1);
    expect(result[0].sessions.map((s) => s.id)).toEqual(["aaaaaaaa-1111", "bbbbbbbb-2222"]);
  });
});

describe("formatShared", () => {
  it("names the path and each session by id prefix and label", () => {
    const lines = formatShared([
      { path: "CHANGELOG.md", sessions: [{ id: "aaaaaaaa-1111", label: "import converter" }, { id: "bbbbbbbb-2222" }] },
    ]);
    expect(lines).toEqual(["CHANGELOG.md\talso claimed by aaaaaaaa (import converter), bbbbbbbb"]);
  });
});

describe("claimStillOpen", () => {
  const editedAt = Date.parse("2026-09-27T10:00:00.800Z");
  const sec = (iso) => Date.parse(iso) / 1000;

  it("keeps a claim git never committed", () => {
    expect(claimStillOpen(editedAt, null)).toBe(true);
  });

  it("keeps a claim whose path was last committed before the edit", () => {
    expect(claimStillOpen(editedAt, sec("2026-09-27T09:59:59Z"))).toBe(true);
  });

  it("drops a claim once a commit touched the path after the edit, same second included", () => {
    expect(claimStillOpen(editedAt, sec("2026-09-27T10:00:00Z"))).toBe(false);
    expect(claimStillOpen(editedAt, sec("2026-09-27T11:00:00Z"))).toBe(false);
  });
});

describe("collectClaims", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  const hour = 3_600_000;
  const base = {
    own: ["a.ts", "b.ts"],
    ownPrefixes: ["mine"],
    now,
    transcripts: [],
    records: [],
    lastCommitSec: () => null,
  };
  const live = (id, paths, ageHours = 1) => ({
    id,
    mtimeMs: now - ageHours * hour,
    editedAt: () => new Map(Object.entries(paths)),
  });
  const record = (
    id,
    extra = {},
  ) => ({
    id,
    label: `record ${id}`,
    day: "2026-09-26",
    mtimeMs: now - 20 * hour,
    flags: ["uncommitted"],
    pending: ["a.ts"],
    ...extra,
  });

  it("takes a live session's open claims on the commit's own paths only", () => {
    const claims = collectClaims({
      ...base,
      transcripts: [live("other", { "a.ts": "2026-09-27T11:00:00Z", "c.ts": "2026-09-27T11:00:00Z" })],
      records: [record("other", { flags: [] })],
    });
    expect(claims).toEqual([{ id: "other", label: "record other", paths: ["a.ts"] }]);
  });

  it("skips its own session, by any of its id prefixes", () => {
    const claims = collectClaims({
      ...base,
      ownPrefixes: ["old", "mine"],
      transcripts: [live("old-id", { "a.ts": "2026-09-27T11:00:00Z" })],
    });
    expect(claims).toEqual([]);
  });

  it("drops a claim on a path committed after the session's edit", () => {
    const claims = collectClaims({
      ...base,
      transcripts: [live("other", { "a.ts": "2026-09-27T11:00:00Z" })],
      lastCommitSec: () => Date.parse("2026-09-27T11:30:00Z") / 1000,
    });
    expect(claims).toEqual([]);
  });

  it("lets a live transcript that claims nothing override its lagging record", () => {
    const claims = collectClaims({ ...base, transcripts: [live("other", {})], records: [record("other")] });
    expect(claims).toEqual([]);
  });

  it("reads a transcript only inside the live window, then falls back to the record", () => {
    let parsed = false;
    const stale = { id: "other", mtimeMs: now - 49 * hour, editedAt: () => ((parsed = true), new Map()) };
    const claims = collectClaims({ ...base, transcripts: [stale], records: [record("other")] });
    expect(parsed).toBe(false);
    expect(claims).toEqual([{ id: "other", label: "record other", paths: ["a.ts"] }]);
  });

  it("counts a record only while it is flagged uncommitted, recent, and not committed past", () => {
    const committedLater = () => (now - 10 * hour) / 1000;
    expect(collectClaims({ ...base, records: [record("r", { flags: [] })] })).toEqual([]);
    expect(collectClaims({ ...base, records: [record("r", { day: "2026-09-10" })] })).toEqual([]);
    expect(collectClaims({ ...base, records: [record("r")], lastCommitSec: committedLater })).toEqual([]);
  });
});

describe("parseCommitLog", () => {
  // `git log --format=%x00%h %ct%x09%(trailers:key=Session-Id,valueonly,separator=%x2C) --name-only`
  const log = [
    "\u0000bbbbbbb 1790500200\tnew-id,old-id\n\nscripts/a.mjs\ndocs/b.md\n",
    "\u0000aaaaaaa 1790500100\t\n\nscripts/a.mjs\n",
  ].join("");

  it("keeps each path's newest commit time and each session's commits", () => {
    const facts = parseCommitLog(log);
    expect(facts.lastCommit).toEqual(
      new Map([
        ["scripts/a.mjs", 1790500200],
        ["docs/b.md", 1790500200],
      ]),
    );
    expect(facts.commitsBySession).toEqual(
      new Map([
        ["new-id", ["bbbbbbb"]],
        ["old-id", ["bbbbbbb"]],
      ]),
    );
  });

  it("keeps the newest time when commits from machines with skewed clocks are out of order", () => {
    const skewed = "\u0000ccccccc 1790500000\t\n\na.ts\n\u0000ddddddd 1790509999\t\n\na.ts\n";
    expect(parseCommitLog(skewed).lastCommit.get("a.ts")).toBe(1790509999);
  });

  it("reads an empty log as no commits", () => {
    expect(parseCommitLog("").lastCommit.size).toBe(0);
  });
});

describe("openPaths", () => {
  const files = [
    { path: "a.ts", at: "2026-09-27T10:00:00Z" },
    { path: "b.ts", at: "2026-09-27T10:00:00Z" },
    { path: "c.ts", at: "2026-09-27T10:00:00Z" },
  ];
  const commitSec = (iso) => Date.parse(iso) / 1000;

  it("keeps dirty paths no commit touched since their edit", () => {
    const lastCommit = new Map([
      ["a.ts", commitSec("2026-09-27T09:00:00Z")],
      ["b.ts", commitSec("2026-09-27T11:00:00Z")],
    ]);
    expect(openPaths(files, (p) => lastCommit.get(p) ?? null, new Set(["a.ts", "b.ts"]))).toEqual(["a.ts"]);
  });
});

describe("collectClaims with settled records", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  const base = { own: ["a.ts", "b.ts"], ownPrefixes: ["mine"], now, transcripts: [] };
  const settledRecord = {
    id: "other",
    label: "settled",
    day: "2026-09-27",
    mtimeMs: now,
    flags: [],
    pending: ["a.ts", "b.ts"],
    editedAt: new Map([
      ["a.ts", "2026-09-27T10:00:00Z"],
      ["b.ts", "2026-09-27T10:00:00Z"],
    ]),
  };

  it("judges each path by its stored edit time, with no uncommitted flag needed", () => {
    const lastCommit = new Map([["b.ts", Date.parse("2026-09-27T11:00:00Z") / 1000]]);
    const claims = collectClaims({
      ...base,
      records: [settledRecord],
      lastCommitSec: (p) => lastCommit.get(p) ?? null,
    });
    expect(claims).toEqual([{ id: "other", label: "settled", paths: ["a.ts"] }]);
  });
});

describe("claims of sessions whose work already landed", () => {
  const now = Date.parse("2026-11-04T08:00:00Z");
  // a05d68ad's case: a `git merge dev` in its worktree rewrote run-checks.yml after the last
  // commit that names the file, so the edit-time test alone keeps the claim open.
  const merged = {
    id: "merged-session",
    label: "repo hygiene",
    branch: "claude/my-app-repo-hygiene",
    day: "2026-11-03",
    mtimeMs: now,
    flags: [],
    pending: ["run-checks.yml"],
    editedAt: new Map([["run-checks.yml", "2026-11-03T15:32:53Z"]]),
  };
  const lastCommitSec = () => Date.parse("2026-11-03T15:21:09Z") / 1000;
  // The merged session ran in a worktree that was removed with its branch: no tree holds its edits.
  const facts = {
    currentBranch: "claude/this-session",
    hasCommits: (id) => ["merged-session", "unmerged-session"].includes(id),
    unmerged: new Set(["unmerged-session"]),
    sessionTree: () => "/repo/.claude/worktrees/repo-hygiene",
    branchTree: () => null,
    dirtyIn: () => new Set(),
  };
  const dirtyOnly = (tree) => (t) => new Set(t === tree ? ["run-checks.yml"] : []);
  const input = (records, git = facts) => ({
    own: ["run-checks.yml"],
    ownPrefixes: ["mine"],
    now,
    transcripts: [],
    records,
    lastCommitSec,
    landed: (record, path) => landedElsewhere(record, path, git),
  });

  it("drops a merged session's claim from another branch", () => {
    expect(collectClaims(input([merged]))).toEqual([]);
  });

  it("still reports that claim when no landed test is given, as before", () => {
    expect(collectClaims({ ...input([merged]), landed: undefined })).toEqual([
      { id: "merged-session", label: "repo hygiene", paths: ["run-checks.yml"] },
    ]);
  });

  it("keeps the claim of a session with a commit outside HEAD", () => {
    const record = { ...merged, id: "unmerged-session" };
    expect(collectClaims(input([record]))).toHaveLength(1);
  });

  it("keeps the claim of a session with no commits, whose edits no commit holds", () => {
    const record = { ...merged, id: "no-commits" };
    expect(collectClaims(input([record]))).toHaveLength(1);
  });

  it("keeps the claim of a session on this checkout's branch, which may share this working tree", () => {
    const record = { ...merged, branch: "claude/this-session" };
    expect(collectClaims(input([record]))).toHaveLength(1);
  });

  it("keeps the claim while the session's worktree still holds the path dirty", () => {
    const tree = "/repo/.claude/worktrees/repo-hygiene";
    const git = { ...facts, branchTree: () => tree, dirtyIn: dirtyOnly(tree) };
    expect(collectClaims(input([merged], git))).toHaveLength(1);
  });

  it("keeps the claim when that worktree's status could not be read", () => {
    expect(collectClaims(input([merged], { ...facts, dirtyIn: () => null }))).toHaveLength(1);
  });

  it("keeps the claim of a session whose checkout switched to this branch carrying its edits", () => {
    // Case (a): the session ran here on its branch; the checkout moved on to a branch that holds all
    // its commits and took the dirty file along, so the commit being checked would take that edit.
    const git = { ...facts, sessionTree: () => "/repo", dirtyIn: dirtyOnly("/repo") };
    expect(collectClaims(input([merged], git))).toHaveLength(1);
  });

  it("keeps the claim of a session whose worktree switched branch or detached with its edits", () => {
    // Case (b): no worktree is on the session's branch any more, but its own tree still is one.
    const tree = "/repo/.claude/worktrees/repo-hygiene";
    expect(collectClaims(input([merged], { ...facts, dirtyIn: dirtyOnly(tree) }))).toHaveLength(1);
  });

  it("drops the claim once both the session's tree and the worktree on its branch are clean", () => {
    const git = { ...facts, branchTree: () => "/repo/.claude/worktrees/later" };
    expect(collectClaims(input([merged], git))).toEqual([]);
  });

  it("keeps the claim when the session's tree is unknown but a worktree sits on its branch", () => {
    // Without the transcript the edits may be in a tree that switched away; a clean branch says nothing.
    const git = { ...facts, sessionTree: () => null, branchTree: () => "/repo/.claude/worktrees/later" };
    expect(collectClaims(input([merged], git))).toHaveLength(1);
  });

  it("drops the claim when the session's tree is unknown and no worktree is on its branch", () => {
    expect(collectClaims(input([merged], { ...facts, sessionTree: () => null }))).toEqual([]);
  });

  it("keeps the claim of a record with no usable branch", () => {
    for (const branch of [undefined, "unknown", "HEAD"]) {
      expect(collectClaims(input([{ ...merged, branch } ]))).toHaveLength(1);
    }
  });

  it("judges a live session of this checkout by its transcript, merged commits or not", () => {
    const claims = collectClaims({
      ...input([merged]),
      transcripts: [
        {
          id: "merged-session",
          mtimeMs: now - 3_600_000,
          editedAt: () => new Map([["run-checks.yml", "2026-11-04T07:00:00Z"]]),
        },
      ],
    });
    expect(claims).toEqual([{ id: "merged-session", label: "repo hygiene", paths: ["run-checks.yml"] }]);
  });
});
