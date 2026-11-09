import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "./session/vitest-compat.mjs";
import {
  auditCommand,
  auditTail,
  holdsCode,
  quotePath,
  splitLedgerStatus,
  unattributedFiles,
} from "../plugins/session/scripts/git-commit-session.mjs";

const SCRIPTS = fileURLToPath(new URL("../plugins/session/scripts/", import.meta.url));

const SCRIPT = join(SCRIPTS, "git-commit-session.mjs");
// No session id: these tests are about git, and the claims check would read this repo's ledger.
const env = { ...process.env, COMMIT_LOCK_WAIT_MS: "400" };
delete env.CLAUDE_CODE_SESSION_ID;

let repo;

function git(...args) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trim();
}

function commitSession(
  paths,
  message = "test: commit",
  options = {},
) {
  return spawnSync(process.execPath, [SCRIPT, ...(options.args ?? []), "--", ...paths], {
    cwd: options.cwd ?? repo,
    encoding: "utf8",
    input: message,
    env: options.env ?? env,
  });
}

/**
 * Stand-in hooks folder. `session-ledger.mjs --conflicts` records its arguments, prints `output`
 * and exits with `status`; `--refresh` prints `refresh` lines (`<full id>\\t<record path>`) and
 * writes each record.
 */
function fakeLedger(
  status,
  output = "",
  { refresh, files = [] } = {},
) {
  const dir = `${repo}-hooks`;
  mkdirSync(dir, { recursive: true });
  const argsFile = join(dir, "conflicts.args");
  writeFileSync(
    join(dir, "session-ledger.mjs"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--files") {
  for (const line of ${JSON.stringify(files)}) console.log(line);
  process.exit(0);
}
if (args[0] === "--refresh") {
  writeFileSync(${JSON.stringify(join(dir, "refresh.args"))}, JSON.stringify(args));
  // Like the real ledger: every prefix resolves to a full id; a record path only when one was written.
  const lines = ${JSON.stringify(refresh ?? null)} ?? args.slice(1).map((prefix) => prefix + "-full\\t");
  for (const line of lines) {
    const record = line.split("\\t")[1];
    if (record) {
      mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, "record\\n");
    }
    console.log(line);
  }
  process.exit(0);
}
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
process.stdout.write(${JSON.stringify(output)});
process.exit(${status});`,
  );
  return {
    env: { ...env, GIT_COMMIT_SESSION_HOOKS_DIR: dir },
    args: () => JSON.parse(readFileSync(argsFile, "utf8")),
    refreshed: () =>
      existsSync(join(dir, "refresh.args")) ? JSON.parse(readFileSync(join(dir, "refresh.args"), "utf8")) : null,
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "commit-session-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  // A clone's own lefthook must not run inside the temp repo; a missing folder means no hooks.
  git("config", "core.hooksPath", "no-hooks");
  for (const name of ["mine.txt", "gone.txt", "old.txt", "theirs.txt"]) writeFileSync(join(repo, name), `${name}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(`${repo}-hooks`, { recursive: true, force: true });
  rmSync(`${repo}-wt`, { recursive: true, force: true });
});

