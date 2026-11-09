import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "./session/vitest-compat.mjs";

const PLUGIN = fileURLToPath(new URL("../plugins/session/", import.meta.url));

// The writer works on the checkout of its cwd (or the hook payload's) and reads transcripts under
// HOME, so it runs against a throwaway repo with a fake HOME, never this repository's ledger. It
// runs from a copy of the plugin, so a test can put a stand-in beside it (the summarizer).
const ID = "aaaaaaaa-1111-2222-3333-444444444444";

let root;
let repo;
let home;
let plugin;

const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
// A developer's global signing config would fail every set-up commit.
const COMMIT = ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q"];
const later = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

function transcriptDir() {
  // Claude Code names a project's folder after its path, every non-alphanumeric character a `-`.
  return join(home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
}

function writeJsonl(path, entries) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function bash(id, command, at, doneAt, cwd = repo, sidechain = true) {
  return [
    {
      type: "assistant",
      timestamp: at,
      isSidechain: sidechain,
      cwd,
      sessionId: ID,
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    },
    {
      type: "user",
      timestamp: doneAt,
      isSidechain: sidechain,
      cwd,
      sessionId: ID,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "" }] },
    },
  ];
}

function edit(file, at, sidechain = false) {
  return {
    type: "assistant",
    timestamp: at,
    isSidechain: sidechain,
    sessionId: ID,
    message: {
      content: [{ type: "tool_use", id: `edit-${file}`, name: "Edit", input: { file_path: join(repo, file) } }],
    },
  };
}

function files(prefix = "aaaaaaaa") {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const result = spawnSync(
    process.execPath,
    [join(plugin, "scripts", "session-ledger.mjs"), "--files", prefix],
    {
      cwd: repo,
      encoding: "utf8",
      env,
    },
  );
  return result.stdout.split("\n").filter(Boolean);
}

/** Hook mode on one transcript; returns the records written to this checkout's ledger. */
function recordFor(transcript) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LEDGER_NO_SUMMARY: "1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  spawnSync(process.execPath, [join(plugin, "scripts", "session-ledger.mjs"), "--transcript", transcript], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  const ledger = join(repo, ".claude", "ledger");
  if (!existsSync(ledger)) return [];
  return readdirSync(ledger)
    .filter((name) => name.endsWith(".md") && name !== "INDEX.md")
    .map((name) => readFileSync(join(ledger, name), "utf8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-ledger-"));
  // The real path: on macOS the temp folder is a symlink, and the writer resolves its root through it.
  repo = join(realpathSync(root), "repo");
  home = join(root, "home");
  plugin = join(realpathSync(root), "plugin");
  for (const dir of ["scripts", "lib"]) cpSync(join(PLUGIN, dir), join(plugin, dir), { recursive: true });
  mkdirSync(repo, { recursive: true });
  git("init", "-q");
  // Every project that keeps a ledger turns it on in kit.json; committed, so it is never dirty.
  writeFileSync(join(repo, "kit.json"), JSON.stringify({ project: "t", ledger: true }));
  writeFileSync(join(repo, "notes.md"), "base\n");
  writeFileSync(join(repo, "mine.md"), "base\n");
  writeFileSync(join(repo, "other.md"), "base\n");
  git("add", ".");
  git(...COMMIT, "-m", "base");
  writeFileSync(join(repo, "notes.md"), "a sub-agent wrote this\n");
  writeFileSync(join(repo, "mine.md"), "the session wrote this\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("session-ledger --files", () => {
  it("lists the parent session's own edits", () => {
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), [
      { type: "user", timestamp: later(1), sessionId: ID, message: { content: "Edit mine.md for the test" } },
      edit("mine.md", later(2)),
    ]);
    expect(files()).toEqual(["mine.md"]);
  });

  it("also lists edits a sub-agent of the session made", () => {
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), [
      { type: "user", timestamp: later(1), sessionId: ID, message: { content: "Edit mine.md, delegate notes.md" } },
      edit("mine.md", later(2)),
    ]);
    writeJsonl(join(transcriptDir(), ID, "subagents", "agent-a1.jsonl"), [
      { type: "user", timestamp: later(3), isSidechain: true, sessionId: ID, message: { content: "Edit notes.md" } },
      edit("notes.md", later(4), true),
    ]);
    expect(files()).toEqual(["mine.md", "notes.md"]);
  });

  it("leaves the history a side chat copied from its parent to the parent", () => {
    // A side chat starts as a copy of the parent's transcript under a new id; the copied lines
    // keep the parent's sessionId, so the parent's edits must not become the fork's claims.
    const FORK = "ffffffff-1111-2222-3333-444444444444";
    writeFileSync(join(repo, "other.md"), "the side chat wrote this\n");
    writeJsonl(join(transcriptDir(), `${FORK}.jsonl`), [
      { type: "custom-title", customTitle: "Side chat", sessionId: FORK },
      { type: "user", timestamp: later(1), sessionId: ID, message: { content: "Edit mine.md for the test" } },
      edit("mine.md", later(2)),
      { type: "user", timestamp: later(3), sessionId: FORK, message: { content: "Now edit other.md" } },
      { ...edit("other.md", later(4)), sessionId: FORK },
    ]);
    expect(files("ffffffff")).toEqual(["other.md"]);
  });

  it("still lists the parent's edits when a side chat copied them", () => {
    const FORK = "ffffffff-1111-2222-3333-444444444444";
    const parentLines = [
      { type: "user", timestamp: later(1), sessionId: ID, message: { content: "Edit mine.md for the test" } },
      edit("mine.md", later(2)),
    ];
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), parentLines);
    writeJsonl(join(transcriptDir(), `${FORK}.jsonl`), [
      { type: "custom-title", customTitle: "Side chat", sessionId: FORK },
      ...parentLines,
    ]);
    expect(files()).toEqual(["mine.md"]);
    expect(files("ffffffff")).toEqual([]);
  });

  it("gives a side chat with no turns of its own no files", () => {
    const FORK = "ffffffff-1111-2222-3333-444444444444";
    writeJsonl(join(transcriptDir(), `${FORK}.jsonl`), [
      { type: "custom-title", customTitle: "Side chat", sessionId: FORK },
      { type: "user", timestamp: later(1), sessionId: ID, message: { content: "Edit mine.md for the test" } },
      edit("mine.md", later(2)),
    ]);
    expect(files("ffffffff")).toEqual([]);
  });

  it("keeps the parent's later edit when a sub-agent edited the same file before a commit", () => {
    // /sdlc-build: the simplifier edits and commits mine.md, then the parent edits it again.
    writeFileSync(join(repo, "mine.md"), "simplified\n");
    git("add", "mine.md");
    spawnSync("git", [...COMMIT, "-m", "simplify"], {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: later(-60), GIT_AUTHOR_DATE: later(-60) },
    });
    writeFileSync(join(repo, "mine.md"), "the parent edited it again\n");
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), [
      { type: "user", timestamp: later(-200), sessionId: ID, message: { content: "Build, then touch mine.md again" } },
      edit("mine.md", later(30)),
    ]);
    writeJsonl(join(transcriptDir(), ID, "subagents", "agent-a1.jsonl"), [edit("mine.md", later(-120), true)]);

    expect(files()).toContain("mine.md");
  });

  it("does not attribute an isolated sub-agent's worktree run to this checkout", () => {
    const isolated = join(repo, ".claude", "worktrees", "agent-1");
    writeFileSync(join(repo, "other.md"), "a neighbour session wrote this\n");
    const neighbourWrite = new Date(Date.now() + 42_000);
    utimesSync(join(repo, "other.md"), neighbourWrite, neighbourWrite);
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), [
      {
        type: "user",
        timestamp: later(1),
        sessionId: ID,
        message: { content: "Edit mine.md, run a writer in isolation" },
      },
      edit("mine.md", later(2)),
    ]);
    writeJsonl(join(transcriptDir(), ID, "subagents", "agent-iso.jsonl"), [
      {
        type: "user",
        timestamp: later(39),
        isSidechain: true,
        cwd: isolated,
        sessionId: ID,
        message: { content: "Format" },
      },
      ...bash("b1", "pnpm run format", later(40), later(45), isolated),
    ]);

    expect(files()).toEqual(["mine.md"]);
  });

  it("lists a file a sub-agent wrote through a shell command", () => {
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), [
      {
        type: "user",
        timestamp: later(1),
        sessionId: ID,
        message: { content: "Delegate a shell write to a sub-agent" },
      },
    ]);
    writeJsonl(
      join(transcriptDir(), ID, "subagents", "agent-sh.jsonl"),
      bash("b2", "echo hi > notes.md", later(3), later(4)),
    );

    expect(files()).toEqual(["notes.md"]);
  });
});

