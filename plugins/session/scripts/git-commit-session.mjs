import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../lib/hook-utils.mjs";
import { escapeRegExp, readKit } from "../lib/kit-config.mjs";
import { doneMarks } from "./ledger-record.mjs";

/**
 * Commit one session's paths in a working tree other sessions share (`git-commit-session` on the
 * Bash PATH, from the plugin's `bin/`):
 *
 *   git-commit-session [--session <id-prefix>]... [--allow-shared <path>]...
 *     [--no-claims] [--message-file <file>] -- <path>...        # message on stdin without --message-file
 *   git-commit-session --worktree --session <id-prefix>... [--message-file <file>]
 *     [--trailer <text>]...                                     # during a merge: concludes it
 *   git-commit-session --amend --session <id-prefix>... [--worktree | -- <path>...]
 *     [--message-file <file>]                                   # keeps HEAD's message without one
 *   git-commit-session --close-ledger [--push] [--message-file <file>]
 *
 * Paths come from the repository's `kit.json`: the ledger folder (`paths.ledger`) and the SDLC
 * items (`paths.sdlc`); `commands.commitAudit` is the audit run after a commit (below).
 *
 * Every session shares one index, so `git add` + `git commit` lets session B's commit carry what
 * session A staged. `git commit --only -- <paths>` commits exactly these paths from the working
 * tree and leaves everyone else's staging as it was. Around it:
 *
 * 1. claims — `session-ledger --conflicts` stops the commit when another session also claims
 *    one of the paths (it cannot be split per file; a person decides). Skipped without a session id,
 *    with `--no-claims`, and in `--close-ledger` (below).
 * 2. `git add -N` for paths git does not know yet, since `--only` rejects an unknown pathspec;
 *    intent-to-add puts no content in the shared index.
 * 3. a held `index.lock` is waited for and retried once, never deleted: it belongs to a live git
 *    process in another session.
 * 4. a path staged as deleted (`git rm --cached`) whose file is still on disk is refused (exit 8):
 *    `--only` takes the path from disk, so the deletion would silently drop out of the commit (or,
 *    alone, end in "nothing to commit").
 *
 * In a linked worktree the session owns, `--worktree` commits everything changed there; this
 * session's `--files` list turns into a check, and a file it did not write stops the commit. A
 * rename inside the SDLC folder (`paths.sdlc`) and the session's own `(done …)` mark on a record
 * count as written (`unattributedFiles`).
 *
 * A merge in progress there (`MERGE_HEAD`) cannot take `--only`, so `--worktree` concludes it
 * instead: it refuses (exit 7) while an unmerged file is one this session did not write, or it or a
 * staged addition still holds a conflict marker; it checks claims on the conflicted paths only,
 * stages them and the session's record, and
 * commits the index as the merge. What the merge brought in is the base's committed work, so the
 * `--files` check does not apply to it; an unstaged edit outside the merge stays uncommitted and
 * is named. Git's merge message is kept unless `--message-file` gives one. Outside a linked
 * worktree a merge is refused: the main checkout's index holds other sessions' staging.
 *
 * `--trailer <text>` adds a trailer, such as the calling session's `Co-Authored-By`, to a message
 * that is kept rather than written, which is how a merge commit gets one.
 *
 * `--amend` folds the paths into HEAD instead of a new commit, with the same claims, `--only` and
 * worktree checks. It rewrites history, so it is refused (exit 5) unless HEAD is this session's own
 * commit (its `Session-Id` trailer), not a merge, and on no remote-tracking branch: an amend never
 * touches another session's work or anything already pushed. Without `--message-file` it keeps
 * HEAD's message and trailers; with one and no paths it only rewords.
 *
 * `--close-ledger` commits the dirty session records (`<paths.ledger>/*.md`, added or modified) of
 * the **main checkout**, wherever it runs: those are records of sessions that never committed, and
 * nobody else commits them. Run from a worktree session it still reaches the main checkout, so the
 * caller never leaves its own tree. Nothing else is committed: another dirty file there, or a deleted record, is
 * named and left alone. No claims and no trailer, since each record is its own session's file.
 * `--push` then pushes the main checkout's branch to `origin`.
 *
 * After a commit with code in it (not `--close-ledger`, not a concluded merge), the project's
 * `kit.json` `commands.commitAudit` runs from the repository root, and its output is printed under
 * a `commit-audit:` line (`auditCommit`). It reports; the exit code stays the commit's. No
 * command set, no audit.
 *
 * An argument before `--` that the script does not take, `-m` included, stops it with the usage
 * (exit 1). Without `--message-file` the message is piped on stdin: a terminal is refused, and stdin
 * still open after `COMMIT_STDIN_TIMEOUT_MS` (10 s) stops the run (`readStdinMessage`).
 *
 * Exit codes: `EXIT_CODES` below; `--help` prints them with this usage.
 */

