/**
 * Paths two sessions claim at once (testable). Sessions share one working tree, and ownership is
 * per file: when two of them edited the same file, whichever commits first takes the other's
 * edits along. `git commit --only` keeps a commit to its own paths but cannot split a file, so a
 * shared path is the one case a person has to decide.
 *
 * `session-ledger.mjs --conflicts` feeds this from transcripts and records; nothing here reads
 * the disk or runs git.
 *
 * Whether a claim is still open comes from git, not from spotting a commit in the transcript:
 * commits now run through a script or inside the `/git` fork's own transcript, and often take
 * only some of a session's paths. A path is still a session's work while no commit touched it
 * after that session last edited it.
 */

/** A transcript written to this recently belongs to a session that may still be open, whose record can lag. */
export const LIVE_TRANSCRIPT_HOURS = 48;

/**
 * An older record still flagged `uncommitted` claims its dirty paths for this long. Longer, and an
 * abandoned session blocks commits on shared files such as `CHANGELOG.md` for good; the stop then
 * asks rather than refuses, and `--allow-shared` settles it.
 */
export const UNCOMMITTED_RECORD_DAYS = 14;

/**
 * Git stores commit times in whole seconds, so an edit and a commit in the same second compare as
 * committed: a stale claim would stop the next commit, a missed one only in that one-second race.
 * @param {number} editedAtMs @param {number | null} lastCommitSec `git log -1 --format=%ct -- <path>`
 */
export function claimStillOpen(editedAtMs, lastCommitSec) {
  return lastCommitSec === null || lastCommitSec < Math.floor(editedAtMs / 1000);
}

/**
 * Whether a record's claim on `path` is history because the session's work already sits in the
 * history being committed on. The edit-time test alone misses this: a `git merge` in the session's
 * worktree rewrites files that the ledger attributes to it by mtime, and `git log --name-only`
 * lists no files for a merge commit, so such a claim never closed (c593a7ce: `run-checks.yml`).
 *
 * Landed means: the session ran on another branch than this checkout's (the same branch may be
 * the same working tree, whose uncommitted edits the commit would take), at least one commit
 * carries its `Session-Id` and none of them is outside `HEAD`, and no tree that may still hold
 * its edits has `path` dirty: the tree the session ran in, whatever branch that tree is on now (a
 * checkout that switched branches carries its dirty files along, and that checkout may be this
 * one), and the worktree now on the session's branch. A tree that is no longer a worktree holds
 * nothing. Without its transcript the session's tree is unknown, so a worktree on its branch keeps
 * the claim even when clean: the edits may sit in a tree that switched away.
 * @param {{ id: string, branch?: string }} record
 * @param {string} path
 * @param {{
 *   currentBranch: string | null,
 *   hasCommits: (id: string) => boolean,
 *   unmerged: Set<string>,
 *   sessionTree: (id: string) => string | null,
 *   branchTree: (branch: string) => string | null,
 *   dirtyIn: (tree: string) => Set<string> | null,
 * }} git `unmerged`: session ids with a commit not reachable from `HEAD`; `sessionTree`: the tree
 *   the session's transcript ran in, null when no transcript is found; `branchTree`: the worktree
 *   checked out on that branch, null when none is; `dirtyIn` is null when that tree's status could
 *   not be read, which keeps the claim.
 */
export function landedElsewhere(
  record,
  path,
  { currentBranch, hasCommits, unmerged, sessionTree, branchTree, dirtyIn },
) {
  const branch = record.branch;
  if (!branch || branch === "unknown" || branch === "HEAD" || branch === currentBranch) return false;
  if (!hasCommits(record.id) || unmerged.has(record.id)) return false;
  const tree = sessionTree(record.id);
  const onBranch = branchTree(branch);
  if (tree === null && onBranch !== null) return false;
  for (const root of new Set([tree, onBranch])) {
    if (root === null) continue;
    const dirty = dirtyIn(root);
    if (dirty === null || dirty.has(path)) return false;
  }
  return true;
}

/**
 * Other sessions' open claims on `own`. A live transcript is fresher than its record, so it wins
 * even when it claims nothing. An older session is judged by its record: a settled one by each
 * path's stored edit time, an older one only while flagged `uncommitted`, bounded by its last write.
 * A record whose work has landed in `HEAD` claims nothing (`landed`, see `landedElsewhere`).
 * @param {{
 *   own: string[],
 *   ownPrefixes: string[],
 *   now: number,
 *   transcripts: { id: string, mtimeMs: number, editedAt: () => Map<string, string> | null }[],
 *   records: { id: string, label?: string, branch?: string, day: string, mtimeMs: number, flags: string[], pending: string[], editedAt?: Map<string, string> }[],
 *   lastCommitSec: (path: string) => number | null,
 *   landed?: (record: { id: string, branch?: string }, path: string) => boolean,
 * }} input
 * @returns {SessionClaim[]}
 */