describe("session-ledger --files around a merge", () => {
  /** `side` changes other.md and adds brought.md; both branches change clash.md, so the merge stops. */
  function mergeStoppedOnConflict() {
    git("checkout", "-q", "--", ".");
    writeFileSync(join(repo, "clash.md"), "base\n");
    git("add", "clash.md");
    git(...COMMIT, "-m", "clash base");
    git("switch", "-q", "-c", "side");
    writeFileSync(join(repo, "other.md"), "side\n");
    writeFileSync(join(repo, "brought.md"), "side\n");
    writeFileSync(join(repo, "clash.md"), "side\n");
    git("add", ".");
    git(...COMMIT, "-m", "side work");
    git("switch", "-q", "-");
    writeFileSync(join(repo, "clash.md"), "ours\n");
    git(...COMMIT, "-am", "our work");
    // Without an identity (a CI runner has no global one) git refuses the merge before trying it.
    expect(git(...COMMIT.slice(0, -2), "merge", "-q", "side").status).toBe(1);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  }
  const transcript = () => [
    { type: "user", timestamp: later(-10), sessionId: ID, message: { content: "Merge side and resolve" } },
    ...bash("m1", "git merge side", later(-5), later(1), repo, false),
    edit("clash.md", later(6)),
  ];

  it("lists the conflict the session resolved, not what the merge brought in", () => {
    mergeStoppedOnConflict();
    writeFileSync(join(repo, "clash.md"), "ours and side\n");
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), transcript());

    expect(files()).toEqual(["clash.md"]);
  });

  it("closes the resolved conflict's claim once the merge commit takes it", () => {
    mergeStoppedOnConflict();
    writeFileSync(join(repo, "clash.md"), "ours and side\n");
    git("add", "clash.md");
    const merged = spawnSync("git", [...COMMIT, "--no-edit"], {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: later(10) },
    });
    expect(merged.status).toBe(0);
    writeFileSync(join(repo, "clash.md"), "a later edit by someone else\n");
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), transcript());

    expect(files()).toEqual([]);
  });
});