/** Every exit code, in one place: the header comment and `--help` both point here. */
const EXIT_CODES = [
  [0, "committed"],
  [1, "usage or git error"],
  [2, "shared path: another session also claims one of the paths"],
  [3, "index lock still held by another git process"],
  [
    4,
    "a file changed in the worktree that this session did not write (a rename inside paths.sdlc and its own (done …) mark count as written)",
  ],
  [5, "amend refused: HEAD is not this session's own unpushed, non-merge commit"],
  [6, "committed, but the push failed"],
  [7, "a merge still has an unmerged path or a conflict marker"],
  [8, "a path is staged as deleted but its file is still on disk: delete it from disk first"],
];

const USAGE = `Commit one session's paths in a working tree other sessions share.

  git-commit-session [--session <id-prefix>]... [--allow-shared <path>]...
    [--no-claims] [--message-file <file>] -- <path>...        # message on stdin without --message-file
  git-commit-session --worktree --session <id-prefix>... [--message-file <file>]
    [--trailer <text>]...                                     # during a merge: concludes it
  git-commit-session --amend --session <id-prefix>... [--worktree | -- <path>...]
    [--message-file <file>]                                   # keeps HEAD's message without one
  git-commit-session --close-ledger [--push] [--message-file <file>]

Flags:
  --session <id-prefix>   this session's id (repeatable); defaults to CLAUDE_CODE_SESSION_ID
  --allow-shared <path>   commit a path another session also claims (the user agreed)
  --no-claims             skip the claims check (a --session still gets its trailer)
  --worktree              in a linked worktree: commit everything changed there, or conclude a merge
  --amend                 fold the paths into HEAD (this session's own unpushed, non-merge commit)
  --message-file <file>   the commit message; without it, piped on stdin (a terminal is refused,
                          stdin still open after 10 s stops the run)
  --trailer <text>        add a trailer to the message, a merge's kept one included (not a kept amend, not --close-ledger)
  --close-ledger          commit the main checkout's dirty ledger records (kit.json paths.ledger)
  --push                  after --close-ledger, push that checkout's branch
  --help, -h              print this and exit 0

Any other argument before -- is refused with exit 1; there is no -m, use --message-file.
After a commit with code, kit.json commands.commitAudit runs and its output is shown (never the exit code).

Exit codes:
${EXIT_CODES.map(([code, meaning]) => `  ${code}  ${meaning}`).join("\n")}
`;

// Tests point this at stand-ins, so claims and refresh run without the real ledger.
const HOOKS = process.env.GIT_COMMIT_SESSION_HOOKS_DIR || dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HOOKS, "session-ledger.mjs");
const LOCK_WAIT_MS = Number(process.env.COMMIT_LOCK_WAIT_MS) || 3000;
const LOCK_POLL_MS = 100;
const STDIN_TIMEOUT_MS = Number(process.env.COMMIT_STDIN_TIMEOUT_MS) || 10_000;

/** Repo root: paths are normalized against it and every git call runs there. */
let top = process.cwd();
/** That root's `kit.json`, read again whenever `top` moves (`setTop`). */
let kit = readKit(top);
/** @param {string} dir */
function setTop(dir) {
  top = dir;
  kit = readKit(top);
}

/** @param {string[]} args @param {string} [input] */
function git(args, input) {
  return spawnSync("git", args, { cwd: top, encoding: "utf8", input });
}

function fail(code, message) {
  console.error(`git-commit-session: ${message}`);
  process.exit(code);
}

const gitError = (result) =>
  (result.stderr || result.stdout).trim() || `git exited with ${result.status} (a pre-commit hook?)`;

const VALUE_FLAGS = ["--session", "--allow-shared", "--message-file", "--trailer"];
const SWITCHES = ["--no-claims", "--worktree", "--amend", "--close-ledger", "--push", "--help", "-h"];

/** Why an argument before `--` is refused: the reader would otherwise guess the caller's intent. */
function unknownArgumentProblem(arg) {
  if (/^(-m|--message)(=|$)/.test(arg) || /^-m./.test(arg)) {
    return `unknown flag ${arg}: write the message to a file and pass --message-file <file>`;
  }
  const valueFlag = VALUE_FLAGS.find((flag) => arg.startsWith(`${flag}=`));
  if (valueFlag) return `unknown flag ${arg}: pass ${valueFlag} and its value as two arguments`;
  if (!arg.startsWith("-")) return `unexpected argument ${arg}: paths go after --`;
  return `unknown flag ${arg}`;
}

/**
 * The first argument before `--` the script does not take, or null. An ignored `-m "msg"` once left
 * the message to stdin, an open pipe with no writer in an agent's shell, and the commit hung.
 */