export function collectClaims({ own, ownPrefixes, now, transcripts, records, lastCommitSec, landed = () => false }) {
  const wanted = new Set(own);
  const isOwn = (id) => ownPrefixes.some((prefix) => id.startsWith(prefix));
  const labels = new Map(records.map((r) => [r.id, r.label]));
  const live = new Set();
  const claims = [];
  for (const transcript of transcripts) {
    if (isOwn(transcript.id) || now - transcript.mtimeMs > LIVE_TRANSCRIPT_HOURS * 3_600_000) continue;
    const editedAt = transcript.editedAt();
    if (!editedAt) continue;
    live.add(transcript.id);
    const paths = [...editedAt]
      .filter(([path, at]) => wanted.has(path) && claimStillOpen(Date.parse(at), lastCommitSec(path)))
      .map(([path]) => path);
    if (paths.length) claims.push({ id: transcript.id, label: labels.get(transcript.id), paths });
  }
  for (const record of records) {
    if (isOwn(record.id) || live.has(record.id)) continue;
    if (now - Date.parse(record.day) > UNCOMMITTED_RECORD_DAYS * 86_400_000) continue;
    // A settled record stores each path's edit time and no `uncommitted` flag; an older one is
    // judged by its flag, its stored pending list and the file's last write.
    const settled = record.editedAt?.size > 0;
    if (!settled && !record.flags.includes("uncommitted")) continue;
    const editedAt = (path) => (settled ? Date.parse(record.editedAt.get(path) ?? "") : record.mtimeMs);
    const paths = record.pending.filter(
      (path) =>
        wanted.has(path) &&
        !Number.isNaN(editedAt(path)) &&
        claimStillOpen(editedAt(path), lastCommitSec(path)) &&
        !landed(record, path),
    );
    if (paths.length) claims.push({ id: record.id, label: record.label, paths });
  }
  return claims;
}

/**
 * A session's files that are still its work: dirty, and no commit touched them since its edit.
 * `uncommitted` is this list being non-empty, computed when a record is read, never stored.
 * @param {{ path: string, at: string }[]} files @param {(path: string) => number | null} lastCommitSec
 * @param {Set<string>} dirty
 */
export function openPaths(files, lastCommitSec, dirty) {
  return files
    .filter(({ path, at }) => dirty.has(path) && claimStillOpen(Date.parse(at), lastCommitSec(path)))
    .map(({ path }) => path);
}

/**
 * One `git log` pass, newest first:
 * `--format=%x00%h %ct%x09%(trailers:key=Session-Id,valueonly,separator=%x2C) --name-only`.
 * Gives each path's newest commit time and each session's commits by its `Session-Id` trailer,
 * so the brief and the index need no `git log` per path.
 * @param {string} text
 */
export function parseCommitLog(text) {
  /** @type {Map<string, number>} */
  const lastCommit = new Map();
  /** @type {Map<string, string[]>} */
  const commitsBySession = new Map();
  for (const block of text.split("\0").slice(1)) {
    const [head = "", ...rest] = block.split("\n");
    const [hashAndTime, ids = ""] = head.split("\t");
    const [hash, time] = hashAndTime.split(" ");
    for (const path of rest.map((line) => line.trim()).filter(Boolean)) {
      // Newest first in log order, but machines' clocks drift: keep the largest time seen.
      lastCommit.set(path, Math.max(lastCommit.get(path) ?? 0, Number(time)));
    }
    for (const id of ids
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      commitsBySession.set(id, [...(commitsBySession.get(id) ?? []), hash]);
    }
  }
  return { lastCommit, commitsBySession };
}

/**
 * @typedef {{ id: string, label?: string, paths: string[] }} SessionClaim
 * @param {string[]} own Paths this commit is about to take.
 * @param {SessionClaim[]} others Other sessions' open claims.
 * @param {Set<string>} dirty Paths `git status` shows as changed; a claim on a clean path is history.
 * @param {Set<string>} [allowed] Paths the user already let through.
 * @returns {{ path: string, sessions: { id: string, label?: string }[] }[]}
 */
export function sharedPaths(own, others, dirty, allowed = new Set()) {
  const shared = [];
  for (const path of [...new Set(own)].sort()) {
    if (!dirty.has(path) || allowed.has(path)) continue;
    const sessions = new Map();
    for (const other of others) {
      if (other.paths.includes(path) && !sessions.has(other.id)) {
        sessions.set(other.id, { id: other.id, label: other.label });
      }
    }
    if (sessions.size) shared.push({ path, sessions: [...sessions.values()] });
  }
  return shared;
}

/** One line per shared path: what the commit caller prints and the user answers. */
export function formatShared(shared) {
  return shared.map(({ path, sessions }) => {
    const who = sessions.map((s) => (s.label ? `${s.id.slice(0, 8)} (${s.label})` : s.id.slice(0, 8)));
    return `${path}\talso claimed by ${who.join(", ")}`;
  });
}