describe("session-ledger --files on a file a script deleted", () => {
  /** The Pre/PostToolUse shell-deletions hook, fed the payload Claude Code sends for a shell call. */
  function shellHook(event, id, command, sessionId = ID) {
    const payload = {
      hook_event_name: event,
      session_id: sessionId,
      transcript_path: join(transcriptDir(), `${sessionId}.jsonl`),
      cwd: repo,
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: { command },
    };
    spawnSync(process.execPath, [join(plugin, "scripts", "shell-deletions-hook.mjs")], {
      cwd: repo,
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  }
  const prompt = { type: "user", timestamp: later(1), sessionId: ID, message: { content: "Render the diagrams" } };
  const render = "node scripts/render-diagram-pdfs.mjs";

  it("lists a tracked file a node script deleted during the call", () => {
    shellHook("PreToolUse", "b1", render);
    rmSync(join(repo, "other.md"));
    shellHook("PostToolUse", "b1", render);
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), [prompt, ...bash("b1", render, later(2), later(3), repo, false)]);

    expect(files()).toEqual(["other.md"]);
  });

  it("does not list a deletion that was already there when the call started", () => {
    rmSync(join(repo, "other.md"));
    shellHook("PreToolUse", "b1", render);
    shellHook("PostToolUse", "b1", render);
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), [prompt, ...bash("b1", render, later(2), later(3), repo, false)]);

    expect(files()).toEqual([]);
  });

  it("does not list a deletion made while a command that runs no script was running", () => {
    shellHook("PreToolUse", "b1", "ls docs");
    rmSync(join(repo, "other.md"));
    shellHook("PostToolUse", "b1", "ls docs");
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), [
      prompt,
      ...bash("b1", "ls docs", later(2), later(3), repo, false),
    ]);

    expect(files()).toEqual([]);
  });

  it("leaves a script's deletion to the parent when a side chat copied the call", () => {
    const FORK = "ffffffff-1111-2222-3333-444444444444";
    shellHook("PreToolUse", "b1", render);
    rmSync(join(repo, "other.md"));
    shellHook("PostToolUse", "b1", render);
    const parentLines = [prompt, ...bash("b1", render, later(2), later(3), repo, false)];
    writeJsonl(join(transcriptDir(), `${ID}.jsonl`), parentLines);
    writeJsonl(join(transcriptDir(), `${FORK}.jsonl`), [
      { type: "custom-title", customTitle: "Side chat", sessionId: FORK },
      ...parentLines,
      { type: "user", timestamp: later(4), sessionId: FORK, message: { content: "Edit mine.md" } },
      { ...edit("mine.md", later(5)), sessionId: FORK },
    ]);

    expect(files()).toEqual(["other.md"]);
    expect(files("ffffffff")).toEqual(["mine.md"]);
  });
});

describe("session-ledger --owed and --done", () => {
  const ledger = () => join(repo, ".claude", "ledger");
  const cli = (...args) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, [join(plugin, "scripts", "session-ledger.mjs"), ...args], {
      cwd: repo,
      encoding: "utf8",
      env,
    });
  };
  const record = (name, next) =>
    writeFileSync(
      join(ledger(), name),
      `---\nid: ${name.slice(11, 19)}-0000\ndate: ${name.slice(0, 10)}\nflags: []\n---\n\n# x\n\n## Intent\n\nx\n\n## Next\n\n${next}\n`,
    );

  beforeEach(() => {
    mkdirSync(ledger(), { recursive: true });
    record("2026-10-01-aaaa0001.md", "None.");
    record(
      "2026-10-02-bbbb0002.md",
      "1. (done 2026-10-03 cccc0003) `/check` — rerun\n2. `docs/x.md` — fix the table\n   after the merge.",
    );
    record("2026-10-03-cccc0003.md", "- (unverified) `src/a.ts` — confirm the guard\n- `/close-out` — land it");
  });

  it("lists open items newest first, done ones skipped, with their numbers", () => {
    const run = cli("--owed");
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n").filter(Boolean)).toEqual([
      "2026-10-03 cccc0003  1. (unverified) `src/a.ts` — confirm the guard",
      "2026-10-03 cccc0003  2. `/close-out` — land it",
      "2026-10-02 bbbb0002  2. `docs/x.md` — fix the table after the merge.",
    ]);
  });

  it("filters by a case-insensitive substring of the item text", () => {
    expect(cli("--owed", "DOCS/x").stdout.trim()).toBe(
      "2026-10-02 bbbb0002  2. `docs/x.md` — fix the table after the merge.",
    );
    expect(cli("--owed", "nothing-like-this").stdout).toBe("");
  });

  it("marks an item done in place, and --owed no longer lists it", () => {
    const before = readFileSync(join(ledger(), "2026-10-02-bbbb0002.md"), "utf8");
    const run = cli("--done", "bbbb0002", "2", "--as", "dddd0004");
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(".claude/ledger/2026-10-02-bbbb0002.md\titem 2 marked done");
    const after = readFileSync(join(ledger(), "2026-10-02-bbbb0002.md"), "utf8");
    const changed = after.split("\n").filter((line, i) => line !== before.split("\n")[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatch(/^2\. \(done \d{4}-\d{2}-\d{2} dddd0004\) `docs\/x\.md` — fix the table$/);
    expect(cli("--owed").stdout).not.toContain("bbbb0002");
  });

  it("refuses a bad item, a done item, an unknown record, and a missing signer", () => {
    expect(cli("--done", "bbbb0002", "9", "--as", "dddd0004").status).toBe(1);
    expect(cli("--done", "bbbb0002", "1", "--as", "dddd0004").stderr).toMatch(/already marked done/);
    expect(cli("--done", "zzzz", "1", "--as", "dddd0004").stderr).toMatch(/no record for zzzz/);
    expect(cli("--done", "bbbb0002", "2").status).toBe(1);
    expect(readFileSync(join(ledger(), "2026-10-02-bbbb0002.md"), "utf8")).toContain("2. `docs/x.md`");
  });
});