function argumentProblem(options) {
  for (let i = 0; i < options.length; i += 1) {
    const arg = options[i];
    if (SWITCHES.includes(arg)) continue;
    if (!VALUE_FLAGS.includes(arg)) return unknownArgumentProblem(arg);
    if (i + 1 >= options.length) return `${arg} needs a value`;
    i += 1;
  }
  return null;
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const valuesOf = (flag) => options.filter((_, i) => options[i - 1] === flag);
  const sessions = valuesOf("--session");
  return {
    problem: argumentProblem(options),
    paths: separator === -1 ? [] : argv.slice(separator + 1),
    // A resumed session has an old and a new id; both are its own, so pass both.
    sessions: sessions.length ? sessions : [process.env.CLAUDE_CODE_SESSION_ID].filter(Boolean),
    allowShared: valuesOf("--allow-shared"),
    noClaims: options.includes("--no-claims"),
    worktree: options.includes("--worktree"),
    amend: options.includes("--amend"),
    closeLedger: options.includes("--close-ledger"),
    push: options.includes("--push"),
    messageFile: valuesOf("--message-file")[0],
    trailers: valuesOf("--trailer"),
    // Only before the separator: after it, `-h` is a path.
    help: options.includes("--help") || options.includes("-h"),
  };
}

/**
 * Claims are repo-relative with `/`, so `./x`, `sub\\x` on Windows, an absolute path or a run from
 * a subdirectory must be turned into that form, or the check would match nothing and pass.
 */
function normalizePaths(paths) {
  const normalized = paths.map((path) => {
    const rel = relative(top, resolve(process.cwd(), path)).split(sep).join("/");
    if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel))
      fail(1, `not a path inside the repository: ${path}`);
    return rel;
  });
  return [...new Set(normalized)];
}

/**
 * The changed files under the given paths. A directory is committed file by file, so the claims
 * check has to see those files: `zdir` matches no claim, while `zdir/b.txt` may be another
 * session's. Committing this same list keeps the checked set and the committed set one.
 */
function changedFiles(paths) {
  return filesOf(statusEntries(paths));
}

/** @typedef {{ code: string, path: string, from?: string }} StatusEntry `from` only on a rename or copy */

/** @param {string[]} paths @returns {StatusEntry[]} */
function statusEntries(paths) {
  const status = git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...paths]);
  if (status.status !== 0) fail(1, `git status failed: ${gitError(status)}`);
  const raw = status.stdout.split("\0").filter(Boolean);
  const entries = [];
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw[i].slice(0, 2);
    const path = raw[i].slice(3);
    // `R  new\0old`: a staged rename names its original path as the next entry.
    const from = /[RC]/.test(code) && raw[i + 1] !== undefined ? raw[++i] : undefined;
    entries.push(from === undefined ? { code, path } : { code, path, from });
  }
  return entries;
}

/** @param {StatusEntry[]} entries */
const filesOf = (entries) => [...new Set(entries.flatMap(({ path, from }) => (from ? [path, from] : [path])))].sort();

function checkClaims({ sessions, paths, allowShared }) {
  const allow = allowShared.flatMap((path) => ["--allow-shared", ...normalizePaths([path])]);
  const result = spawnSync(process.execPath, [LEDGER, "--conflicts", ...sessions, ...allow, "--", ...paths], {
    cwd: top,
    encoding: "utf8",
  });
  if (result.status === 2) {
    process.stdout.write(result.stdout);
    fail(
      2,
      `shared path(s) above; this session: ${sessions.map((s) => s.slice(0, 8)).join(", ")}; ` +
        "nothing committed. Ask the user, then re-run with --allow-shared <path>.",
    );
  }
  // Fail closed: a check that could not run must not read as "nothing shared".
  if (result.status !== 0) fail(1, `claims check failed: ${gitError(result)}`);
}

/**
 * Bring the session's record up to date from its live transcript and learn the full session ids.
 * The record committed at the end of a turn was rendered at the previous Stop and lacks that
 * turn's edits; the next Stop would add them and leave the tree dirty after the commit.
 * Every prefix must resolve to a session: readers find its commits by the trailer, so a commit
 * without one would silently drop out of the ledger.
 * @returns {{ id: string, record: string | null }[]}
 */
function refreshRecords(sessions) {
  const result = spawnSync(process.execPath, [LEDGER, "--refresh", ...sessions], { cwd: top, encoding: "utf8" });
  if (result.status !== 0) fail(1, `record refresh failed: ${gitError(result)}`);
  const resolved = result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([id]) => id)
    .map(([id, record]) => ({ id, record: record || null }));
  const missing = sessions.filter((prefix) => !resolved.some(({ id }) => id.startsWith(prefix)));
  if (missing.length) fail(1, `no session found for --session ${missing.join(", ")}; nothing committed`);
  return resolved;
}

