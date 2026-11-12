// Ledger-specific hook helpers: commit facts from git, the shell-edit tracker that attributes a
// shell call's writes to the session, and the deletion snapshots core's `shell-deletions` hook logs.
// Moved here from the source projects' `hook-utils.mjs`; the generic helpers are in
// `../lib/hook-utils.mjs` (vendored from `shared/`).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EDIT_TOOLS,
  SHELL_TOOLS,
  gitDirtyFiles,
  projectRoot,
  readTranscriptLines,
  repoRelativePath,
  shellDeletionsLog,
} from "../lib/hook-utils.mjs";
import { parseCommitLog } from "./ledger-claims.mjs";
import { globToRegExp, shellWriteTargets } from "../lib/shell-edits.mjs";

/**
 * Slack around a shell command's run window when matching file mtimes: the transcript stamps
 * the call before the process starts and the result after it ends, and file systems round.
 */
const WINDOW_SLACK_MS = 1500;

/**
 * How far back `readCommitFacts` reads last-commit times. An edit older than the window's start
 * reads as closed (`sinceSec` stands in for its last commit): a settled record that old is history,
 * and calling it `uncommitted` because the file is dirty again would be the stale claim item 1 fixed.
 */
export const COMMIT_FACTS_DAYS = 90;

/**
 * Two `git log` passes: each path's newest commit time on HEAD within the window, and each
 * session's commits by `Session-Id` trailer on every branch, with no window, so a record's commits
 * are found wherever they landed. `core.quotePath=false` keeps non-ASCII paths as they are in
 * records. Empty results when git fails.
 *
 * A merge commit counts for the paths it changed against its first parent: plain `--name-only`
 * lists none for a merge, so a conflict a session resolved, which only the merge commit took, would
 * read as never committed and stay a claim.
 * @param {string} [root]
 */