describe("session-ledger fills placeholders from the session's last wrap_up recap", () => {
  const MARKER = "_(from the session's last recap)_";
  const wrapUp = (recap, ask, at) => ({
    type: "assistant",
    timestamp: at,
    sessionId: ID,
    message: {
      content: [{ type: "tool_use", id: `wrap-${at}`, name: "mcp__ccd_turn__wrap_up", input: { recap, ask } }],
    },
  });
  const prompt = (at) => ({
    type: "user",
    timestamp: at,
    sessionId: ID,
    message: { content: "Build the recap fill, then tell me where it stands" },
  });
  let transcript;
  let summarizerRan;
  const run = () => {
    const payload = { session_id: ID, transcript_path: transcript, cwd: repo, hook_event_name: "Stop" };
    // The summarizer must stay enabled here: whether it is spawned is the point.
    return hookMode(repo, payload, { LEDGER_NO_SUMMARY: "" });
  };
  const recordText = () => {
    const name = run().names(repo)[0];
    return readFileSync(join(repo, ".claude", "ledger", name), "utf8");
  };
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  beforeEach(() => {
    transcript = join(transcriptDir(), `${ID}.jsonl`);
    // A stand-in summarizer that proves it was spawned; the writer still imports the marker from it.
    const stub = join(plugin, "scripts", "ledger-summarize.mjs");
    summarizerRan = `${stub}.ran`;
    writeFileSync(
      stub,
      [
        'import { writeFileSync } from "node:fs";',
        'export const SUMMARIZER_MARKER = "<!-- ledger-summarize -->";',
        'if (process.argv[1]?.endsWith("ledger-summarize.mjs")) writeFileSync(process.argv[1] + ".ran", "1");',
      ].join("\n"),
    );
  });

  it("writes Intent and Next from the recap, marked, titled, and spawns no summarizer", async () => {
    writeJsonl(transcript, [
      prompt(later(1)),
      edit("mine.md", later(2)),
      wrapUp("Built the recap fill. Tests pass; nothing committed yet.", "Commit now?", later(3)),
    ]);
    const text = recordText();
    expect(text).toContain(`## Intent\n\n${MARKER}\nBuilt the recap fill. Tests pass; nothing committed yet.\n`);
    expect(text).toContain(`## Next\n\n${MARKER}\n1. Open question at Stop: Commit now?\n`);
    expect(text).toMatch(/^title: "Built the recap fill"$/m);
    expect(text).toContain("_Choices worth not re-litigating");
    await sleep(800);
    expect(existsSync(summarizerRan)).toBe(false);
  });

  it("keeps a section the session wrote, re-fills a marked one from a newer recap, and says None. without an ask", () => {
    writeJsonl(transcript, [prompt(later(1)), edit("mine.md", later(2)), wrapUp("First recap.", "Go on?", later(3))]);
    const first = recordText();
    expect(first).toContain(`${MARKER}\nFirst recap.`);
    const name = run().names(repo)[0];
    const path = join(repo, ".claude", "ledger", name);
    writeFileSync(path, first.replace(`## Intent\n\n${MARKER}\nFirst recap.`, "## Intent\n\nHand-written intent."));

    writeJsonl(transcript, [
      prompt(later(1)),
      edit("mine.md", later(2)),
      wrapUp("First recap.", "Go on?", later(3)),
      wrapUp("Second recap, after more work.", undefined, later(4)),
    ]);
    const second = recordText();
    expect(second).toContain("## Intent\n\nHand-written intent.\n");
    expect(second).toContain(`## Next\n\n${MARKER}\nNone.\n`);
    expect(second).not.toContain("Go on?");
    // Rendered again from the same transcript, the record does not change.
    expect(recordText()).toBe(second);
  });

  it("leaves placeholders and spawns the summarizer when the session never wrapped up", async () => {
    writeJsonl(transcript, [prompt(later(1)), edit("mine.md", later(2))]);
    const text = recordText();
    expect(text).toContain("_What this session was for");
    expect(text).not.toContain(MARKER);
    for (let i = 0; i < 30 && !existsSync(summarizerRan); i += 1) await sleep(100);
    expect(existsSync(summarizerRan)).toBe(true);
  });
});

describe("session-ledger on a pasted prompt", () => {
  // The desktop app wraps pasted text in a tag, and a session started from a pasted brief has no
  // other prompt until its first turn ends.
  const pasted = (text) =>
    `<system-reminder>context</system-reminder><pasted_content id="c785">\n${text}\n</pasted_content id="c785">`;

  it("writes a record and lists the files of a session whose only prompt was pasted", () => {
    const transcript = join(transcriptDir(), `${ID}.jsonl`);
    writeJsonl(transcript, [
      {
        type: "user",
        timestamp: later(1),
        sessionId: ID,
        message: { content: [{ type: "text", text: pasted("Adopt appearance presets and land them") }] },
      },
      edit("mine.md", later(2)),
    ]);

    expect(files()).toEqual(["mine.md"]);
    const [record] = recordFor(transcript);
    expect(record).toMatch(/^id: aaaaaaaa-1111/m);
    expect(record).toContain("- mine.md");
  });
});

/**
 * Hook mode with the process in `scriptRepo` and the payload on stdin as the app sends it; returns
 * the record names in each checkout's ledger and the run's stderr.
 */