function lockPath() {
  return resolve(top, git(["rev-parse", "--git-path", "index.lock"]).stdout.trim());
}

/** The script has nothing else to do while it waits, so `Atomics.wait` sleeps the thread between polls. */
function waitForLock() {
  const lock = lockPath();
  const until = Date.now() + LOCK_WAIT_MS;
  while (existsSync(lock) && Date.now() < until)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  return !existsSync(lock);
}

const isLockError = (result) => result.status !== 0 && /index\.lock/.test(result.stderr);

/**
 * Untracked files under the given paths, directories included; `--only` rejects a pathspec git
 * does not know, and a directory would otherwise commit only its tracked files.
 */
function unknownFiles(paths) {
  const listed = git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...paths]);
  return listed.stdout.split("\0").filter(Boolean);
}

/**
 * @param {string[]} paths @param {string | null} message null keeps HEAD's (amend only)
 * @param {Set<string>} added @param {string[]} trailers @param {boolean} amend
 */
function attempt(paths, message, added, trailers, amend) {
  const unknown = unknownFiles(paths).filter((path) => !added.has(path));
  if (unknown.length) {
    const result = git(["add", "-N", "--", ...unknown]);
    if (result.status !== 0) return result;
    for (const path of unknown) added.add(path);
  }
  const text = message === null ? ["--no-edit"] : ["-F", "-", ...trailerArgs(trailers)];
  return git(["commit", "--only", ...(amend ? ["--amend"] : []), ...text, "--", ...paths], message ?? undefined);
}

const trailerArgs = (trailers) => trailers.flatMap((trailer) => ["--trailer", trailer]);

/** A merge stopped by a conflict (or `--no-commit`) keeps `MERGE_HEAD` until it is committed. */
const mergeInProgress = () => git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0;

// A leftover conflict always keeps its `<<<<<<<` and `>>>>>>>` lines; a lone `=======` may be a
// Markdown heading underline.
const CONFLICT_MARKER_SOURCE = "^(<{7}|>{7})( |$)";
const CONFLICT_MARKER = new RegExp(CONFLICT_MARKER_SOURCE);

/** Staged files whose added lines hold a conflict marker: someone ran `git add` too early. */
function stagedWithMarkers() {
  // `-G` narrows to files with a marker line added or removed first: a whole merge's diff can
  // outgrow the output buffer and come back cut short.
  const candidates = git(["diff", "--cached", "--name-only", "-z", "-G", CONFLICT_MARKER_SOURCE, "HEAD"]);
  const files = candidates.stdout.split("\0").filter(Boolean);
  if (!files.length) return [];
  const diff = git([
    "diff",
    "--cached",
    "--no-color",
    "--no-ext-diff",
    "-U0",
    "--dst-prefix=b/",
    "HEAD",
    "--",
    ...files,
  ]);
  const marked = new Set();
  let file = null;
  let inHeader = false;
  // Only a file header's `+++` names the file: an added line `++ x` also starts with `+++`.
  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) inHeader = true;
    else if (line.startsWith("@@")) inHeader = false;
    else if (inHeader && line.startsWith("+++ ")) file = line.startsWith("+++ b/") ? line.slice(6) : null;
    else if (!inHeader && line.startsWith("+") && file && CONFLICT_MARKER.test(line.slice(1))) marked.add(file);
  }
  return [...marked];
}

const hasMarker = (path) => {
  const file = join(top, path);
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf8").split("\n");
  return lines.some((line) => CONFLICT_MARKER.test(line));
};

/**
 * Why the merge cannot be committed yet, or null. An unmerged path counts as resolved only once
 * this session wrote it: a binary or modify/delete conflict leaves no marker to look for, so an
 * untouched one would be committed as git left it. A path resolved by hand is `git add`ed by hand.
 */
function unresolvedReason(unmerged, mine) {
  const untouched = unmerged.filter((path) => !mine.has(path));
  const resolvedButMarked = unmerged.filter((path) => mine.has(path) && hasMarker(path));
  const marked = [...new Set([...resolvedButMarked, ...stagedWithMarkers()])];
  const reasons = [];
  if (untouched.length) reasons.push(`still unmerged, not written by this session: ${untouched.sort().join(", ")}`);
  if (marked.length) reasons.push(`conflict markers still in: ${marked.sort().join(", ")}`);
  return reasons.length ? reasons.join("; ") : null;
}

/** Stages the resolved paths and commits the index as the merge; no `--only`, which git refuses here. */
function attemptMerge(paths, message, trailers) {
  if (paths.length) {
    const staged = git(["add", "-A", "--", ...paths]);
    if (staged.status !== 0) return staged;
  }
  // `strip` drops the `# Conflicts:` list git leaves in its merge message; a given message is kept as written.
  const text = message === null ? ["--no-edit", "--cleanup=strip"] : ["-F", "-"];
  return git(["commit", ...text, ...trailerArgs(trailers)], message ?? undefined);
}