describe("git-commit-session", () => {
  it("commits only its paths and leaves another session's staging in place", () => {
    writeFileSync(join(repo, "theirs.txt"), "staged by another session\n");
    git("add", "theirs.txt");
    writeFileSync(join(repo, "mine.txt"), "changed\n");

    const result = commitSession(["mine.txt"]);

    expect(result.status).toBe(0);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("mine.txt");
    expect(git("diff", "--cached", "--name-only")).toBe("theirs.txt");
  });

  it("commits modified, deleted, renamed and new paths together", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    unlinkSync(join(repo, "gone.txt"));
    renameSync(join(repo, "old.txt"), join(repo, "new.txt"));
    writeFileSync(join(repo, "added.txt"), "added\n");

    const result = commitSession(["mine.txt", "gone.txt", "old.txt", "new.txt", "added.txt"]);

    expect(result.status).toBe(0);
    expect(git("show", "--name-status", "--format=", "-M", "HEAD").split("\n").sort()).toEqual([
      "A\tadded.txt",
      "D\tgone.txt",
      "M\tmine.txt",
      "R100\told.txt\tnew.txt",
    ]);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("leaves the message style to the caller: any non-empty message commits", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    expect(commitSession(["mine.txt"], "Update mine").status).toBe(0);
    expect(commitSession(["mine.txt"], "  \n").status).toBe(1);
  });

  it("runs kit.json commands.commitAudit after a commit with code, reports it, and keeps the commit's exit code", () => {
    writeFileSync(
      join(repo, "kit.json"),
      JSON.stringify({ project: "t", commands: { commitAudit: 'node -e "console.log(process.env.KIT_COMMIT_PATHS); process.exit(3)"' } }),
    );
    writeFileSync(join(repo, "code.mjs"), "export {};\n");
    const result = commitSession(["code.mjs"], "test: code");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("commit-audit:");
    expect(result.stdout).toContain("(exit 3,");
    expect(result.stdout).toContain("  code.mjs");

    writeFileSync(join(repo, "notes.md"), "notes\n");
    const docs = commitSession(["notes.md"], "docs: notes");
    expect(docs.status).toBe(0);
    expect(docs.stdout).not.toContain("commit-audit:");
  });

  it("puts the committed paths, quoted, where commitAudit says {files}", () => {
    expect(auditCommand("audit --only {files}", ["src/a.ts", "src/my file.ts"], "linux")).toBe("audit --only src/a.ts 'src/my file.ts'");
    expect(auditCommand("audit {files}", ["it's.ts"], "linux")).toBe(`audit 'it'\\''s.ts'`);
    expect(auditCommand("audit {files}", ["a b.ts"], "win32")).toBe('audit "a b.ts"');
    expect(auditCommand("audit --base HEAD~1", ["a.ts"], "linux")).toBe("audit --base HEAD~1");
    expect(quotePath("src/a.ts", "linux")).toBe("src/a.ts");

    writeFileSync(
      join(repo, "kit.json"),
      JSON.stringify({ project: "t", commands: { commitAudit: 'node -e "console.log(process.argv.slice(1).join(\'|\'))" {files}' } }),
    );
    writeFileSync(join(repo, "code.mjs"), "export {};\n");
    writeFileSync(join(repo, "two words.mjs"), "export {};\n");
    const result = commitSession(["code.mjs", "two words.mjs"], "test: code");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("  code.mjs|two words.mjs");
  });

  it("counts a skip for each kit.json preflight step a commit touches, and names the due ones", () => {
    writeFileSync(
      join(repo, "kit.json"),
      JSON.stringify({
        project: "t",
        preflight: {
          docs: { description: "Docs review", match: ["docs/**"] },
          audit: { description: "Audit", command: "node -e 0", remindAfter: 2 },
        },
      }),
    );
    writeFileSync(join(repo, "code.mjs"), "export {};\n");
    const first = commitSession(["code.mjs", "kit.json"], "test: code");
    expect(first.status).toBe(0);
    expect(first.stdout).not.toContain("preflight:");
    writeFileSync(join(repo, "code.mjs"), "export const a = 1;\n");
    const second = commitSession(["code.mjs"], "test: more");
    expect(second.stdout).toContain("preflight: audit skipped in 2 commit(s) since its last run; `preflight run audit`");
    expect(second.stdout).not.toContain("preflight: docs");
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "a.md"), "a\n");
    const third = commitSession(["docs/a.md"], "docs: a");
    expect(third.stdout).toContain("preflight: docs skipped in 1 commit(s) since its last run; Docs review, then `preflight done docs`");
  });

  it("says when the audit command is not installed, and still exits 0", () => {
    writeFileSync(join(repo, "kit.json"), JSON.stringify({ project: "t", commands: { commitAudit: "no-such-audit-tool-xyz" } }));
    writeFileSync(join(repo, "code.mjs"), "export {};\n");
    const result = commitSession(["code.mjs"], "test: code");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("commit-audit: no-such-audit-tool-xyz is not installed here");
  });

  it("refuses with exit 8 a cached deletion whose file is still on disk, and commits it once deleted", () => {
    // An ignored file untracked with `git rm --cached` but left on disk.
    writeFileSync(join(repo, ".gitignore"), "gone.txt\n");
    git("rm", "--cached", "-q", "gone.txt");
    writeFileSync(join(repo, "mine.txt"), "changed\n");

    const withOthers = commitSession([".gitignore", "mine.txt", "gone.txt"]);
    expect(withOthers.status).toBe(8);
    expect(withOthers.stderr).toContain("staged as deleted but still on disk: gone.txt");
    const alone = commitSession(["gone.txt"]);
    expect(alone.status).toBe(8);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
    expect(git("diff", "--cached", "--name-status")).toBe("D\tgone.txt");

    unlinkSync(join(repo, "gone.txt"));
    expect(commitSession([".gitignore", "mine.txt", "gone.txt"]).status).toBe(0);
    expect(git("show", "--name-status", "--no-renames", "--format=", "HEAD").split("\n").sort()).toEqual([
      "A\t.gitignore",
      "D\tgone.txt",
      "M\tmine.txt",
    ]);
  });

  it("prints the usage and every exit code on --help, outside a repository too", () => {
    const outside = mkdtempSync(join(tmpdir(), "commit-session-help-"));
    try {
      const result = spawnSync(process.execPath, [SCRIPT, "--help"], { cwd: outside, encoding: "utf8", env });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("--worktree");
      for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 8]) expect(result.stdout).toMatch(new RegExp(`^  ${code}  \\S`, "m"));
      // After the separator `-h` is a path, so the script goes on to look for the repository.
      const asPath = spawnSync(process.execPath, [SCRIPT, "--", "-h"], { cwd: outside, encoding: "utf8", env });
      expect(asPath.status).toBe(1);
      expect(asPath.stderr).toContain("not inside a git repository");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(spawnSync(process.execPath, [SCRIPT, "-h"], { cwd: repo, encoding: "utf8", env }).status).toBe(0);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("says it skipped the claims check without a session id", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    expect(commitSession(["mine.txt"]).stderr).toContain("claims not checked");
  });

  it("refuses to run without paths or without a message", () => {
    expect(commitSession([]).status).toBe(1);
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    expect(commitSession(["mine.txt"], "  \n").status).toBe(1);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("refuses an argument before -- it does not take, with the usage, and commits nothing", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const refused = (args) => {
      const result = commitSession(["mine.txt"], "test: commit", { args });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Exit codes:");
      return result.stderr.split("\n")[0];
    };

    expect(refused(["-m", "test: commit"])).toContain(
      "unknown flag -m: write the message to a file and pass --message-file",
    );
    expect(refused(["--message", "test: commit"])).toContain("unknown flag --message: write the message to a file");
    expect(refused(["--worktre"])).toContain("unknown flag --worktre");
    expect(refused(["--message-file=msg.txt"])).toContain("pass --message-file and its value as two arguments");
    expect(refused(["--message-file"])).toContain("--message-file needs a value");
    expect(refused(["stray.txt"])).toContain("unexpected argument stray.txt: paths go after --");
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("refuses to wait on a terminal for the message", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    // Stands in for a terminal on stdin: the script asks `isatty(0)`, which a spawned pipe never is.
    const preload = join(`${repo}-hooks`, "tty-stdin.cjs");
    mkdirSync(`${repo}-hooks`, { recursive: true });
    writeFileSync(
      preload,
      `const tty = require("node:tty");
const isatty = tty.isatty;
tty.isatty = (fd) => fd === 0 || isatty(fd);
require("node:module").syncBuiltinESMExports();`,
    );

    const result = spawnSync(process.execPath, ["--require", preload, SCRIPT, "--", "mine.txt"], {
      cwd: repo,
      encoding: "utf8",
      input: "test: commit",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stdin is a terminal; pass --message-file <file>");
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("stops when stdin stays open with no message, as an agent's shell leaves it", async () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const child = spawn(process.execPath, [SCRIPT, "--", "mine.txt"], {
      cwd: repo,
      env: { ...env, COMMIT_STDIN_TIMEOUT_MS: "300" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));

    // stdin is never written to or closed, which used to block the script forever.
    const status = await new Promise((done) => child.on("close", done));

    child.stdin.destroy();
    expect(status).toBe(1);
    expect(stderr).toContain("stdin was still open after 0.3 s with no end of input");
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("stops with exit 3 while index.lock is held, and leaves the lock in place", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const lock = join(repo, ".git", "index.lock");
    writeFileSync(lock, "");

    const result = commitSession(["mine.txt"]);

    expect(result.status).toBe(3);
    expect(existsSync(lock)).toBe(true);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("commits once a held lock is released during the wait", async () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const lock = join(repo, ".git", "index.lock");
    writeFileSync(lock, "");
    const startedAt = Date.now();
    const child = spawn(process.execPath, [SCRIPT, "--", "mine.txt"], { cwd: repo, env });
    child.stdin.end("test: after the lock");
    setTimeout(() => unlinkSync(lock), 150);

    const status = await new Promise((done) => child.on("close", done));

    expect(status).toBe(0);
    // Without the wait, git would have failed on the lock long before it was released.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(git("log", "-1", "--format=%s")).toBe("test: after the lock");
  });

  it("commits the new files inside a directory path", () => {
    mkdirSync(join(repo, "dir"));
    writeFileSync(join(repo, "dir", "new.txt"), "new\n");

    expect(commitSession(["dir"]).status).toBe(0);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("dir/new.txt");
  });

  it("checks claims on the changed files a directory path expands to, and commits exactly those", () => {
    mkdirSync(join(repo, "dir"));
    for (const name of ["kept.txt", "changed.txt", "gone.txt"]) writeFileSync(join(repo, "dir", name), `${name}\n`);
    git("add", "dir");
    git("commit", "-q", "-m", "dir");
    writeFileSync(join(repo, "dir", "changed.txt"), "changed\n");
    unlinkSync(join(repo, "dir", "gone.txt"));
    writeFileSync(join(repo, "dir", "new.txt"), "new\n");
    const ledger = fakeLedger(0);

    const result = commitSession(["dir"], "test: dir claims", { args: ["--session", "aaaaaaaa"], env: ledger.env });

    expect(result.status).toBe(0);
    const checked = ledger.args();
    expect(checked.slice(checked.indexOf("--") + 1)).toEqual(["dir/changed.txt", "dir/gone.txt", "dir/new.txt"]);
    expect(git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "dir/changed.txt",
      "dir/gone.txt",
      "dir/new.txt",
    ]);
  });

  it("normalizes ./ paths and paths given from a subdirectory", () => {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "x.txt"), "x\n");
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const ledger = fakeLedger(0);

    const result = commitSession(["x.txt", "../mine.txt"], "test: normalized", {
      cwd: join(repo, "sub"),
      args: ["--session", "aaaaaaaa"],
      env: ledger.env,
    });

    expect(result.status).toBe(0);
    expect(ledger.args().slice(-3)).toEqual(["--", "mine.txt", "sub/x.txt"]);
    expect(git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["mine.txt", "sub/x.txt"]);
  });

  it("refuses a path outside the repository", () => {
    expect(commitSession(["../elsewhere.txt"]).status).toBe(1);
  });

  it("passes every session id and allowed path to the claims check", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const ledger = fakeLedger(0);

    commitSession(["mine.txt"], "test: ids", {
      args: ["--session", "old11111", "--session", "new22222", "--allow-shared", "./mine.txt"],
      env: ledger.env,
    });

    expect(ledger.args()).toEqual([
      "--conflicts",
      "old11111",
      "new22222",
      "--allow-shared",
      "mine.txt",
      "--",
      "mine.txt",
    ]);
  });

  it("stops with exit 2 on a shared path, names this session and commits nothing", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const ledger = fakeLedger(2, "mine.txt\talso claimed by bbbbbbbb\n");

    const result = commitSession(["mine.txt"], "test: shared", { args: ["--session", "aaaaaaaa"], env: ledger.env });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("also claimed by bbbbbbbb");
    expect(result.stderr).toContain("aaaaaaaa");
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("fails closed when the claims check cannot run", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const ledger = fakeLedger(1);

    const result = commitSession(["mine.txt"], "test: broken check", {
      args: ["--session", "aaaaaaaa"],
      env: ledger.env,
    });

    expect(result.status).toBe(1);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("removes its own intent-to-add entries when the commit fails", () => {
    writeFileSync(join(repo, "added.txt"), "added\n");
    git("config", "core.hooksPath", "hooks");
    mkdirSync(join(repo, "hooks"));
    writeFileSync(join(repo, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const result = commitSession(["added.txt"]);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/git-commit-session: $/m);
    expect(git("status", "--porcelain", "--", "added.txt")).toBe("?? added.txt");
  });

  it("adds a Session-Id trailer with the full id the refresh resolves from a prefix", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const hooks = fakeLedger(0, "", { refresh: ["aaaaaaaa-1111-2222\t.claude/ledger/2026-09-27-aaaaaaaa.md"] });

    const result = commitSession(["mine.txt"], "test: trailer\n\nCo-Authored-By: X <x@example.com>\n", {
      args: ["--session", "aaaaaaaa"],
      env: hooks.env,
    });

    expect(result.status).toBe(0);
    expect(hooks.refreshed()).toEqual(["--refresh", "aaaaaaaa"]);
    expect(git("log", "-1", "--format=%(trailers:key=Session-Id,valueonly)")).toBe("aaaaaaaa-1111-2222");
    expect(git("log", "-1", "--format=%(trailers:key=Co-Authored-By,valueonly)")).toBe("X <x@example.com>");
  });

  it("puts the refreshed record in the same commit", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const hooks = fakeLedger(0, "", { refresh: ["aaaaaaaa-1111\t.claude/ledger/2026-09-27-aaaaaaaa.md"] });

    commitSession(["mine.txt"], "test: record", { args: ["--session", "aaaaaaaa"], env: hooks.env });

    expect(git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      ".claude/ledger/2026-09-27-aaaaaaaa.md",
      "mine.txt",
    ]);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("carries one trailer per id after a resume", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const hooks = fakeLedger(0, "", {
      refresh: [
        "old11111-aaaa\t.claude/ledger/2026-09-26-old11111.md",
        "new22222-bbbb\t.claude/ledger/2026-09-27-new22222.md",
      ],
    });

    commitSession(["mine.txt"], "test: resume", {
      args: ["--session", "old11111", "--session", "new22222"],
      env: hooks.env,
    });

    expect(git("log", "-1", "--format=%(trailers:key=Session-Id,valueonly,separator=%x2C)")).toBe(
      "old11111-aaaa,new22222-bbbb",
    );
  });

  it("adds a trailer even when the session's record is not written", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");

    commitSession(["mine.txt"], "test: trivial", { args: ["--session", "aaaaaaaa"], env: fakeLedger(0).env });

    expect(git("log", "-1", "--format=%(trailers:key=Session-Id,valueonly)")).toBe("aaaaaaaa-full");
  });

  it("stops when a --session prefix resolves to no session", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");

    const result = commitSession(["mine.txt"], "test: unknown", {
      args: ["--session", "aaaaaaaa"],
      env: fakeLedger(0, "", { refresh: [] }).env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("aaaaaaaa");
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("neither refreshes nor adds a trailer with --no-claims and no session id", () => {
    writeFileSync(join(repo, "mine.txt"), "changed\n");
    const hooks = fakeLedger(0, "", { refresh: ["aaaaaaaa-1111\t.claude/ledger/r.md"] });

    commitSession(["mine.txt"], "chore(ledger): close", { args: ["--no-claims"], env: hooks.env });

    expect(hooks.refreshed()).toBeNull();
    expect(git("log", "-1", "--format=%(trailers:key=Session-Id,valueonly)")).toBe("");
  });

  it("skips only the claims check with --session and --no-claims, so its own --amend accepts the commit", () => {
    writeFileSync(join(repo, "mine.txt"), "first\n");
    // A claims check that ran would stop the commit with exit 2.
    const hooks = fakeLedger(2, "mine.txt shared\n");

    const first = commitSession(["mine.txt"], "feat: first", {
      args: ["--session", "aaaaaaaa", "--no-claims"],
      env: hooks.env,
    });

    expect(first.status).toBe(0);
    expect(hooks.refreshed()).toEqual(["--refresh", "aaaaaaaa"]);
    expect(git("log", "-1", "--format=%(trailers:key=Session-Id,valueonly)")).toBe("aaaaaaaa-full");

    writeFileSync(join(repo, "mine.txt"), "second\n");
    const amended = commitSession(["mine.txt"], "", {
      args: ["--amend", "--session", "aaaaaaaa", "--no-claims"],
      env: hooks.env,
    });

    expect(amended.status).toBe(0);
    expect(git("log", "--oneline").split("\n")).toHaveLength(2);
    expect(git("show", "HEAD:mine.txt")).toBe("second");
  });

  describe("--amend", () => {
    const commits = () => git("log", "--oneline").split("\n").length;
    /** HEAD as session `a`'s commit of mine.txt, then a further edit to fold in. */
    function ownHead(hooks = fakeLedger(0)) {
      writeFileSync(join(repo, "mine.txt"), "first\n");
      commitSession(["mine.txt"], "feat: first", { args: ["--session", "a"], env: hooks.env });
      writeFileSync(join(repo, "mine.txt"), "second\n");
      return hooks;
    }

    it("folds the paths into this session's unpushed HEAD and keeps its message and trailer", () => {
      const hooks = ownHead();

      const result = commitSession(["mine.txt"], "", { args: ["--amend", "--session", "a"], env: hooks.env });

      expect(result.status).toBe(0);
      expect(commits()).toBe(2);
      expect(git("show", "HEAD:mine.txt")).toBe("second");
      expect(git("log", "-1", "--format=%s")).toBe("feat: first");
      expect(git("log", "-1", "--format=%(trailers:key=Session-Id,valueonly)")).toBe("a-full");
    });

    it("rewords without paths when given a message file", () => {
      const hooks = ownHead();
      const messageFile = join(`${repo}-hooks`, "message.txt");
      writeFileSync(messageFile, "feat: reworded\n");

      const result = commitSession([], "", {
        args: ["--amend", "--session", "a", "--message-file", messageFile],
        env: hooks.env,
      });

      expect(result.status).toBe(0);
      expect(git("log", "-1", "--format=%s")).toBe("feat: reworded");
      expect(git("show", "HEAD:mine.txt")).toBe("first");
      expect(git("log", "-1", "--format=%(trailers:key=Session-Id,valueonly)")).toBe("a-full");
    });

    it("refuses another session's commit, a commit without a trailer, and no session at all", () => {
      const hooks = ownHead();
      const other = commitSession(["mine.txt"], "", { args: ["--amend", "--session", "b"], env: hooks.env });
      expect(other.status).toBe(5);
      expect(other.stderr).toContain("a-full");

      git("reset", "-q", "--soft", "HEAD~1");
      git("reset", "-q");
      const base = commitSession(["mine.txt"], "", { args: ["--amend", "--session", "a"], env: hooks.env });
      expect(base.status).toBe(5);
      expect(commitSession(["mine.txt"], "", { args: ["--amend"], env: hooks.env }).status).toBe(1);
    });

    it("refuses a HEAD that is already on a remote-tracking branch", () => {
      const hooks = ownHead();
      git("update-ref", "refs/remotes/origin/main", "HEAD");

      const result = commitSession(["mine.txt"], "", { args: ["--amend", "--session", "a"], env: hooks.env });

      expect(result.status).toBe(5);
      expect(result.stderr).toContain("origin/main");
      expect(git("show", "HEAD:mine.txt")).toBe("first");
    });

    it("refuses a merge commit", () => {
      const hooks = fakeLedger(0);
      git("checkout", "-q", "-b", "side");
      writeFileSync(join(repo, "old.txt"), "side\n");
      git("commit", "-q", "-am", "side");
      git("checkout", "-q", "-");
      git("merge", "-q", "--no-ff", "-m", "merge\n\nSession-Id: a-full", "side");
      writeFileSync(join(repo, "mine.txt"), "after merge\n");

      const result = commitSession(["mine.txt"], "", { args: ["--amend", "--session", "a"], env: hooks.env });

      expect(result.status).toBe(5);
      expect(result.stderr).toContain("merge");
    });
  });

  describe("--worktree", () => {
    /** A linked worktree of the temp repo, the kind a desktop-app worktree session runs in. */
    function linkedWorktree() {
      git("worktree", "add", "-q", `${repo}-wt`, "-b", "wt");
      return `${repo}-wt`;
    }
    const inWorktree = (wt, ...args) =>
      spawnSync("git", args, { cwd: wt, encoding: "utf8" }).stdout.trim();

    it("is refused in a checkout that is not a linked worktree", () => {
      writeFileSync(join(repo, "mine.txt"), "changed\n");

      const result = commitSession([], "test: main", {
        args: ["--worktree", "--session", "a"],
        env: fakeLedger(0).env,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("linked worktree");
      expect(git("log", "--oneline").split("\n")).toHaveLength(1);
    });

    it("commits every changed file when the session wrote them all", () => {
      const wt = linkedWorktree();
      writeFileSync(join(wt, "mine.txt"), "changed\n");
      writeFileSync(join(wt, "new.txt"), "new\n");
      const hooks = fakeLedger(0, "", { files: ["mine.txt", "new.txt"] });

      const result = commitSession([], "test: all", {
        cwd: wt,
        args: ["--worktree", "--session", "a"],
        env: hooks.env,
      });

      expect(result.status).toBe(0);
      expect(inWorktree(wt, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
        "mine.txt",
        "new.txt",
      ]);
      expect(inWorktree(wt, "status", "--porcelain")).toBe("");
      expect(inWorktree(wt, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(2);
    });

    it("names a file the session did not write and commits nothing (exit 4)", () => {
      const wt = linkedWorktree();
      writeFileSync(join(wt, "mine.txt"), "changed\n");
      writeFileSync(join(wt, "theirs.txt"), "someone else\n");
      const hooks = fakeLedger(0, "", { files: ["mine.txt"] });

      const result = commitSession([], "test: stray", {
        cwd: wt,
        args: ["--worktree", "--session", "a"],
        env: hooks.env,
      });

      expect(result.status).toBe(4);
      expect(result.stderr).toContain("theirs.txt");
      expect(inWorktree(wt, "log", "--oneline").split("\n")).toHaveLength(1);
    });

    it("never counts the session's refreshed record as unexpected", () => {
      const wt = linkedWorktree();
      mkdirSync(join(wt, ".claude", "agents"), { recursive: true });
      writeFileSync(join(wt, ".claude", "agents", "x.md"), "agent\n");
      const hooks = fakeLedger(0, "", {
        files: [".claude/agents/x.md"],
        refresh: ["a-full\t.claude/ledger/2026-09-27-a.md"],
      });

      const result = commitSession([], "test: records", {
        cwd: wt,
        args: ["--worktree", "--session", "a"],
        env: hooks.env,
      });

      expect(result.status).toBe(0);
      expect(inWorktree(wt, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
        ".claude/agents/x.md",
        ".claude/ledger/2026-09-27-a.md",
      ]);
    });

    /** Commits `files` in the main checkout first, so the worktree branch starts with them. */
    function worktreeWith(files) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      git("add", ".");
      git("commit", "-q", "-m", "seed");
      return linkedWorktree();
    }

    it("takes a rename inside the SDLC folder as the session's, as the /sdlc-finish archive leaves it", () => {
      const plan = "plan line\n".repeat(10);
      const wt = worktreeWith({ "docs/sdlc/item/plan.md": plan, "docs/sdlc/item/evidence.md": "evidence\n" });
      mkdirSync(join(wt, "docs", "sdlc", "archive"));
      inWorktree(wt, "mv", "docs/sdlc/item", "docs/sdlc/archive/2026-10-24-item");
      writeFileSync(join(wt, "docs/sdlc/archive/2026-10-24-item/plan.md"), `${plan}done\n`);
      // evidence.md moves without an edit, so it is in no --files list.
      const hooks = fakeLedger(0, "", { files: ["docs/sdlc/archive/2026-10-24-item/plan.md"] });

      const result = commitSession([], "test: archive", {
        cwd: wt,
        args: ["--worktree", "--session", "a"],
        env: hooks.env,
      });

      expect(result.stderr).not.toContain("not by this session");
      expect(result.status).toBe(0);
      const shown = inWorktree(wt, "show", "--name-status", "--format=", "-M", "HEAD").split("\n").sort();
      expect(shown).toHaveLength(2);
      expect(shown[0]).toMatch(/^R\d+\tdocs\/sdlc\/item\/plan\.md\tdocs\/sdlc\/archive\/2026-10-24-item\/plan\.md$/);
      expect(shown[1]).toBe("R100\tdocs/sdlc/item/evidence.md\tdocs/sdlc/archive/2026-10-24-item/evidence.md");
      expect(inWorktree(wt, "status", "--porcelain")).toBe("");
    });

    it("still stops on a rename outside the SDLC folder that the session did not write (exit 4)", () => {
      const wt = linkedWorktree();
      inWorktree(wt, "mv", "theirs.txt", "moved.txt");
      const hooks = fakeLedger(0, "", { files: [] });

      const result = commitSession([], "test: stray rename", {
        cwd: wt,
        args: ["--worktree", "--session", "a"],
        env: hooks.env,
      });

      expect(result.status).toBe(4);
      expect(result.stderr).toContain("moved.txt");
    });

    describe("a (done …) mark on another session's record", () => {
      const NAME = ".claude/ledger/2026-10-20-bbbbbbbb.md";
      const RECORD = "---\nid: b\n---\n\n## Next\n\n1. first\n2. second\n\n## Files (1)\n\n- x.md\n";
      const marked = (id8) => RECORD.replace("2. second", `2. (done 2026-10-24 ${id8}) second`);

      function commitMark(text) {
        const wt = worktreeWith({ [NAME]: RECORD });
        writeFileSync(join(wt, NAME), text);
        writeFileSync(join(wt, "mine.txt"), "changed\n");
        const hooks = fakeLedger(0, "", { files: ["mine.txt"] });
        const result = commitSession([], "test: done mark", {
          cwd: wt,
          args: ["--worktree", "--session", "aaaaaaaa-full-id"],
          env: hooks.env,
        });
        return { wt, result };
      }

      it("is the session's when the mark is its own and the only change", () => {
        const { wt, result } = commitMark(marked("aaaaaaaa"));

        expect(result.stderr).not.toContain("not by this session");
        expect(result.status).toBe(0);
        expect(inWorktree(wt, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
          NAME,
          "mine.txt",
        ]);
      });

      it("stops on another session's mark, or any other edit beside it (exit 4)", () => {
        expect(commitMark(marked("cccccccc")).result.status).toBe(4);
        rmSync(`${repo}-wt`, { recursive: true, force: true });
        git("worktree", "prune");
        git("branch", "-q", "-D", "wt");
        const edited = commitMark(marked("aaaaaaaa").replace("1. first", "1. rewritten"));
        expect(edited.result.status).toBe(4);
        expect(edited.result.stderr).toContain(NAME);
      });
    });

    describe("during a merge", () => {
      /**
       * The worktree's branch merges the main checkout's: mine.txt conflicts, theirs.txt merges
       * cleanly and is staged by git, as `git merge <base>` leaves a worktree session.
       */
      function conflictedMerge() {
        const wt = linkedWorktree();
        const base = git("symbolic-ref", "--short", "HEAD");
        writeFileSync(join(repo, "mine.txt"), "base side\n");
        writeFileSync(join(repo, "theirs.txt"), "base only\n");
        git("commit", "-q", "-am", "base work");
        writeFileSync(join(wt, "mine.txt"), "worktree side\n");
        inWorktree(wt, "commit", "-q", "-am", "worktree work");
        inWorktree(wt, "merge", "-q", base);
        return wt;
      }
      const conclude = (wt, hooks, args = []) =>
        commitSession([], "", { cwd: wt, args: ["--worktree", "--session", "a", ...args], env: hooks.env });
      const mergeHead = (wt) =>
        spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: wt }).status === 0;

      it("refuses while a conflicted file still holds its markers (exit 7)", () => {
        const wt = conflictedMerge();

        const result = conclude(wt, fakeLedger(0, "", { files: ["mine.txt"] }));

        expect(result.status).toBe(7);
        expect(result.stderr).toContain("conflict markers still in: mine.txt");
        expect(mergeHead(wt)).toBe(true);
        expect(inWorktree(wt, "log", "-1", "--format=%s")).toBe("worktree work");
      });

      it("refuses a conflicted file this session did not write, and a staged one with markers", () => {
        const wt = conflictedMerge();
        writeFileSync(join(wt, "mine.txt"), "resolved by hand\n");

        const untouched = conclude(wt, fakeLedger(0, "", { files: [] }));
        expect(untouched.status).toBe(7);
        expect(untouched.stderr).toContain("not written by this session: mine.txt");

        const marked = readFileSync(join(wt, "theirs.txt"), "utf8");
        writeFileSync(join(wt, "theirs.txt"), `<<<<<<< HEAD\n${marked}>>>>>>> base\n`);
        inWorktree(wt, "add", "mine.txt", "theirs.txt");
        const staged = conclude(wt, fakeLedger(0, "", { files: [] }));
        expect(staged.status).toBe(7);
        expect(staged.stderr).toContain("conflict markers still in: theirs.txt");
        expect(mergeHead(wt)).toBe(true);
      });

      it("commits the resolved merge with two parents, git's message and the trailers", () => {
        const wt = conflictedMerge();
        writeFileSync(join(wt, "mine.txt"), "both sides\n");
        writeFileSync(join(wt, "unrelated.txt"), "later\n");
        const hooks = fakeLedger(0, "", { files: ["mine.txt"] });

        const result = conclude(wt, hooks, ["--trailer", "Co-Authored-By: X <x@example.com>"]);

        expect(result.status).toBe(0);
        expect(inWorktree(wt, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
        expect(inWorktree(wt, "log", "-1", "--format=%s")).toMatch(/^Merge branch /);
        expect(inWorktree(wt, "log", "-1", "--format=%B")).not.toContain("# Conflicts");
        expect(inWorktree(wt, "log", "-1", "--format=%(trailers:key=Session-Id,valueonly)")).toBe("a-full");
        expect(inWorktree(wt, "log", "-1", "--format=%(trailers:key=Co-Authored-By,valueonly)")).toBe(
          "X <x@example.com>",
        );
        expect(inWorktree(wt, "show", "HEAD:mine.txt")).toBe("both sides");
        expect(inWorktree(wt, "show", "HEAD:theirs.txt")).toBe("base only");
        expect(hooks.args().slice(-2)).toEqual(["--", "mine.txt"]);
        expect(mergeHead(wt)).toBe(false);
        expect(result.stderr).toContain("left uncommitted, not part of the merge: unrelated.txt");
      });

      it("takes a message file over git's merge message", () => {
        const wt = conflictedMerge();
        writeFileSync(join(wt, "mine.txt"), "both sides\n");
        const messageFile = join(`${repo}-hooks`, "message.txt");
        const hooks = fakeLedger(0, "", { files: ["mine.txt"] });
        writeFileSync(messageFile, "chore: merge the base\n");

        const result = conclude(wt, hooks, ["--message-file", messageFile]);

        expect(result.status).toBe(0);
        expect(inWorktree(wt, "log", "-1", "--format=%s")).toBe("chore: merge the base");
        expect(inWorktree(wt, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
      });

      it("is refused without --worktree, and for --amend", () => {
        const wt = conflictedMerge();
        writeFileSync(join(wt, "mine.txt"), "both sides\n");
        const hooks = fakeLedger(0, "", { files: ["mine.txt"] });

        const named = commitSession(["mine.txt"], "test: named", { cwd: wt, args: ["--session", "a"], env: hooks.env });
        expect(named.status).toBe(1);
        expect(named.stderr).toContain("a merge is in progress");
        expect(conclude(wt, hooks, ["--amend"]).status).toBe(5);
        expect(mergeHead(wt)).toBe(true);
      });
    });
  });

  describe("--close-ledger", () => {
    const record = (name) => join(repo, ".claude", "ledger", name);
    const closeLedger = (args = [], cwd = repo) =>
      commitSession([], "chore(ledger): close session records", { cwd, args: ["--close-ledger", ...args] });

    beforeEach(() => {
      mkdirSync(join(repo, ".claude", "ledger"), { recursive: true });
      writeFileSync(record("2026-10-01-old.md"), "old\n");
      writeFileSync(record("2026-10-02-gone.md"), "gone\n");
      git("add", ".claude");
      git("commit", "-q", "-m", "records");
    });

    it("commits the main checkout's dirty records from a linked worktree, and nothing else", () => {
      git("worktree", "add", "-q", `${repo}-wt`, "-b", "wt");
      writeFileSync(record("2026-10-01-old.md"), "old, rewritten\n");
      writeFileSync(record("2026-10-09-new.md"), "new\n");
      unlinkSync(record("2026-10-02-gone.md"));
      writeFileSync(join(repo, ".claude", "ledger", "notes.txt"), "stray\n");
      writeFileSync(join(repo, "theirs.txt"), "staged by another session\n");
      git("add", "theirs.txt");
      writeFileSync(join(`${repo}-wt`, ".claude", "ledger", "2026-10-03-wt.md"), "worktree's own\n");

      const result = closeLedger([], `${repo}-wt`);

      expect(result.status).toBe(0);
      expect(git("log", "-1", "--format=%s")).toBe("chore(ledger): close session records");
      expect(git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
        ".claude/ledger/2026-10-01-old.md",
        ".claude/ledger/2026-10-09-new.md",
      ]);
      expect(result.stderr).toContain("left alone");
      expect(result.stderr).toContain("2026-10-02-gone.md");
      expect(git("diff", "--cached", "--name-only")).toBe("theirs.txt");
      const wtStatus = spawnSync("git", ["status", "--porcelain"], { cwd: `${repo}-wt`, encoding: "utf8" }).stdout;
      expect(wtStatus).toContain("2026-10-03-wt.md");
    });

    it("stops when no record is dirty", () => {
      const result = closeLedger();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("nothing to close");
    });

    it("pushes the main checkout's branch with --push", () => {
      const remote = `${repo}-wt`;
      spawnSync("git", ["init", "-q", "--bare", remote]);
      git("remote", "add", "origin", remote);
      const branch = git("symbolic-ref", "--short", "HEAD");
      git("push", "-q", "origin", branch);
      writeFileSync(record("2026-10-09-new.md"), "new\n");

      const result = closeLedger(["--push"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`pushed ${branch}`);
      expect(spawnSync("git", ["rev-parse", branch], { cwd: remote, encoding: "utf8" }).stdout.trim()).toBe(
        git("rev-parse", "HEAD"),
      );
    });

    it("reports a failed push with exit 6 after committing", () => {
      writeFileSync(record("2026-10-09-new.md"), "new\n");

      const result = closeLedger(["--push"]);

      expect(result.status).toBe(6);
      expect(git("log", "-1", "--format=%s")).toBe("chore(ledger): close session records");
    });

    it("closes a dirty record under archive/ as well", () => {
      mkdirSync(join(repo, ".claude", "ledger", "archive"), { recursive: true });
      writeFileSync(record("archive/2026-06-01-moved.md"), "archived, rewritten\n");

      const result = closeLedger();

      expect(result.status).toBe(0);
      expect(git("show", "--name-only", "--format=", "HEAD")).toBe(".claude/ledger/archive/2026-06-01-moved.md");
      expect(splitLedgerStatus("?? .claude/ledger/archive/2026-06-01-moved.md\0").records).toEqual([
        ".claude/ledger/archive/2026-06-01-moved.md",
      ]);
    });

    it("closes the rename --archive makes with git mv, and still leaves any other rename alone", () => {
      writeFileSync(join(repo, "elsewhere.txt"), "x\n");
      git("add", "elsewhere.txt");
      git("commit", "-q", "-m", "elsewhere");
      mkdirSync(join(repo, ".claude", "ledger", "archive"), { recursive: true });
      git("mv", ".claude/ledger/2026-10-01-old.md", ".claude/ledger/archive/2026-10-01-old.md");
      git("mv", "elsewhere.txt", ".claude/ledger/not-a-record.txt");

      const result = closeLedger();

      expect(result.status).toBe(0);
      expect(git("show", "--name-status", "--format=", "-M", "HEAD").trim()).toBe(
        "R100\t.claude/ledger/2026-10-01-old.md\t.claude/ledger/archive/2026-10-01-old.md",
      );
      expect(result.stderr).toContain("not-a-record.txt");
      expect(splitLedgerStatus("R  .claude/ledger/archive/a.md\0.claude/ledger/a.md\0R  b.md\0a.md\0")).toEqual({
        records: [".claude/ledger/a.md", ".claude/ledger/archive/a.md"],
        leftAlone: ["a.md", "b.md"],
      });
    });

    it("refuses paths, and --push without --close-ledger", () => {
      expect(commitSession(["mine.txt"], "x", { args: ["--close-ledger"] }).status).toBe(1);
      writeFileSync(join(repo, "mine.txt"), "changed\n");
      expect(commitSession(["mine.txt"], "x", { args: ["--push"] }).status).toBe(1);
      expect(git("log", "--oneline").split("\n")).toHaveLength(2);
    });
  });
});

describe("splitLedgerStatus", () => {
  it("keeps added, modified and untracked records, and leaves the rest", () => {
    const status = [
      " M .claude/ledger/a.md",
      "?? .claude/ledger/b.md",
      "A  .claude/ledger/c.md",
      " D .claude/ledger/d.md",
      "?? .claude/ledger/notes.txt",
      "?? .claude/ledger/sub/e.md",
      "R  .claude/ledger/new.md",
      ".claude/ledger/old.md",
    ].join("\0");

    expect(splitLedgerStatus(`${status}\0`)).toEqual({
      records: [".claude/ledger/a.md", ".claude/ledger/b.md", ".claude/ledger/c.md"],
      leftAlone: [
        ".claude/ledger/d.md",
        ".claude/ledger/new.md",
        ".claude/ledger/notes.txt",
        ".claude/ledger/old.md",
        ".claude/ledger/sub/e.md",
      ],
    });
  });
});

describe("holdsCode and auditTail", () => {
  it("counts any path outside the ledger that is not plain documentation as code", () => {
    expect(holdsCode(["src/a.ts"])).toBe(true);
    expect(holdsCode(["Makefile"])).toBe(true);
    expect(holdsCode(["README.md", "docs/x.txt", ".claude/ledger/2026-10-01-a.md"])).toBe(false);
    expect(holdsCode(["notes/ledger/x.json"], "notes/ledger")).toBe(false);
  });

  it("keeps the last lines of a long audit and says how many were cut", () => {
    const output = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
    const tail = auditTail(output, 20);
    expect(tail[0]).toBe("… 5 earlier line(s) cut");
    expect(tail.at(-1)).toBe("line 25");
    expect(auditTail("a\n\nb\n")).toEqual(["a", "b"]);
  });
});

describe("unattributedFiles with kit.json paths", () => {
  it("takes renames inside the configured SDLC folder and own marks in the configured ledger", () => {
    const entries = [
      { code: "R ", path: "work/items/archive/x/plan.md", from: "work/items/x/plan.md" },
      { code: " M", path: "notes/ledger/2026-10-20-bbbbbbbb.md" },
      { code: " M", path: "src/theirs.ts" },
    ];
    const paths = { sdlc: "work/items", ledger: "notes/ledger" };
    expect(unattributedFiles(entries, new Set(), () => true, paths)).toEqual(["src/theirs.ts"]);
    expect(unattributedFiles(entries, new Set(), () => true)).toEqual([
      "notes/ledger/2026-10-20-bbbbbbbb.md",
      "src/theirs.ts",
      "work/items/archive/x/plan.md",
      "work/items/x/plan.md",
    ]);
  });
});