function hookMode(scriptRepo, payload, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LEDGER_NO_SUMMARY: "1", ...extraEnv };
  delete env.CLAUDE_CODE_SESSION_ID;
  const result = spawnSync(process.execPath, [join(plugin, "scripts", "session-ledger.mjs")], {
    cwd: scriptRepo,
    encoding: "utf8",
    env,
    input: JSON.stringify(payload),
  });
  const names = (dir) =>
    existsSync(join(dir, ".claude", "ledger"))
      ? readdirSync(join(dir, ".claude", "ledger")).filter((name) => name.endsWith(".md") && name !== "INDEX.md")
      : [];
  return { status: result.status, stderr: result.stderr, names };
}

describe("session-ledger hook mode for a worktree session", () => {
  const worktree = () => join(repo, ".claude", "worktrees", "wt");
  const turn = (text, at, cwd) => ({
    type: "user",
    timestamp: at,
    cwd,
    gitBranch: "claude/item",
    sessionId: ID,
    message: { content: text },
  });
  const editIn = (dir, file, at) => ({
    type: "assistant",
    timestamp: at,
    cwd: dir,
    gitBranch: "claude/item",
    sessionId: ID,
    message: {
      content: [{ type: "tool_use", id: `edit-${file}`, name: "Edit", input: { file_path: join(dir, file) } }],
    },
  });
  let transcript;
  let payload;

  beforeEach(() => {
    // The hooks are committed in beforeEach, so the linked worktree checks out its own copy.
    git("worktree", "add", "-q", worktree(), "-b", "claude/item");
    transcript = join(transcriptDir(), `${ID}.jsonl`);
    writeJsonl(transcript, [
      turn("Build the item in this worktree, please", later(1), worktree()),
      editIn(worktree(), "notes.md", later(2)),
    ]);
    payload = { session_id: ID, transcript_path: transcript, cwd: worktree(), hook_event_name: "Stop" };
  });

  it("writes the record into the worktree's ledger when the hook process starts in the main checkout", () => {
    const run = hookMode(repo, payload);
    expect(run.status).toBe(0);
    const names = run.names(worktree());
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\d{4}-\d{2}-\d{2}-aaaaaaaa\.md$/);
    expect(run.names(repo)).toEqual([]);
    const log = readFileSync(join(repo, ".git", "session-ledger-hook.log"), "utf8")
      .trim()
      .split("\n");
    expect(log.at(-1).endsWith(`\troot:${realpathSync(worktree())}`)).toBe(true);
  });

  it("records nothing when the worktree's own kit.json keeps no ledger", () => {
    writeFileSync(join(worktree(), "kit.json"), JSON.stringify({ project: "t" }));
    const run = hookMode(repo, payload);
    expect(run.status).toBe(0);
    expect(run.names(worktree())).toEqual([]);
    expect(run.names(repo)).toEqual([]);
  });
});