function concludeMerge(options) {
  if (options.amend) refuseAmend("a merge is in progress");
  if (!options.worktree) {
    fail(1, "a merge is in progress; conclude it with --worktree --session from the worktree session that owns it");
  }
  const unmerged = git(["diff", "--name-only", "-z", "--diff-filter=U"]).stdout.split("\0").filter(Boolean);
  const unresolved = unresolvedReason(unmerged, sessionFiles(options.sessions));
  if (unresolved) fail(7, `${unresolved}; nothing committed. Resolve them, then run this again.`);
  const message = options.messageFile ? readMessage(options) : null;
  const sessions = prepareSessions(options, unmerged);
  const recordPaths = sessions.flatMap((s) => (s.record ? [s.record] : []));
  const records = recordPaths.length ? changedFiles(recordPaths) : [];
  const trailers = [...sessions.map((s) => `Session-Id: ${s.id}`), ...options.trailers];
  commitWithRetry(() => attemptMerge([...new Set([...unmerged, ...records])], message, trailers));
  const left = changedFiles(["."]);
  if (left.length) console.error(`git-commit-session: left uncommitted, not part of the merge: ${left.join(", ")}`);
}

function refuseAmend(reason) {
  fail(5, `amend refused: ${reason}; nothing committed. Make a new commit instead.`);
}

/** Checks that need no session id: an amend of published history or of a merge is never safe. */
function checkAmendableHead() {
  if (git(["rev-parse", "--verify", "-q", "HEAD"]).status !== 0) refuseAmend("there is no commit to amend");
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(" ");
  if (parents.length > 2) refuseAmend("HEAD is a merge commit");
  const published = git(["branch", "-r", "--contains", "HEAD"]).stdout.trim();
  if (published) refuseAmend(`HEAD is already on ${published.split("\n")[0].trim()}`);
}

/** HEAD must carry one of this session's ids, or the amend would rewrite another session's commit. */
function checkHeadIsOwn(sessions) {
  const trailer = git(["log", "-1", "--format=%(trailers:key=Session-Id,valueonly,separator=%x2C)"]).stdout.trim();
  const ids = trailer ? trailer.split(",") : [];
  if (!sessions.some(({ id }) => ids.includes(id))) {
    refuseAmend(`HEAD's Session-Id is ${ids.join(", ") || "missing"}, not this session's`);
  }
}

/** A linked worktree has its own git dir inside the main repository's common one. */
function isLinkedWorktree() {
  const dir = (flag) => resolve(top, git(["rev-parse", flag]).stdout.trim());
  return dir("--git-dir") !== dir("--git-common-dir");
}

/**
 * What this session may commit from its worktree: the paths it wrote (`--files`). Its own record
 * is in `--files` already, and a refreshed one is added after the check.
 */
function sessionFiles(sessions) {
  const listed = spawnSync(process.execPath, [LEDGER, "--files", ...sessions], { cwd: top, encoding: "utf8" });
  if (listed.status !== 0) fail(1, `session file list failed: ${gitError(listed)}`);
  return new Set(listed.stdout.split("\n").filter(Boolean));
}

/**
 * The changed files this session did not write. Two edits are its own although `--files` cannot
 * show them: a staged rename, when either side is a path it wrote or both sides are under the SDLC
 * folder (the `/sdlc-finish` archive `git mv`s an item's untouched files too), and another
 * session's record whose only change is this session's own `(done <date> <id8>)` mark
 * (`--done … --as`). Pure, so it can be tested; `ownMark(path)` reads the record.
 * @param {StatusEntry[]} entries @param {Set<string>} mine @param {(path: string) => boolean} ownMark
 * @param {{ sdlc?: string, ledger?: string }} [paths] `kit.json` `paths`; defaults as in the schema
 */
export function unattributedFiles(entries, mine, ownMark, { sdlc = "docs/sdlc", ledger = ".claude/ledger" } = {}) {
  const unexpected = [];
  const record = ledgerRecordPattern(ledger);
  for (const { code, path, from } of entries) {
    if (from !== undefined && code.includes("R")) {
      const archived = path.startsWith(`${sdlc}/`) && from.startsWith(`${sdlc}/`);
      if (!(mine.has(path) || mine.has(from) || archived)) unexpected.push(path, from);
      continue;
    }
    const marked = !/[^ M]/.test(code) && record.test(path) && ownMark(path);
    for (const file of from === undefined ? [path] : [path, from])
      if (!mine.has(file) && !marked) unexpected.push(file);
  }
  return [...new Set(unexpected)].sort();
}