export function readCommitFacts(root = projectRoot()) {
  const run = (args) => {
    const log = spawnSync("git", ["-c", "core.quotePath=false", "log", ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return log.status === 0 ? log.stdout : "";
  };
  const sinceSec = Math.floor(Date.now() / 1000) - COMMIT_FACTS_DAYS * 86_400;
  const { lastCommit } = parseCommitLog(
    run([`--since=${sinceSec}`, "--format=%x00%h %ct%x09", "--name-only", "--diff-merges=first-parent"]),
  );
  const { commitsBySession } = parseCommitLog(
    run(["--all", "--format=%x00%h %ct%x09%(trailers:key=Session-Id,valueonly,separator=%x2C)"]),
  );
  return { lastCommit, commitsBySession, sinceSec };
}

/**
 * Attribution of shell-made edits for one transcript. Feed it every `tool_use` and
 * `tool_result` block in order, then `resolve()` against the dirty files.
 *
 * Three confidence levels, kept apart so a record can say which one it used:
 * - a path the command names (`> file`, `sed -i … file`, `pnpm add`) is attributed outright, and
 *   so is a dirty file that no longer exists under a path or pattern the command removes
 *   (`git rm -r dir`, `rm dir/*.md`): a deletion leaves no mtime for the window test;
 * - a glob or directory the command writes into is attributed only for dirty files that match
 *   it *and* whose mtime falls inside that command's run window;
 * - an opaque command (`node script.mjs`, `pnpm run …`, `git stash pop`, a `sed -i` over `"$f"`) is
 *   attributed only dirty files whose mtime falls inside its run window. A tracked file it deleted
 *   has no mtime, so it is attributed only when core's `shell-deletions` hook saw it go missing
 *   between the call's start and end (`deletions`, from `readShellDeletions`);
 * - a `git merge`, `pull`, `rebase` or `cherry-pick` is attributed nothing: what it writes is
 *   others' committed work, left dirty only while a conflict stops it. The session's resolution
 *   is credited to the call that makes it. A call that also runs something opaque keeps its window.
 * The window test is what keeps a neighbour session's edit out when the working tree is shared:
 * a file another session wrote before or after this command keeps its own mtime.
 */
export function createShellEditTracker() {
  /** @type {Map<string, { at: string, call: string }>} absolute path → last command naming it */
  const named = new Map();
  /** @type {Map<string, { at: string, call: string }>} absolute path or pattern → last command removing it */
  const removed = new Map();
  /** @type {Map<string, { from: string, to: string | null, globs: string[], opaque: boolean }>} */
  const calls = new Map();

  return {
    /** @returns {boolean} whether the block was a shell call */
    onToolUse(block, entry) {
      if (!SHELL_TOOLS.has(block.name)) return false;
      const command = block.input?.command;
      if (typeof command !== "string") return true;
      const at = entry.timestamp ?? "";
      const targets = shellWriteTargets(command, {
        cwd: typeof entry.cwd === "string" ? entry.cwd : process.cwd(),
        powershell: block.name === "PowerShell",
      });
      if (targets.files.length === 0 && targets.globs.length === 0 && targets.removed.length === 0 && !targets.opaque)
        return true;
      calls.set(block.id, { from: at, to: null, globs: targets.globs, opaque: targets.opaque });
      // Sub-agent lines are read after the parent's, so keep the latest time, not the last read.
      for (const file of targets.files) {
        if (!(named.get(file)?.at > at)) named.set(file, { at, call: block.id });
      }
      for (const path of targets.removed) {
        if (!(removed.get(path)?.at > at)) removed.set(path, { at, call: block.id });
      }
      return true;
    },
    onToolResult(block, entry) {
      const call = calls.get(block.tool_use_id);
      if (call && !call.to) call.to = entry.timestamp ?? null;
    },
    /**
     * @param {{ dirty?: Set<string> | (() => Set<string>), endedAt?: string | null, root?: string, relativeTo?: string, deletions?: Map<string, string[]> }} [options]
     *   `dirty` may be a getter, so a caller walking many transcripts runs `git status` once and late.
     *   `deletions` maps a tool_use id to the absolute paths that went missing during that call.
     *   `relativeTo` is the tree the commands' absolute paths are made relative to; `root` is where
     *   those relative paths are looked up on disk. They differ only in tests.
     * @returns {Map<string, { at: string, via: "shell" | "mtime" }>} repo-relative path → attribution
     */
    resolve({ dirty, endedAt = null, root = projectRoot(), relativeTo = projectRoot(), deletions = new Map() } = {}) {
      const result = new Map();
      if (calls.size === 0) return result;
      const ctx = resolveContext({ dirty, endedAt, root, relativeTo, result });
      const prefixes = attributeNamed(ctx, named, calls);
      attributeRemoved(ctx, removed);
      attributeDeletions(ctx, deletions, calls);

      const needsWindows = prefixes.length > 0 || [...calls.values()].some((call) => call.opaque || call.globs.length);
      if (!needsWindows) return result;
      attributeGlobWindows(ctx, calls);
      for (const { prefix, call } of prefixes) {
        const window = call && ctx.windowOf(call);
        if (window) claimInWindow(ctx, call, window, (rel) => rel.startsWith(prefix));
      }
      return result;
    },
  };
}

/** The memoized disk and git reads one `resolve` run shares across its phases. */
function resolveContext({ dirty, endedAt, root, relativeTo, result }) {
  const mtimes = new Map();
  const mtimeOf = (rel) => {
    if (!mtimes.has(rel)) {
      try {
        mtimes.set(rel, statSync(join(root, rel)).mtimeMs);
      } catch {
        mtimes.set(rel, null);
      }
    }
    return mtimes.get(rel);
  };
  const isDirectory = (rel) => {
    try {
      return statSync(join(root, rel)).isDirectory();
    } catch {
      return false;
    }
  };
  const windowOf = (call) => {
    const from = Date.parse(call.from) - WINDOW_SLACK_MS;
    const to = Date.parse(call.to ?? endedAt ?? call.from) + WINDOW_SLACK_MS;
    return Number.isNaN(from) || Number.isNaN(to) ? null : { from, to };
  };
  const inWindow = (rel, window) => {
    const mtime = mtimeOf(rel);
    return mtime !== null && mtime >= window.from && mtime <= window.to;
  };
  /**
   * Attribute a dirty file to a call by mtime unless a later attribution exists. A file's mtime
   * is its last write, so a later call whose window holds it moves the time even past a path a
   * command named; the named attribution stays the firmer label. A stale time would read as
   * "committed since the last edit" and drop the path from `--files`.
   */
  const claim = (rel, call, via) => {
    const previous = result.get(rel);
    if (previous && previous.at >= call.from) return;
    result.set(rel, { at: call.from, via: previous?.via === "shell" ? "shell" : via });
  };

  let dirtySet = null;
  const dirtyFiles = () => {
    dirtySet ??= (typeof dirty === "function" ? dirty() : dirty) ?? gitDirtyFiles(root);
    return dirtySet;
  };
  const relative = (path) => repoRelativePath(path, undefined, relativeTo);
  const exists = (rel) => existsSync(join(root, rel));
  return { result, mtimeOf, isDirectory, windowOf, inWindow, claim, dirtyFiles, relative, exists };
}

/**
 * Directories the commands named (`prettier --write docs`, `eslint . --fix` → `.`) are globs in
 * disguise: only dirty files under them written inside the window count, so they come back as
 * prefixes. A named path that neither exists nor is dirty was never written (a literal in a test
 * fixture, a command that failed) and is dropped.
 */
function attributeNamed(ctx, named, calls) {
  const prefixes = [];
  for (const [file, meta] of named) {
    const rel = ctx.relative(file);
    if (rel === null) continue;
    if (ctx.isDirectory(rel === "" ? "." : rel))
      prefixes.push({ prefix: rel === "" ? "" : `${rel}/`, call: calls.get(meta.call) });
    else if (ctx.exists(rel) || ctx.dirtyFiles().has(rel)) ctx.result.set(rel, { at: meta.at, via: "shell" });
  }
  return prefixes;
}

/**
 * A removal names its target, so a dirty file gone from disk under it is the command's work,
 * whether the command named the file, its directory or a pattern. Only a missing file counts: one
 * that still exists was not removed by it, and the mtime rules judge it.
 */
function attributeRemoved(ctx, removed) {
  for (const [path, meta] of removed) {
    const rel = ctx.relative(path);
    if (rel === null) continue;
    const matcher = removalMatcher(rel);
    if (matcher !== undefined) claimRemoved(ctx, matcher, meta);
  }
}

/** `null` for the repo root itself (`git rm -r .`: everything under it); `undefined` when the pattern does not compile. */
function removalMatcher(rel) {
  if (rel === "") return null;
  try {
    return globToRegExp(rel);
  } catch {
    return undefined;
  }
}

function claimRemoved(ctx, matcher, meta) {
  for (const file of ctx.dirtyFiles()) {
    if ((matcher && !matcher.test(file)) || ctx.mtimeOf(file) !== null) continue;
    const previous = ctx.result.get(file);
    if (!previous || previous.at < meta.at) ctx.result.set(file, { at: meta.at, via: "shell" });
  }
}

/**
 * A script names nothing it deletes. Only an opaque call's deletions count: one made while `ls`
 * ran was a neighbour's. A path back on disk or no longer dirty is not a deletion now.
 */
function attributeDeletions(ctx, deletions, calls) {
  for (const [id, paths] of deletions) {
    const call = calls.get(id);
    if (call?.opaque) claimDeleted(ctx, call, paths);
  }
}

function claimDeleted(ctx, call, paths) {
  for (const path of paths) {
    const rel = ctx.relative(path);
    if (rel !== null && ctx.mtimeOf(rel) === null && ctx.dirtyFiles().has(rel)) ctx.claim(rel, call, "mtime");
  }
}

function attributeGlobWindows(ctx, calls) {
  for (const call of calls.values()) {
    if (!call.opaque && call.globs.length === 0) continue;
    const window = ctx.windowOf(call);
    if (!window) continue;
    const matchers = globMatchers(ctx, call.globs);
    claimInWindow(ctx, call, window, (rel) => call.opaque || matchers.some((matcher) => matcher.test(rel)));
  }
}

function globMatchers(ctx, globs) {
  return globs
    .map((glob) => ctx.relative(glob))
    .filter((rel) => rel !== null)
    .flatMap((rel) => {
      // A pattern that is not a glob after all must not take the whole record down.
      try {
        return [globToRegExp(rel)];
      } catch {
        return [];
      }
    });
}

function claimInWindow(ctx, call, window, matches) {
  for (const rel of ctx.dirtyFiles()) {
    if (matches(rel) && ctx.inWindow(rel, window)) ctx.claim(rel, call, "mtime");
  }
}

/** Where core's `shell-deletions` hook logs a session's snapshots (`lib/hook-utils.mjs`). */
export { shellDeletionsLog };

/**
 * Tracked files each script-running shell call deleted: the paths its `post` snapshot lists and
 * its `pre` snapshot does not. A call with no `post` line (it failed, or the hook did not run)
 * gets nothing, since a later look would also catch a neighbour's deletions.
 * @param {string} transcriptPath
 * @returns {Map<string, string[]>} tool_use id → absolute paths
 */
export function readShellDeletions(transcriptPath) {
  const deleted = new Map();
  let text;
  try {
    text = readFileSync(shellDeletionsLog(transcriptPath), "utf8");
  } catch {
    return deleted;
  }
  const before = new Map();
  for (const line of text.split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry?.id !== "string" || !Array.isArray(entry.deleted)) continue;
    if (entry.phase === "pre") before.set(entry.id, new Set(entry.deleted));
    else if (entry.phase === "post" && before.has(entry.id)) {
      const fresh = entry.deleted.filter((path) => !before.get(entry.id).has(path));
      if (fresh.length > 0) deleted.set(entry.id, fresh);
    }
  }
  return deleted;
}

/**
 * Repo-relative paths this session's transcript shows being edited or written — through the
 * Edit/Write tools and through shell commands (see `createShellEditTracker`).
 *
 * Several sessions share one working tree, so `git status` answers "what is dirty", not
 * "what did I change". The transcript is the only per-session source of that answer.
 * @param {string} transcriptPath
 * @returns {Set<string>}
 */
export function editedFilesInTranscript(transcriptPath) {
  const files = new Set();
  let lines;
  try {
    lines = readTranscriptLines(transcriptPath);
  } catch {
    return files;
  }
  const shell = createShellEditTracker();
  let endedAt = null;
  for (const line of lines) {
    if (!line || (!line.includes('"tool_use"') && !line.includes('"tool_result"'))) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(entry.message?.content)) continue;
    if (entry.timestamp) endedAt = entry.timestamp;
    for (const block of entry.message.content) {
      if (block.type === "tool_result") shell.onToolResult(block, entry);
      if (block.type !== "tool_use" || entry.type !== "assistant") continue;
      if (shell.onToolUse(block, entry) || !EDIT_TOOLS.has(block.name)) continue;
      const rel = repoRelativePath(block.input?.file_path, entry.cwd ?? process.cwd());
      if (rel) files.add(rel);
    }
  }
  for (const path of shell.resolve({ endedAt, deletions: readShellDeletions(transcriptPath) }).keys()) files.add(path);
  return files;
}