describe("session-ledger and kit.json", () => {
  const transcript = () => join(transcriptDir(), `${ID}.jsonl`);
  const payload = () => ({ session_id: ID, transcript_path: transcript(), cwd: repo, hook_event_name: "Stop" });
  const setKit = (kit) => {
    writeFileSync(join(repo, "kit.json"), JSON.stringify(kit));
    git("add", "kit.json");
    git(...COMMIT, "-m", "kit");
  };
  beforeEach(() => {
    writeJsonl(transcript(), [
      { type: "user", timestamp: later(1), sessionId: ID, message: { content: "Edit mine.md for the kit test" } },
      edit("mine.md", later(2)),
    ]);
  });

  it("stays quiet with ledger-stop in hooks.off, and with the ledger off", () => {
    for (const kit of [{ project: "t", ledger: true, hooks: { off: ["ledger-stop"] } }, { project: "t" }]) {
      setKit(kit);
      const run = hookMode(repo, payload());
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.names(repo)).toEqual([]);
    }
  });

  it("writes the record where paths.ledger points", () => {
    setKit({ project: "t", ledger: true, paths: { ledger: "notes/sessions" } });
    expect(hookMode(repo, payload()).status).toBe(0);
    const dir = join(repo, "notes", "sessions");
    expect(readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}-aaaaaaaa\.md$/.test(name))).toHaveLength(1);
    expect(existsSync(join(dir, "INDEX.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "ledger"))).toBe(false);
  });

  it("prints the session id with no record path on --refresh when the ledger is off, and writes nothing", () => {
    setKit({ project: "t" });
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    const result = spawnSync(process.execPath, [join(plugin, "scripts", "session-ledger.mjs"), "--refresh", "aaaaaaaa"], {
      cwd: repo,
      encoding: "utf8",
      env,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${ID}\t\n`);
    expect(existsSync(join(repo, ".claude", "ledger"))).toBe(false);
  });
});

describe("session-ledger records across trees", () => {
  const worktree = () => join(repo, ".claude", "worktrees", "wt");
  const turn = (text, at, cwd, gitBranch) => ({
    type: "user",
    timestamp: at,
    cwd,
    gitBranch,
    sessionId: ID,
    message: { content: text },
  });
  const editIn = (dir, file, at, gitBranch) => ({
    type: "assistant",
    timestamp: at,
    cwd: dir,
    gitBranch,
    sessionId: ID,
    message: {
      content: [{ type: "tool_use", id: `edit-${dir}-${file}`, name: "Edit", input: { file_path: join(dir, file) } }],
    },
  });

  it("writes nothing here for a session that worked in a worktree and then removed it", () => {
    const transcript = join(transcriptDir(), `${ID}.jsonl`);
    writeJsonl(transcript, [
      turn("Review the skills in a worktree", later(1), worktree(), "claude/review"),
      editIn(worktree(), "CLAUDE.md", later(2), "claude/review"),
      // `git worktree remove` sends the cwd back to this checkout, now on the integration branch.
      {
        type: "assistant",
        timestamp: later(3),
        cwd: repo,
        gitBranch: "feat/integration",
        sessionId: ID,
        message: { content: [{ type: "text", text: "I removed the worktree." }] },
      },
    ]);
    expect(recordFor(transcript)).toEqual([]);
  });

  it("keeps only this checkout's turns, branch and files when a session works in both", () => {
    const transcript = join(transcriptDir(), `${ID}.jsonl`);
    writeJsonl(transcript, [
      turn("Edit mine.md here first", later(1), repo, "main"),
      editIn(repo, "mine.md", later(2), "main"),
      turn("Now work in the worktree", later(3), worktree(), "claude/review"),
      editIn(worktree(), "CLAUDE.md", later(4), "claude/review"),
    ]);
    const [record] = recordFor(transcript);
    expect(record).toMatch(/^branch: main$/m);
    expect(record).toContain("- mine.md");
    expect(record).not.toContain(".claude/worktrees/");
    expect(record).not.toMatch(/process-change/);
  });
});

describe("session-ledger by-id lookups in the archive", () => {
  const archived = "2026-06-01-bbbbbbbb.md";
  const ledgerScript = () => join(plugin, "scripts", "session-ledger.mjs");
  const run = (...args) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, [ledgerScript(), ...args], { cwd: repo, encoding: "utf8", env });
  };

  beforeEach(() => {
    const dir = join(repo, ".claude", "ledger", "archive");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, archived),
      '---\nid: bbbbbbbb-1111-2222-3333-444444444444\ndate: 2026-06-01\nflags: []\npending: ["mine.md"]\n---\n\n# 2026-06-01 · bbbbbbbb\n\n## Intent\n\nx\n\n## Next\n\n1. (unverified) still owed\n\n## Files (1)\n\n- mine.md · 2026-06-01T10:00:00Z\n',
    );
  });

  it("--record and --files find a record that was moved to archive/", () => {
    expect(run("--record", "bbbbbbbb").stdout.trim()).toBe(".claude/ledger/archive/" + archived);
    expect(run("--files", "bbbbbbbb").stdout.split("\n").filter(Boolean)).toContain(
      ".claude/ledger/archive/" + archived,
    );
  });

  it("--owed lists its items and --done marks one there", () => {
    expect(run("--owed").stdout).toContain("2026-06-01 bbbbbbbb  1. (unverified) still owed");
    const done = run("--done", "bbbbbbbb", "1", "--as", "cccccccc");
    expect(done.status).toBe(0);
    expect(done.stdout.trim()).toBe(".claude/ledger/archive/" + archived + "\titem 1 marked done");
    expect(readFileSync(join(repo, ".claude", "ledger", "archive", archived), "utf8")).toContain("1. (done ");
  });
});

describe("session-ledger --archive", () => {
  const ledger = () => join(repo, ".claude", "ledger");
  const day = (ago) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  const record = (id8, next) =>
    `---\nid: ${id8}-1111-2222-3333-444444444444\ndate: x\nflags: []\n---\n\n# x\n\n## Intent\n\nx\n\n## Next\n\n${next}\n\n## Files (0)\n`;
  const run = (...args) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, [join(plugin, "scripts", "session-ledger.mjs"), "--archive", ...args], {
      cwd: repo,
      encoding: "utf8",
      env,
    });
  };
  const status = () =>
    git("status", "--porcelain", "--untracked-files=all", "--", ".claude/ledger")
      .stdout.split("\n")
      .filter(Boolean)
      .sort();

  beforeEach(() => {
    mkdirSync(ledger(), { recursive: true });
    writeFileSync(join(ledger(), `${day(100)}-aaaaaaaa.md`), record("aaaaaaaa", "None."));
    writeFileSync(join(ledger(), `${day(90)}-bbbbbbbb.md`), record("bbbbbbbb", "1. still open"));
    writeFileSync(
      join(ledger(), `${day(80)}-cccccccc.md`),
      record("cccccccc", "1. (done 2026-10-23 dddddddd) finished"),
    );
    writeFileSync(join(ledger(), `${day(10)}-dddddddd.md`), record("dddddddd", "None."));
    git("add", ".claude");
    git(...COMMIT, "-m", "records");
    writeFileSync(join(ledger(), `${day(70)}-eeeeeeee.md`), record("eeeeeeee", "None."));
  });

  it("--dry-run lists the settled records older than the cut-off and moves nothing", () => {
    const result = run("--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n").filter(Boolean)).toEqual([
      `.claude/ledger/${day(70)}-eeeeeeee.md`,
      `.claude/ledger/${day(80)}-cccccccc.md`,
      `.claude/ledger/${day(100)}-aaaaaaaa.md`,
      "session-ledger --archive --dry-run: 3 record(s) older than 60 days with nothing owed would move to .claude/ledger/archive/",
    ]);
    expect(status()).toEqual([`?? .claude/ledger/${day(70)}-eeeeeeee.md`]);
  });

  it("moves them with git mv, keeps a record with an open Next, and rebuilds the index with the archive count", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "session-ledger --archive: 3 record(s) older than 60 days with nothing owed moved to .claude/ledger/archive/",
    );
    expect(status()).toEqual(
      [
        `?? .claude/ledger/archive/${day(70)}-eeeeeeee.md`,
        `R  .claude/ledger/${day(100)}-aaaaaaaa.md -> .claude/ledger/archive/${day(100)}-aaaaaaaa.md`,
        `R  .claude/ledger/${day(80)}-cccccccc.md -> .claude/ledger/archive/${day(80)}-cccccccc.md`,
        "?? .claude/ledger/INDEX.md",
      ].sort(),
    );
    expect(existsSync(join(ledger(), `${day(90)}-bbbbbbbb.md`))).toBe(true);
    expect(readFileSync(join(ledger(), "INDEX.md"), "utf8")).toContain("… 3 in archive/");
  });

  it("honours --days and refuses a bad value", () => {
    expect(run("--days", "95", "--dry-run").stdout).toContain("1 record(s) older than 95 days");
    const bad = run("--days", "soon");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("positive whole number");
  });
});