/** Whether the record's only change since HEAD is a `(done …)` mark signed by one of these sessions. */
function isOwnDoneMark(path, sessions) {
  const before = git(["show", `HEAD:${path}`]);
  if (before.status !== 0 || !existsSync(join(top, path))) return false;
  const ids = doneMarks(before.stdout, readFileSync(join(top, path), "utf8"));
  return Boolean(ids?.every((id8) => sessions.some((session) => id8 === session.slice(0, 8))));
}

/** @param {StatusEntry[]} entries @param {string[]} sessions */
function checkWorktreeFiles(entries, sessions) {
  const unexpected = unattributedFiles(
    entries,
    sessionFiles(sessions),
    (path) => isOwnDoneMark(path, sessions),
    kit.paths,
  );
  if (unexpected.length) {
    fail(
      4,
      `changed in this worktree but not by this session: ${unexpected.join(", ")}; nothing committed. ` +
        "Commit them by name without --worktree, or undo them.",
    );
  }
}

const hasSession = (options) => options.sessions.length > 0;

/** Flag combinations that are wrong before anything is read: [broken?, usage message]. */
const USAGE_RULES = [
  [
    (o) => o.closeLedger && (o.paths.length > 0 || o.worktree || o.amend || o.allowShared.length > 0),
    "--close-ledger takes no paths and no --worktree, --amend or --allow-shared: it commits the main checkout's records",
  ],
  [(o) => o.push && !o.closeLedger, "--push is only for --close-ledger; push a session's commit with git push"],
  [(o) => o.worktree && o.paths.length > 0, "--worktree takes no paths: it commits everything changed"],
  [(o, reword) => !o.worktree && !o.closeLedger && o.paths.length === 0 && !reword, "no paths; pass them after --"],
  [(o) => o.amend && !hasSession(o), "--amend needs --session: only this session's own commit may be amended"],
  [
    (o) => o.trailers.length > 0 && (o.closeLedger || (o.amend && !o.messageFile)),
    "--trailer has nothing to add to: --close-ledger writes none, and a kept amend message keeps HEAD's",
  ],
  [(o) => o.worktree && !hasSession(o), "--worktree needs --session to check the files"],
];

function checkUsage(options, reword) {
  const broken = USAGE_RULES.find(([isBroken]) => isBroken(options, reword));
  if (broken) fail(1, broken[1]);
}

/** Finds the repository root that every later git call runs in. */
function enterRepository(options) {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (root.status !== 0) fail(1, "not inside a git repository");
  setTop(resolve(root.stdout.trim()));
  // The main checkout is shared: "everything changed" there includes other sessions' work.
  if (options.worktree && !isLinkedWorktree()) {
    fail(1, "--worktree needs a linked worktree; in the main checkout, name the paths");
  }
}

/** Where to look for changes: the whole worktree, the named paths, or nowhere for a reword. */
function pathScope(options) {
  if (options.worktree) return ["."];
  return options.paths.length ? normalizePaths(options.paths) : [];
}

/**
 * Paths deleted in the index whose file is still on disk, usually an ignored file untracked with
 * `git rm --cached`. `--only` commits each path as the working tree has it, so it would keep the
 * file tracked; a temporary index could commit the deletion, but deleting the file is the user's call.
 * @param {StatusEntry[]} entries
 */
function cachedDeletionsOnDisk(entries) {
  const kept = entries.filter(({ code, path }) => code[0] === "D" && existsSync(join(top, path)));
  return [...new Set(kept.map(({ path }) => path))].sort();
}

/** The changed files to commit: the named paths, or everything changed in this session's worktree. */
function collectPaths(options, reword) {
  const scope = pathScope(options);
  const entries = scope.length ? statusEntries(scope) : [];
  const paths = filesOf(entries);
  if (paths.length === 0) {
    if (!reword) fail(1, `nothing changed under: ${options.paths.join(" ") || "this worktree"}`);
    return paths;
  }
  const keptOnDisk = cachedDeletionsOnDisk(entries);
  if (keptOnDisk.length) {
    fail(
      8,
      `staged as deleted but still on disk: ${keptOnDisk.join(", ")}; --only would commit them from disk and drop ` +
        "the deletion. Delete them from disk (or move them out of the repository), then run this again; nothing committed.",
    );
  }
  if (options.worktree) checkWorktreeFiles(entries, options.sessions);
  return paths;
}

/**
 * The message from stdin, which must be piped in and closed. A terminal would wait for someone to
 * type; an agent's shell hands over an open pipe nobody writes to, which `readFileSync(0)` waits on
 * forever. A child process reads it instead, so a
 * synchronous timeout can stop the wait; a heredoc or `printf |` closes it within milliseconds.
 */