describe("session-ledger --refresh and --transcript on a worktree session's transcript", () => {
  // The worktree is gone, as it is once `/close-out` has landed and removed it; its record was
  // merged into this checkout's ledger, and only this checkout's copy is left to refresh it.
  const worktree = () => join(repo, ".claude", "worktrees", "wt");
  const transcript = () => join(home, ".claude", "projects", worktree().replace(/[^A-Za-z0-9]/g, "-"), `${ID}.jsonl`);
  const run = (...args) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, LEDGER_NO_SUMMARY: "1" };
    delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, [join(plugin, "scripts", "session-ledger.mjs"), ...args], {
      cwd: repo,
      encoding: "utf8",
      env,
    });
  };
  const record = () => {
    const ledger = join(repo, ".claude", "ledger");
    const names = existsSync(ledger)
      ? readdirSync(ledger).filter((n) => /^\d{4}-\d{2}-\d{2}-aaaaaaaa\.md$/.test(n))
      : [];
    expect(names).toHaveLength(1);
    return readFileSync(join(ledger, names[0]), "utf8");
  };

  beforeEach(() => {
    writeJsonl(transcript(), [
      {
        type: "user",
        timestamp: later(1),
        cwd: worktree(),
        gitBranch: "claude/item",
        sessionId: ID,
        message: { content: "Build the item in this worktree, please" },
      },
      {
        type: "assistant",
        timestamp: later(2),
        cwd: worktree(),
        gitBranch: "claude/item",
        sessionId: ID,
        message: {
          content: [
            { type: "tool_use", id: "e1", name: "Edit", input: { file_path: join(worktree(), "notes.md") } },
            {
              type: "tool_use",
              id: "w1",
              name: "mcp__ccd_turn__wrap_up",
              input: { recap: "Built the item in its worktree." },
            },
          ],
        },
      },
    ]);
  });

  it("--refresh finds it under the worktree's project folder and records it as the worktree saw it", () => {
    const result = run("--refresh", "aaaaaaaa");
    expect(result.stdout).toContain(`${ID}\t.claude/ledger/`);
    const text = record();
    expect(text).toMatch(/^branch: claude\/item$/m);
    expect(text).toContain("_(from the session's last recap)_\nBuilt the item in its worktree.");
    expect(text).toMatch(/^- notes\.md\b/m);
    expect(text).not.toContain(".claude/worktrees/");
  });

  it("keeps the named branch when the last turns ran detached, after the worktree was removed", () => {
    const lines = readFileSync(transcript(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    writeJsonl(transcript(), [
      ...lines,
      {
        type: "user",
        timestamp: later(3),
        cwd: worktree(),
        gitBranch: "HEAD",
        sessionId: ID,
        message: { content: "Remove the worktree" },
      },
    ]);
    run("--refresh", "aaaaaaaa");
    expect(record()).toMatch(/^branch: claude\/item$/m);
  });

  it("keeps process-change while the stored file list still holds a process path", () => {
    const lines = readFileSync(transcript(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const ruleEdit = {
      type: "assistant",
      timestamp: later(3),
      cwd: worktree(),
      gitBranch: "claude/item",
      sessionId: ID,
      message: {
        content: [
          {
            type: "tool_use",
            id: "e2",
            name: "Edit",
            input: { file_path: join(worktree(), ".claude", "rules", "r.md") },
          },
        ],
      },
    };
    writeJsonl(transcript(), [...lines, ruleEdit]);
    run("--refresh", "aaaaaaaa");
    expect(record()).toMatch(/^flags: \[process-change\]$/m);
    // A path the transcript no longer yields (a shell edit judged by the removed tree's mtimes) stays listed.
    writeJsonl(transcript(), lines);
    run("--refresh", "aaaaaaaa");
    expect(record()).toContain("- .claude/rules/r.md");
    expect(record()).toMatch(/^flags: \[process-change\]$/m);
  });

  it("redacts a key-shaped recap and keeps secret-redacted once the transcript is clean again", () => {
    const lines = readFileSync(transcript(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const key = `sk-${"ant"}-api03-${"a1B2".repeat(10)}`;
    const leaky = {
      type: "assistant",
      timestamp: later(3),
      cwd: worktree(),
      gitBranch: "claude/item",
      sessionId: ID,
      message: {
        content: [{ type: "tool_use", id: "w2", name: "mcp__ccd_turn__wrap_up", input: { recap: `Rotated ${key}.` } }],
      },
    };
    writeJsonl(transcript(), [...lines, leaky]);
    run("--refresh", "aaaaaaaa");
    expect(record()).not.toContain(key);
    expect(record()).toMatch(/^flags: \[.*\bsecret-redacted\b.*\]$/m);
    writeJsonl(transcript(), lines);
    run("--refresh", "aaaaaaaa");
    expect(record()).toMatch(/^flags: \[.*\bsecret-redacted\b.*\]$/m);
  });

  it("--refresh prints the id with no path for a session too small for a record", () => {
    writeJsonl(transcript(), [
      {
        type: "user",
        timestamp: later(1),
        cwd: worktree(),
        gitBranch: "claude/item",
        sessionId: ID,
        message: { content: "Hi" },
      },
    ]);
    const result = run("--refresh", "aaaaaaaa");
    expect(result.stdout).toBe(`${ID}\t\n`);
    const ledger = join(repo, ".claude", "ledger");
    expect(existsSync(ledger) ? readdirSync(ledger).filter((n) => n.endsWith("-aaaaaaaa.md")) : []).toEqual([]);
  });

  it("--transcript parses it against the worktree it ran in", () => {
    run("--transcript", transcript());
    const text = record();
    expect(text).toMatch(/^branch: claude\/item$/m);
    expect(text).toMatch(/^- notes\.md\b/m);
  });
});

describe("session-ledger --conflicts on sessions whose work already landed", () => {
  const MERGED = "bbbbbbbb-1111-2222-3333-444444444444";
  const SWITCHED = "cccccccc-1111-2222-3333-444444444444";
  const day = new Date().toISOString().slice(0, 10);
  const gitIn = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const commitAs = (cwd, id, file) => {
    writeFileSync(join(cwd, file), `${id}\n`);
    gitIn(cwd, "add", file);
    gitIn(cwd, ...COMMIT, "-m", `work\n\nSession-Id: ${id}`);
  };
  const record = (id, branch, path) => {
    mkdirSync(join(repo, ".claude", "ledger"), { recursive: true });
    const text = [
      "---",
      `id: ${id}`,
      `date: ${day}`,
      `branch: ${branch}`,
      'title: "landed work"',
      "flags: []",
      "---",
      "",
      `# ${day} · landed work`,
      "",
      "## Files (1)",
      "",
      `- ${path} · ${later(60).replace(/\.\d{3}Z$/, "Z")}`,
      "",
    ].join("\n");
    writeFileSync(join(repo, ".claude", "ledger", `${day}-${id.slice(0, 8)}.md`), text);
  };
  const transcript = (cwd, id) => {
    const path = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
    writeJsonl(path, [{ type: "user", timestamp: later(0), cwd, sessionId: id, message: { content: "work" } }]);
    // Older than a live session, so the record and the landed test judge it, not the transcript.
    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(path, old, old);
  };
  const conflicts = (...paths) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(
      process.execPath,
      [join(plugin, "scripts", "session-ledger.mjs"), "--conflicts", "mine", "--", ...paths],
      { cwd: repo, encoding: "utf8", env },
    );
  };

  it("keeps a switched checkout's claim and drops a merged session's whose worktree was removed", () => {
    const base = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    git("add", ".");
    git(...COMMIT, "-m", "set-up");
    writeFileSync(join(repo, "merge-written.md"), "base\n");
    writeFileSync(join(repo, "carried.md"), "base\n");
    git("add", ".");
    git(...COMMIT, "-m", "shared files");

    // A session in a worktree, merged into the base branch; the worktree and its branch are gone.
    const tree = join(repo, ".claude", "worktrees", "merged");
    gitIn(repo, "worktree", "add", "-q", "-b", "claude/merged", tree);
    commitAs(tree, MERGED, "merged.md");
    gitIn(repo, ...COMMIT.slice(0, -2), "merge", "-q", "--no-edit", "claude/merged");
    gitIn(repo, "worktree", "remove", "--force", tree);
    gitIn(repo, "branch", "-D", "claude/merged");
    transcript(tree, MERGED);
    record(MERGED, "claude/merged", "merge-written.md");

    // Case (a): a session in this checkout on its own branch, whose commits the base branch holds;
    // the checkout switched back to the base branch carrying the session's uncommitted edit.
    gitIn(repo, "checkout", "-q", "-b", "feature-a");
    commitAs(repo, SWITCHED, "feature.md");
    writeFileSync(join(repo, "carried.md"), "the switched session's edit\n");
    gitIn(repo, "checkout", "-q", base);
    gitIn(repo, ...COMMIT.slice(0, -2), "merge", "-q", "--no-edit", "feature-a");
    transcript(repo, SWITCHED);
    record(SWITCHED, "feature-a", "carried.md");

    writeFileSync(join(repo, "merge-written.md"), "this session's edit\n");
    const result = conflicts("merge-written.md", "carried.md");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("carried.md");
    expect(result.stdout).toContain("cccccccc");
    expect(result.stdout).not.toContain("merge-written.md");
    expect(result.stdout).not.toContain("bbbbbbbb");
  });

  it("keeps the claim of a merged worktree session whose worktree detached holding its edit", () => {
    // Case (b): no worktree is on the session's branch any more, but its own tree still holds the edit.
    const DETACHED = "dddddddd-1111-2222-3333-444444444444";
    git("add", ".");
    git(...COMMIT, "-m", "set-up");
    const tree = join(repo, ".claude", "worktrees", "detached");
    gitIn(repo, "worktree", "add", "-q", "-b", "claude/detached", tree);
    commitAs(tree, DETACHED, "detached.md");
    gitIn(repo, ...COMMIT.slice(0, -2), "merge", "-q", "--no-edit", "claude/detached");
    gitIn(tree, "checkout", "-q", "--detach");
    writeFileSync(join(tree, "kept.md"), "the detached session's edit\n");
    transcript(tree, DETACHED);
    record(DETACHED, "claude/detached", "kept.md");

    writeFileSync(join(repo, "kept.md"), "this session's edit\n");
    const result = conflicts("kept.md");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("dddddddd");
  });
});