function readStdinMessage() {
  if (isatty(0)) {
    fail(
      1,
      "no --message-file, and stdin is a terminal; pass --message-file <file> or pipe the message in; nothing committed",
    );
  }
  const read = spawnSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(0))"], {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    timeout: STDIN_TIMEOUT_MS,
  });
  if (read.error?.code === "ETIMEDOUT") {
    fail(
      1,
      `no --message-file, and stdin was still open after ${STDIN_TIMEOUT_MS / 1000} s with no end of input; ` +
        "pass --message-file <file>; nothing committed",
    );
  }
  if (read.status !== 0) fail(1, `could not read the message from stdin: ${gitError(read)}`);
  return read.stdout;
}

/** The commit message, or null when an amend keeps HEAD's (it then reads no stdin). */
function readMessage(options) {
  if (options.amend && !options.messageFile) return null;
  const message = options.messageFile ? readFileSync(options.messageFile, "utf8") : readStdinMessage();
  if (!message.trim()) fail(1, "empty commit message");
  return message;
}

/**
 * Claims, record refresh and the amend's ownership check; returns the resolved sessions.
 * `--no-claims` skips the claims check only: a named session still gets its `Session-Id` trailer,
 * or its own `--amend` would later refuse the commit as not its own.
 */
function prepareSessions(options, paths) {
  if (!options.sessions.length) {
    if (!options.noClaims) console.error("git-commit-session: claims not checked (no session id)");
    return [];
  }
  if (paths.length && !options.noClaims) checkClaims({ ...options, paths });
  const sessions = refreshRecords(options.sessions);
  if (options.amend) checkHeadIsOwn(sessions);
  return sessions;
}

/** Two tries, waiting out another process's index lock before each; null when the lock never freed. */
function attemptWithRetry(run) {
  let result = null;
  for (let tries = 0; tries < 2; tries += 1) {
    if (!waitForLock()) continue;
    result = run();
    if (!isLockError(result)) break;
  }
  return result;
}

/**
 * Commits through `run`, or exits with the reason; the intent-to-add entries `run` records in
 * `added` never outlive a failure.
 */
function commitWithRetry(run, added = new Set()) {
  const result = attemptWithRetry(run);
  if (result?.status === 0) {
    console.log(`committed ${git(["log", "-1", "--format=%h %s"]).stdout.trim()}`);
    return;
  }
  // Left behind, a later `git add -u` or `commit -a` would take the files along.
  if (added.size) git(["rm", "--cached", "-q", "--", ...added]);
  if (result === null || isLockError(result)) {
    fail(3, `${lockPath()} is still held by another git process; nothing committed, lock left in place`);
  }
  fail(1, gitError(result));
}

/** Paths that are never code: the ledger and plain documentation. A commit of only these skips the audit. */
const DOC_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
const AUDIT_TIMEOUT_MS = 120_000;
const MAX_AUDIT_LINES = 20;

/**
 * Whether a commit holds code, so `commands.commitAudit` has something to look at: any committed
 * path outside the ledger folder that is not a plain documentation file. Pure, so it can be tested.
 * @param {string[]} paths repo-relative @param {string} [ledger] `kit.json` `paths.ledger`
 */
export function holdsCode(paths, ledger = ".claude/ledger") {
  return paths.some((path) => !path.startsWith(`${ledger}/`) && !DOC_FILE.test(path));
}

/**
 * The last `max` non-empty lines of an audit's output, with a count of what was cut. Pure.
 * @param {string} output @param {number} [max]
 */
export function auditTail(output, max = MAX_AUDIT_LINES) {
  const lines = String(output).split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length <= max) return lines;
  return [`… ${lines.length - max} earlier line(s) cut`, ...lines.slice(-max)];
}

/**
 * The project's `kit.json` `commands.commitAudit` on the commit just made, from the repository
 * root, through the shell (it is the project's own command line). The committed paths are in
 * `KIT_COMMIT_PATHS`, one per line, for an audit that can narrow to them: the working tree may
 * hold other sessions' changes. Reported under a `commit-audit:` line, never in the exit code.
 * Skipped when the project sets no such command or the commit holds no code.
 * @param {string[]} paths the committed paths
 */
function auditCommit(paths) {
  const command = kit.commands.commitAudit;
  if (!command || !holdsCode(paths, kit.paths.ledger)) return;
  const started = Date.now();
  const run = spawnSync(command, {
    cwd: top,
    shell: true,
    encoding: "utf8",
    timeout: AUDIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, KIT_COMMIT_PATHS: paths.join("\n") },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (run.error) {
    const why = run.error.code === "ETIMEDOUT" ? `timed out after ${AUDIT_TIMEOUT_MS / 1000} s` : run.error.message;
    console.log(`commit-audit: ${command} did not finish (${why}); this commit was not audited`);
    return;
  }
  // 127 is the shell's "command not found": the tool is not installed on this machine.
  if (run.status === 127) {
    console.log(`commit-audit: ${command} is not installed here; this commit was not audited`);
    return;
  }
  console.log(`commit-audit: ${command} (exit ${run.status}, ${seconds} s)`);
  for (const line of auditTail(`${run.stdout ?? ""}${run.stderr ?? ""}`)) console.log(`  ${line}`);
}

/**
 * A record lives in the ledger folder or, once `session-ledger --archive` moved it, in `archive/`.
 * @param {string} ledger repo-relative ledger folder
 */
function ledgerRecordPattern(ledger) {
  return new RegExp(`^${escapeRegExp(ledger)}/(?:archive/)?[^/]+\\.md$`);
}

/** The main checkout is the first entry of `git worktree list`, from any of its worktrees. */
function enterMainCheckout() {
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (listed.status !== 0) fail(1, "not inside a git repository");
  const main = listed.stdout.match(/^worktree (.+)$/m)?.[1];
  if (!main) fail(1, "git worktree list names no main checkout");
  setTop(resolve(main));
}

/**
 * Dirty records in the ledger folder and its `archive/` split into what may be closed (added,
 * modified, untracked records, and a record renamed into `archive/`) and what is left alone (other
 * files, deletions, other renames). Pure, so it can be tested.
 * @param {string} porcelainZ `git status --porcelain -z` output
 * @param {string} [ledger] `kit.json` `paths.ledger`
 */
export function splitLedgerStatus(porcelainZ, ledger = ".claude/ledger") {
  const record = ledgerRecordPattern(ledger);
  const entries = porcelainZ.split("\0").filter(Boolean);
  const records = [];
  const leftAlone = [];
  for (let i = 0; i < entries.length; i += 1) {
    const code = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    if (/[RC]/.test(code)) {
      const from = entries[++i];
      // `--archive` moves a record into `archive/` with `git mv`; `--only` with both paths commits
      // the rename. Any other rename or copy is someone else's work.
      const intoArchive = path.startsWith(`${ledger}/archive/`) && record.test(path) && record.test(from);
      if (code.includes("R") && intoArchive) records.push(path, from);
      else leftAlone.push(path, from);
      continue;
    }
    if (record.test(path) && !code.includes("D")) records.push(path);
    else leftAlone.push(path);
  }
  return { records: records.sort(), leftAlone: leftAlone.filter(Boolean).sort() };
}

function closeLedger(options) {
  enterMainCheckout();
  const ledger = kit.paths.ledger;
  const status = git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ledger]);
  if (status.status !== 0) fail(1, `git status failed: ${gitError(status)}`);
  const { records, leftAlone } = splitLedgerStatus(status.stdout, ledger);
  if (leftAlone.length) console.error(`git-commit-session: left alone in ${top}: ${leftAlone.join(", ")}`);
  if (records.length === 0) fail(1, `no dirty session records in ${top}; nothing to close`);
  const message = readMessage(options);
  const added = new Set();
  commitWithRetry(() => attempt(records, message, added, [], false), added);
  if (!options.push) return;
  const branch = git(["symbolic-ref", "--short", "-q", "HEAD"]).stdout.trim();
  if (!branch) fail(6, `committed, not pushed: ${top} is on a detached HEAD`);
  const pushed = git(["push", "origin", branch]);
  if (pushed.status !== 0) fail(6, `committed, but pushing ${branch} failed: ${gitError(pushed)}`);
  console.log(`pushed ${branch} to origin`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.problem) {
    console.error(`git-commit-session: ${options.problem}; nothing committed\n`);
    process.stderr.write(USAGE);
    process.exit(1);
  }
  // Before any git call, so it also answers outside a repository.
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const reword = options.amend && Boolean(options.messageFile);
  checkUsage(options, reword);
  if (options.closeLedger) return closeLedger(options);
  enterRepository(options);
  if (mergeInProgress()) return concludeMerge(options);
  if (options.amend) checkAmendableHead();
  const changed = collectPaths(options, reword);
  const message = readMessage(options);
  const sessions = prepareSessions(options, changed);
  const recordPaths = sessions.flatMap((s) => (s.record ? [s.record] : []));
  const records = recordPaths.length ? changedFiles(recordPaths) : [];
  const paths = [...new Set([...changed, ...records])].sort();
  // Readers find a session's commits by this trailer; records no longer store them. A kept message
  // already carries it.
  const trailers = message === null ? [] : [...sessions.map((s) => `Session-Id: ${s.id}`), ...options.trailers];
  const added = new Set();
  commitWithRetry(() => attempt(paths, message, added, trailers, options.amend), added);
  auditCommit(paths);
}

if (isDirectRun(import.meta.url)) main();
