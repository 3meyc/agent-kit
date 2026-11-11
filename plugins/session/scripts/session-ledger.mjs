import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimStillOpen,
  collectClaims,
  formatShared,
  landedElsewhere,
  openPaths,
  parseCommitLog,
  sharedPaths,
} from "./ledger-claims.mjs";
import {
  ARCHIVE_DIR,
  fillFromRecap,
  isNextOpen,
  listRecords,
  markDone,
  parseAuthoredSections,
  parseFrontMatter,
  parseNextItems,
  parsePrevious,
  renderRecord,
  resolveRecordPath,
} from "./ledger-record.mjs";
import { branchSessions, gitCloseFacts, lastActive, splitItems } from "./ledger-autoclose.mjs";
import { clip, conversationText, findSecrets, redactSecrets } from "./ledger-text.mjs";
import { SUMMARIZER_MARKER } from "./ledger-summarize.mjs";
import {
  appendHookLog,
  gitDirtyFiles,
  isDirectRun,
  isInCheckout,
  isProcessPath,
  parseWorktrees,
  readHookInput,
  readTranscriptLines,
  transcriptDirs,
  transcriptRoot,
} from "../lib/hook-utils.mjs";
import { createShellEditTracker, readCommitFacts, readShellDeletions } from "./ledger-utils.mjs";
import { hookOff, inLedger, ledgerDir, ledgerHookOn, readKit, rootFor } from "../lib/kit-config.mjs";

/**
 * Session ledger — one Markdown record per Claude Code session in the ledger folder (`kit.json`
 * `paths.ledger`, default `.claude/ledger/`), plus a regenerated `INDEX.md`. Runs as the plugin's
 * Stop hook (id `ledger-stop`) and as a command (`session-ledger` on the Bash PATH, from `bin/`):
 *
 *   session-ledger                 # hook mode: payload on stdin
 *   session-ledger --backfill      # every transcript of this project
 *   session-ledger --transcript <path>
 *   session-ledger --files <session-id-prefix>...   # dirty files this session edited
 *   session-ledger --record [<session-id-prefix>]     # path of this session's record
 *   session-ledger --refresh [<session-id-prefix>...]   # rewrite the record now; print id + path
 *   session-ledger --conflicts <session-id-prefix>... [--allow-shared <path>]... -- <path>...
 *   session-ledger --owed [<word>]       # open `## Next` items of every record, newest first,
 *                                        # then the auto-closed ones with their reason
 *   session-ledger --done <id8> <n> [--as <id8>]   # mark item n of that record done
 *   session-ledger --sweep [--dry-run] [--as <id8>]   # mark every auto-closed item done, with its reason
 *   session-ledger --archive [--days <n>] [--dry-run]   # git mv settled records older than n days (60) to archive/
 *   session-ledger --help          # usage
 *
 * `--conflicts` prints the paths another session also claims and exits 2 if any.
 *
 * With `ledger` not `true` in `kit.json`, the hook exits quietly and nothing writes a record:
 * `--refresh` prints the session ids with no record path, `--backfill` and `--transcript` refuse.
 * `--files` and `--conflicts` still work, from the transcripts, for `git-commit-session`.
 *
 * Why it exists: transcripts keep everything and surface nothing. The record keeps the layer
 * that otherwise dies with the session — the decisions the user answered, the files touched,
 * the closing note with its "loose end" and "temporarily" admissions — small enough that the
 * next session can read the index in one go. No model is involved; this is a JSONL walk.
 *
 * "Files touched" covers the Edit/Write tools and shell commands alike. A Bash or PowerShell
 * call is read for the paths it names (redirects, `sed -i`, `prettier --write`, `pnpm add`,
 * `writeFileSync("…")`) and for what it removes (`rm`, `git rm -r dir`, `mv` sources), which
 * covers deleted files; a script, a glob, or a write to a path it cannot resolve (`sed -i … "$f"`
 * in a loop) is attributed only dirty files whose mtime falls inside that call's run window
 * (`createShellEditTracker` in `ledger-utils.mjs`), so a neighbour session's edits in the shared
 * working tree are not claimed. The record marks the two shell-derived kinds as `(shell)` and
 * `(shell, by mtime)`.
 */

/** This plugin's hook id for the Stop hook, as `kit.json` `hooks.off` names it. */
export const HOOK_ID = "ledger-stop";
/** The detached summarizer this hook may spawn; a project lists it in `hooks.off` to spend no tokens. */
export const SUMMARIZER_ID = "ledger-summarize";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// The checkout this run works on and what its `kit.json` says, set once by `init` before anything
// reads them. A plugin's scripts live in the plugin cache, so the root comes from the hook payload's
// `cwd` (or the shell's), never from this file's location: a worktree session's hook then works on
// the worktree, its ledger and its turns, as the source projects' hand-off to a worktree copy did.
let ROOT = "";
let KIT = readKit(".");
let LEDGER_DIR = "";
/** The ledger folder as a repo-relative POSIX path, for messages. */
let LEDGER_REL = "";
// Claude Code names a project's transcript folder after the slug of its working directory: every
// non-alphanumeric character becomes `-`, so `…/.claude/worktrees/x` is `…--claude-worktrees-x`.
let PROJECT_SLUG = "";
let TRANSCRIPT_DIR = "";

/** @param {string} root */
function init(root) {
  ROOT = root;
  KIT = readKit(root);
  LEDGER_DIR = ledgerDir(root, KIT);
  LEDGER_REL = KIT.paths.ledger;
  PROJECT_SLUG = root.replace(/[^A-Za-z0-9]/g, "-");
  TRANSCRIPT_DIR = join(homedir(), ".claude", "projects", PROJECT_SLUG);
}

const INDEX_ROWS_MAX = 40;
// `--archive` moves records whose date is older than this, by the date in the file name, not mtime.
const ARCHIVE_DAYS = 60;
const RECENT_SESSIONS_FOR_FILES = 6;
/**
 * One tab-separated line per hook run, in the git common dir: time, this script, the process cwd,
 * `CLAUDE_PROJECT_DIR`, the payload's cwd, and the checkout the run worked on. Kept because the app
 * may start a worktree session's hook from the main checkout, and nothing else says so.
 */
const HOOK_LOG_NAME = "session-ledger-hook.log";

/** @param {{ cwd?: unknown }} payload */
function logHookRun(payload) {
  const fields = [
    new Date().toISOString(),
    fileURLToPath(import.meta.url),
    process.cwd(),
    process.env.CLAUDE_PROJECT_DIR ?? "-",
    typeof payload.cwd === "string" ? payload.cwd : "-",
    `root:${ROOT}`,
  ];
  appendHookLog(HOOK_LOG_NAME, fields.join("\t"), ROOT);
}

/** `git status` once per process, and only when a transcript needs it (globs or opaque commands). */
let dirtyCache = null;
function dirtyFiles() {
  dirtyCache ??= gitDirtyFiles(ROOT);
  return dirtyCache;
}

/** Another tree's dirty files; a removed worktree has none, and its work is in git by now. */
function dirtyFilesIn(root) {
  if (root === ROOT) return dirtyFiles();
  return existsSync(root) ? gitDirtyFiles(root) : new Set();
}

/**
 * Phrases in a closing message that mark something the next session should know about.
 * Matched case-insensitively against the last assistant messages of the session.
 *
 * These record what the assistant *said*, which is all a phrase match can know. `uncommitted` used
 * to live here and was wrong as often as right — it fired on "nothing is committed" long after the
 * work had been committed. Anything checkable belongs below, against the thing itself.
 */
const FLAG_PATTERNS = [
  ["loose-end", /loose end/i],
  ["deliberate-skip", /deliberately|left out|out of scope/i],
  ["temporary", /temporar/i],
  ["deadline", /week or two|in a week|revisit (in|after)/i],
  ["follow-up", /follow-up|follow up later|todo/i],
];

/** Paths in tool calls are absolute and OS-specific; the record wants them repo-relative. */
function relPath(raw, root = ROOT) {
  const normalized = String(raw).replace(/\\/g, "/");
  const rootNorm = root.replace(/\\/g, "/");
  if (normalized.toLowerCase().startsWith(rootNorm.toLowerCase())) {
    return normalized.slice(rootNorm.length).replace(/^\//, "");
  }
  const home = homedir().replace(/\\/g, "/");
  if (normalized.toLowerCase().startsWith(home.toLowerCase())) return `~${normalized.slice(home.length)}`;
  return normalized;
}

/**
 * Scratch files belong to the session, not to the project; the record is for the latter.
 *
 * Hook output is excluded for the same reason. A backfill writes dozens of ledger records, and
 * attributing them to the session turns its file list into a log of the recorder recording itself. What the session actually changed is the
 * *input* — a hook, a rule, a command — and `PROCESS_PATHS` still flags that as `process-change`.
 */
function isNoisePath(path) {
  return /scratchpad|\/tool-results\//.test(path) || inLedger(path, KIT);
}

/**
 * AskUserQuestion answers arrive as `"question"="answer"` pairs inside a sentence.
 * A rejected question has no pair and is reported as unanswered.
 * @param {string} text
 */
function parseAnswers(text) {
  const pairs = [];
  for (const match of text.matchAll(/"([^"]{3,}?)"="([^"]*?)"(?=, "|\. |\.$|$)/g)) {
    pairs.push({ question: match[1], answer: match[2] });
  }
  return pairs;
}

/**
 * A history-changing git command in command position (start, or after `&&`, `;`, `||`, `|`, `(`,
 * or a newline) and before any heredoc. A heredoc body that merely mentions `git commit` — an agent
 * prompt, a doc — is not a commit, and its output must not be read for a commit hash.
 * @param {string} command
 */
function isCommitCommand(command) {
  const beforeHeredoc = command.split(/<<-?\s*['"]?\w/)[0];
  return /(?:^|[;&|(\n])\s*git (commit|rebase --continue|cherry-pick --continue|merge)\b/.test(beforeHeredoc);
}

/**
 * @param {string} transcriptPath
 * @param {string} [root] The checkout the session ran in: this one, or for `--refresh` and
 *   `--transcript` the worktree `transcriptRoot` names, so its turns and paths read as it saw them.
 * @returns {ReturnType<typeof emptyRecord> | null}
 */
function parseTranscript(transcriptPath, root = ROOT) {
  const state = {
    root,
    record: emptyRecord(basename(transcriptPath, ".jsonl")),
    toolUseById: new Map(),
    commitCalls: new Set(),
    closingTexts: [],
    /** @type {Map<string, { count: number, lastAt: string, via: "edit" | "shell" | "mtime" }>} */
    edited: new Map(),
    shell: createShellEditTracker(),
    // The summarizer's own `claude -p` session: never a record.
    summarizer: false,
  };

  for (const line of readTranscriptLines(transcriptPath, root)) {
    const entry = parseTranscriptLine(line);
    if (entry) readEntry(state, entry);
    if (state.summarizer) return null;
  }

  if (state.record.prompts.length === 0) return null;
  mergeShellEdits(state, transcriptPath);
  return finishRecord(state);
}

function parseTranscriptLine(line) {
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readEntry(state, entry) {
  const { record } = state;
  // A side chat opens as a copy of its parent's transcript under a new id, and the copied lines
  // keep the parent's sessionId: that history is the parent's work, so the fork must not claim it.
  // Sub-agent lines carry their parent's id, which is this file's, and stay.
  if (entry.sessionId && entry.sessionId !== record.id) return;
  noteEntryTime(record, entry);
  // A turn run from another tree is that tree's work, recorded by the hook that runs there. A
  // session that enters a worktree and later leaves it (or removes it) would otherwise have this
  // checkout's hook rewrite the worktree's merged record: the last branch seen, paths prefixed
  // with `.claude/worktrees/<name>/`, and flags lost because those paths match no rule.
  if (typeof entry.cwd === "string" && !isInCheckout(entry.cwd, state.root)) return;
  noteEntryBranch(record, entry);
  if (entry.isCompactSummary) record.compactions += 1;
  readMessage(state, entry);
}

function noteEntryTime(record, entry) {
  if (!entry.timestamp) return;
  record.started ??= entry.timestamp;
  // Sub-agent files are read after the parent's, so the last line read is not the last in time.
  if (!record.ended || entry.timestamp > record.ended) record.ended = entry.timestamp;
}

/** A detached `HEAD` after a named branch is the worktree being removed, not the session's branch. */
function noteEntryBranch(record, entry) {
  if (entry.gitBranch && !entry.isSidechain && (entry.gitBranch !== "HEAD" || !record.branch))
    record.branch = entry.gitBranch;
}

function readMessage(state, entry) {
  const message = entry.message;
  if (!message) return;
  const content = messageBlocks(message);
  if (entry.type === "user") readUserBlocks(state, entry, content);
  else if (entry.type === "assistant") readAssistantBlocks(state, entry, message, content);
}

function messageBlocks(message) {
  if (Array.isArray(message.content)) return message.content;
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
}

function readUserBlocks(state, entry, content) {
  for (const block of content) {
    // The summarizer's session is no record: stop at its marker, as reading on could throw.
    if (state.summarizer) return;
    if (block.type === "text" && !entry.isMeta && !entry.isSidechain) readPrompt(state, block.text);
    else if (block.type === "tool_result") readToolResult(state, block, entry);
  }
}

function readPrompt(state, raw) {
  const text = conversationText(raw);
  if (!text || text.startsWith("[Request interrupted")) return;
  if (/^This session is being continued from a previous conversation/.test(text)) {
    state.record.continued = true;
    return;
  }
  if (text.includes(SUMMARIZER_MARKER)) {
    state.summarizer = true;
    return;
  }
  state.record.prompts.push(text);
}

function readToolResult(state, block, entry) {
  state.shell.onToolResult(block, entry);
  const toolName = state.toolUseById.get(block.tool_use_id);
  const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
  if (toolName === "AskUserQuestion") recordAnswers(state.record, text);
  else if (state.commitCalls.has(block.tool_use_id)) recordCommit(state, block.tool_use_id, text);
}

function recordAnswers(record, text) {
  const answers = parseAnswers(text);
  if (answers.length === 0) record.decisions.push({ question: null, answer: "(question rejected or unanswered)" });
  else record.decisions.push(...answers);
}

/**
 * A plain `git commit` proves itself by the `[branch hash]` line. Whether a path is still this
 * session's work is no longer read from here: git answers it per path.
 */
function recordCommit(state, toolUseId, text) {
  const hash = text.match(/\[[^\]\s]+ (?:\(root-commit\) )?([0-9a-f]{7,40})\]/);
  if (hash) state.record.commits.push(hash[1]);
  state.commitCalls.delete(toolUseId);
}

function readAssistantBlocks(state, entry, message, content) {
  noteModel(state.record, message);
  for (const block of content) {
    if (block.type === "text" && !entry.isSidechain && block.text.trim()) keepClosingText(state, block.text);
    if (block.type === "tool_use") readToolUse(state, block, entry);
  }
}

function noteModel(record, message) {
  if (message.model && !message.model.startsWith("<")) record.models.add(message.model);
}

function keepClosingText(state, text) {
  state.closingTexts.push(text);
  if (state.closingTexts.length > 2) state.closingTexts.shift();
}

function readToolUse(state, block, entry) {
  state.toolUseById.set(block.id, block.name);
  state.record.toolCalls += 1;
  const input = block.input ?? {};
  noteRecap(state.record, block, input, entry);
  noteToolEdit(state, block, input, entry);
  const command = String(input.command ?? "");
  if (state.shell.onToolUse(block, entry) && isCommitCommand(command)) state.commitCalls.add(block.id);
}

/**
 * The desktop app's wrap-up box: the session's own account of what is true and what is left,
 * written every turn. The latest one stands in for an Intent and a Next nobody wrote.
 */
function noteRecap(record, block, input, entry) {
  if (block.name !== "mcp__ccd_turn__wrap_up" || typeof input.recap !== "string" || !input.recap.trim()) return;
  const at = entry.timestamp ?? "";
  if (record.recap && at < record.recap.at) return;
  record.recap = { at, recap: input.recap, ask: typeof input.ask === "string" ? input.ask : null };
}

const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit"]);

function noteToolEdit(state, block, input, entry) {
  if (!EDIT_TOOL_NAMES.has(block.name) || !input.file_path) return;
  const path = relPath(input.file_path, state.root);
  if (/[\\/]memory[\\/]/.test(String(input.file_path))) state.record.memoryFiles.add(basename(path));
  else if (!isNoisePath(path)) countToolEdit(state.edited, path, entry.timestamp);
}

function countToolEdit(edited, path, timestamp) {
  const seen = edited.get(path) ?? { count: 0, lastAt: "" };
  // The latest time, not the last read: sub-agent lines follow the parent's.
  const at = timestamp && timestamp > seen.lastAt ? timestamp : seen.lastAt;
  edited.set(path, { count: seen.count + 1, lastAt: at, via: "edit" });
}

/** Shell-made edits join the Edit/Write ones; a tool edit stays the firmer attribution. */
function mergeShellEdits(state, transcriptPath) {
  const { root, edited } = state;
  const deletions = readShellDeletions(transcriptPath);
  for (const [path, meta] of state.shell.resolve({
    dirty: () => dirtyFilesIn(root),
    endedAt: state.record.ended,
    root,
    relativeTo: root,
    deletions,
  })) {
    if (isNoisePath(path)) continue;
    const seen = edited.get(path);
    if (!seen) edited.set(path, { count: 1, lastAt: meta.at, via: meta.via });
    else if (meta.at > seen.lastAt) seen.lastAt = meta.at;
  }
}

function finishRecord(state) {
  const { record, edited, closingTexts } = state;
  record.edited = [...edited.entries()].sort((a, b) => b[1].count - a[1].count).map(([path]) => path);
  record.editedVia = new Map([...edited.entries()].map(([path, meta]) => [path, meta.via]));
  record.editedAt = new Map([...edited.entries()].map(([path, meta]) => [path, meta.lastAt]));
  record.closing = closingTexts.at(-1) ?? "";
  const flagSource = closingTexts.join("\n");
  record.phraseFlags = FLAG_PATTERNS.filter(([, pattern]) => pattern.test(flagSource)).map(([name]) => name);
  // Facts that stay true once true. Whether work is still uncommitted changes with every commit, so
  // readers compute it from git instead (`ledger-claims.mjs`).
  if (record.edited.some((path) => isProcessPath(path))) record.flags.push("process-change");
  if (record.continued) record.flags.unshift("continued");
  return record;
}

function emptyRecord(id) {
  return {
    id,
    started: null,
    ended: null,
    branch: null,
    continued: false,
    compactions: 0,
    prompts: [],
    decisions: [],
    edited: [],
    /** @type {Map<string, "edit" | "shell" | "mtime">} */
    editedVia: new Map(),
    /** @type {Map<string, string>} last edit time of every edited path; stored with `## Files` */
    editedAt: new Map(),
    /** Matched against the closing message, so they change every turn; rendered only without a Next. */
    phraseFlags: [],
    memoryFiles: new Set(),
    /** @type {{ at: string, recap: string, ask: string | null } | null} the last `wrap_up` call */
    recap: null,
    commits: [],
    models: new Set(),
    toolCalls: 0,
    closing: "",
    flags: [],
  };
}

/** A one-word prompt with nothing edited is a probe, not a session worth a record. */
function isTrivial(record) {
  return record.edited.length === 0 && record.decisions.length === 0 && record.prompts.join(" ").length < 40;
}

/**
 * Records are named by day + id so they sort chronologically in any file browser. A session whose
 * record was archived keeps writing there: one file per session, in either folder, never both.
 */
function recordPath(record) {
  const name = `${record.started.slice(0, 10)}-${record.id.slice(0, 8)}.md`;
  return resolveRecordPath(LEDGER_DIR, name) ?? join(LEDGER_DIR, name);
}

/** A record's repo-relative POSIX path, as `--files`, `--record` and `--refresh` print it. */
function recordRel(path) {
  return relative(ROOT, path).split("\\").join("/");
}

/** The records of the sessions whose id starts with `prefix`, newest first, in either folder. */
function recordsFor(prefix) {
  return listRecords(LEDGER_DIR, { archive: true }).filter(({ name }) => name.slice(11).startsWith(prefix));
}

/**
 * Several sessions' Stop hooks can finish within the same second. A rename is atomic on every
 * platform Node supports, so a reader never sees a half-written file.
 */
function writeFileAtomic(path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * What the record on disk already says, plus `Intent` and `Next` from the session's last recap
 * where it says nothing. The fill is derived from the transcript, so it renders the same bytes
 * until the session writes the section itself; a session-written section is kept as it is.
 * @param {string | null} before The record's current text, or null before the first write.
 * @param {{ recap: string, ask: string | null } | null} recap
 */
function authoredSections(before, recap) {
  const written = before === null ? new Map() : parseAuthoredSections(before);
  return recap ? fillFromRecap(written, recap) : written;
}

/**
 * Records are pushed, so nothing that looks like a key reaches the file. Once a record was
 * redacted its flag stays: the next rewrite reads back text that is already clean and would
 * otherwise drop it, and the flag is how a reader learns something was removed.
 */
function renderRedacted(record, authored, previous, before) {
  const content = renderRecord(record, authored, previous);
  const wasRedacted = before !== null && /^flags: \[.*\bsecret-redacted\b.*\]$/m.test(before);
  if (!wasRedacted && findSecrets(content).length === 0) return content;
  record.flags.push("secret-redacted");
  return redactSecrets(renderRecord(record, authored, previous));
}

function writeRecord(record) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  const path = recordPath(record);
  const before = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
  const authored = authoredSections(before, record.recap);
  const previous = before === null ? undefined : parsePrevious(before);
  // The stored file list outlives the transcript's view of it, and so does the flag it implies.
  if (previous?.files.some((file) => isProcessPath(file.path)) && !record.flags.includes("process-change"))
    record.flags.push("process-change");
  const content = renderRedacted(record, authored, previous, before);
  // An unchanged record is not written: after the last commit a Stop must leave the tree clean.
  if (content !== before) writeFileAtomic(path, content);
  return { path, authored };
}

/**
 * A record nobody wrote gets a cheap model to write it. Detached and unwaited: the Stop hook must
 * not hold the session open for an inference call, and a missing summary is never worth an error.
 * @param {string} recordPath @param {string} transcriptPath
 */
function spawnSummarizer(recordPath, transcriptPath) {
  if (process.env.LEDGER_SUMMARIZING || process.env.LEDGER_NO_SUMMARY || hookOff(SUMMARIZER_ID, KIT)) return;
  try {
    const child = spawn(process.execPath, [join(SCRIPT_DIR, "ledger-summarize.mjs"), recordPath, transcriptPath], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LEDGER_SUMMARIZING: "1", CLAUDE_PROJECT_DIR: ROOT },
    });
    child.unref();
  } catch {
    // Nothing to do: the record keeps its placeholders and the next Stop tries again.
  }
}

/** @param {string} path */
function readFrontMatter(path) {
  // A Windows clone with `core.autocrlf` checks records out with CRLF; the index must not lose them.
  return parseFrontMatter(readFileSync(path, "utf8").replace(/\r\n/g, "\n"), basename(path));
}

/**
 * The index's closing count line: the live records past the rows shown, and the archived ones;
 * empty when there is neither.
 * @param {number} older @param {number} archived
 */
function indexCountLine(older, archived) {
  const where = [
    older > 0 ? `${older} older records in this folder` : "",
    archived > 0
      ? `${archived} in archive/ (moved by \`session-ledger --archive\`; links by live path still resolve)`
      : "",
  ].filter(Boolean);
  return where.length ? `… ${where.join(", ")}.` : "";
}

function renderIndex() {
  const all = listRecords(LEDGER_DIR, { archive: true });
  const records = all
    .filter((r) => !r.archived)
    .map(({ path }) => readFrontMatter(path))
    .filter(Boolean)
    .sort((a, b) => b.file.localeCompare(a.file));
  const archived = all.filter((r) => r.archived).length;

  const recentFiles = new Map();
  for (const record of records.slice(0, RECENT_SESSIONS_FOR_FILES)) {
    for (const path of record.editedPaths) recentFiles.set(path, (recentFiles.get(path) ?? 0) + 1);
  }
  const sharedRecently = [...recentFiles.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);

  const lines = [
    "# Session ledger",
    "",
    "Generated by the agent-kit `session` plugin (Stop hook `ledger-stop`). One record per Claude Code session;",
    "newest first. Read a record before touching the same files or reopening the same topic.",
    "A record's front matter and `## Files` list (each path with its last edit time) are computed; the session",
    "writes `title:`, `## Intent`, `## Decisions` and `## Next`, and the hook preserves them. Nothing a commit",
    "changes is stored: commits come from `Session-Id` trailers and `uncommitted` from git, when read.",
    "Flags: `loose-end`, `deliberate-skip`, `temporary`, `deadline`, `follow-up` (only while a record has no",
    "`## Next`), `uncommitted` (computed), `continued`,",
    "`process-change` (edited hooks, commands, agents, skills, rules or MCP config),",
    "`secret-redacted` (something shaped like a key was replaced with `[redacted]` before writing).",
    "Committing in a shared working tree: `session-ledger --files <session-id>` lists",
    "the dirty files this session edited that no commit took since, through Edit/Write or shell commands",
    "(`(shell)` = the command named the path, `(shell, by mtime)` = written while a script or glob ran) —",
    "commit those with `git-commit-session` (or `/git commit`), never `git add -A`.",
    "",
    "| Date | Session | Prompt | Edits | Flags |",
    "| --- | --- | --- | ---: | --- |",
  ];
  for (const r of records.slice(0, INDEX_ROWS_MAX)) {
    const prompt = r.label.replace(/\|/g, "\\|");
    lines.push(
      `| ${r.date} | [${r.id.slice(0, 8)}](${r.file}) | ${prompt} | ${r.editedCount} | ${flagsWhenRead(r).join(" ")} |`,
    );
  }
  const footer = indexCountLine(records.length - INDEX_ROWS_MAX, archived);
  if (footer) lines.push("", footer);
  if (sharedRecently.length) {
    lines.push("", `## Touched by more than one of the last ${RECENT_SESSIONS_FOR_FILES} sessions`, "");
    for (const [path, n] of sharedRecently) lines.push(`- ${path} (${n})`);
  }
  lines.push("");
  writeFileAtomic(join(LEDGER_DIR, "INDEX.md"), lines.join("\n"));
  return records.length;
}

/**
 * Files a session edited that no commit took since and that are still dirty in git, one per line — the
 * list to commit through `git-commit-session.mjs` when other sessions share the working tree. Prefixes are the session ids
 * (a resumed session has a new id, so pass both). The session's own ledger record is included so
 * it lands in the same commit. Edits made through shell commands count (see the header note);
 * a file another session dirtied is not listed unless this session also wrote it.
 *
 * Reads the live transcript, not the record: the record is written at Stop, so edits made in the
 * very turn that commits would otherwise be invisible. Records are the fallback when the
 * transcript is on another machine.
 * @param {string[]} prefixes
 */
function printSessionFiles(prefixes) {
  if (prefixes.length === 0) return;
  const edited = new Set();
  for (const prefix of prefixes) {
    const transcripts = listTranscripts().filter((path) => basename(path).startsWith(prefix));
    for (const transcriptPath of transcripts) addTranscriptFiles(edited, transcriptPath);
    if (transcripts.length > 0) continue;
    for (const { path: file } of recordsFor(prefix)) addRecordFiles(edited, file);
  }
  const dirty = dirtyFiles();
  for (const path of [...edited].sort()) if (dirty.has(path)) console.log(path);
}

function addTranscriptFiles(edited, transcriptPath) {
  const record = parseQuietly(transcriptPath);
  if (!record) return;
  edited.add(recordRel(recordPath(record)));
  for (const [path, at] of record.editedAt) {
    if (claimStillOpen(Date.parse(at), lastCommitSec(path))) edited.add(path);
  }
}

function addRecordFiles(edited, file) {
  edited.add(recordRel(file));
  const meta = readFrontMatter(file);
  const writtenAt = statSync(file).mtimeMs;
  for (const path of meta?.pending ?? []) {
    const at = pendingEditTime(meta, path, writtenAt);
    if (!Number.isNaN(at) && claimStillOpen(at, lastCommitSec(path))) edited.add(path);
  }
}

/** A settled record carries each path's edit time; an older one only the file's last write. */
function pendingEditTime(meta, path, writtenAt) {
  return meta.editedAt.size ? Date.parse(meta.editedAt.get(path) ?? "") : writtenAt;
}

/** @param {string} transcriptPath */
function refreshRecord(transcriptPath) {
  const record = parseTranscript(transcriptPath, rootOf(transcriptPath));
  // A session too small for a record still owns its commit: print its id, so the trailer is set.
  // So does every session of a project that keeps no ledger.
  if (!record || isTrivial(record) || !KIT.ledger) {
    console.log(`${basename(transcriptPath, ".jsonl")}\t`);
    return;
  }
  const { path } = writeRecord(record);
  console.log(`${record.id}\t${recordRel(path)}`);
}

/**
 * Rewrite each session's record from its live transcript and print `<full id>\t<record path>`, so
 * the commit script can commit the record current to the moment and name the session in its
 * trailer. A session whose transcript is on another machine prints its record unchanged; one too
 * small for a record prints its id with no path.
 * @param {string[]} prefixes
 */
function refreshRecords(prefixes) {
  for (const prefix of prefixes) {
    // A worktree session's record is merged here once its branch lands, and outlives the worktree.
    const transcripts = listTranscripts(transcriptDirs(ROOT)).filter((path) => basename(path).startsWith(prefix));
    for (const transcriptPath of transcripts) refreshRecord(transcriptPath);
    if (transcripts.length > 0) continue;
    for (const { path: file } of recordsFor(prefix)) {
      const meta = readFrontMatter(file);
      if (meta?.id) console.log(`${meta.id}\t${recordRel(file)}`);
    }
  }
}

function parseQuietly(transcriptPath) {
  try {
    return parseTranscript(transcriptPath);
  } catch (error) {
    if (process.env.LEDGER_DEBUG) console.error(error);
    return null;
  }
}

/** One `git log` pass per process (`readCommitFacts`), and only when a reader needs it. */
let commitFacts = null;
const facts = () => (commitFacts ??= readCommitFacts(ROOT));
/** Newest commit time of a path, in seconds; the window's start when none falls inside it. */
const lastCommitSec = (path) => facts().lastCommit.get(path) ?? facts().sinceSec;

/** A settled record's open paths; an older record keeps the `uncommitted` flag it stored. */
function flagsWhenRead(meta) {
  if (!meta.editedAt.size) return meta.flags;
  const files = [...meta.editedAt].map(([path, at]) => ({ path, at }));
  return openPaths(files, lastCommitSec, dirtyFiles()).length ? [...meta.flags, "uncommitted"] : meta.flags;
}

/**
 * Which of `paths` another session still claims (`collectClaims` has the rules). Prints one line per
 * shared path and sets exit code 2; exit 1 when git gave no status to check against.
 * @param {string[]} ownPrefixes @param {string[]} paths @param {Set<string>} allowed
 */
function printConflicts(ownPrefixes, paths, allowed) {
  const dirty = dirtyFiles();
  // A commit has something dirty to take; an empty set means `git status` failed, and reading that
  // as "nothing shared" would let the commit through unchecked.
  if (dirty.size === 0) {
    console.error("session-ledger --conflicts: git status returned no changes; cannot check claims");
    process.exitCode = 1;
    return;
  }
  const records = [];
  for (const { name, path: file } of listRecords(LEDGER_DIR, { archive: true })) {
    const meta = readFrontMatter(file);
    if (!meta?.id) continue;
    records.push({ ...meta, day: name.slice(0, 10), mtimeMs: statSync(file).mtimeMs });
  }
  const transcripts = listTranscripts().map((path) => ({
    id: basename(path, ".jsonl"),
    mtimeMs: statSync(path).mtimeMs,
    editedAt: () => parseQuietly(path)?.editedAt ?? null,
  }));
  const claims = collectClaims({
    own: paths,
    ownPrefixes,
    now: Date.now(),
    transcripts,
    records,
    lastCommitSec,
    landed: landedTest(),
  });
  const shared = sharedPaths(paths, claims, dirty, allowed);
  for (const line of formatShared(shared)) console.log(line);
  if (shared.length) process.exitCode = 2;
}

/** Git output, or null when the command fails. */
function gitText(args, cwd = ROOT) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * `landedElsewhere` with this checkout's git facts: its branch, the sessions with a commit outside
 * `HEAD` (one log of the `Session-Id` trailers on every ref but not `HEAD`), the worktrees and
 * their branches, each session's tree from its transcript, and each tree's dirty files. Read on
 * the first record that gets that far; a git failure keeps every claim, since dropping one on a
 * missing fact would let a shared path through unasked.
 */
function landedTest() {
  let git;
  const load = () => {
    const outside = gitText([
      "log",
      "--all",
      "--not",
      "HEAD",
      "--format=%x00%h 0%x09%(trailers:key=Session-Id,valueonly,separator=%x2C)",
    ]);
    const porcelain = gitText(["worktree", "list", "--porcelain"]);
    if (outside === null || porcelain === null) return null;
    const worktrees = parseWorktrees(porcelain).filter((tree) => tree.path);
    const trees = new Set(worktrees.map((tree) => treeKey(tree.path)));
    const byBranch = new Map(worktrees.filter((tree) => tree.branch).map((tree) => [tree.branch, tree.path]));
    // The main checkout's project folder holds every worktree session's transcripts beside its own.
    const main = worktrees.find((tree) => tree.main)?.path ?? ROOT;
    const transcripts = transcriptsById(transcriptDirs(main));
    const treeOf = new Map();
    const dirtyByTree = new Map();
    return {
      currentBranch: gitText(["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || null,
      hasCommits: (id) => facts().commitsBySession.has(id),
      unmerged: new Set(parseCommitLog(outside).commitsBySession.keys()),
      sessionTree: (id) => {
        if (!treeOf.has(id)) {
          const transcript = transcripts.get(id);
          treeOf.set(id, transcript ? transcriptRoot(transcript, main) : null);
        }
        return treeOf.get(id);
      },
      branchTree: (branch) => byBranch.get(branch) ?? null,
      dirtyIn: (tree) => {
        const key = treeKey(tree);
        if (!dirtyByTree.has(key)) {
          // A tree that is no longer a worktree holds nothing; a status that fails says nothing.
          const dirty = trees.has(key) ? gitDirtyFiles(tree, { nullOnError: true }) : new Set();
          dirtyByTree.set(key, dirty);
        }
        return dirtyByTree.get(key);
      },
    };
  };
  return (record, path) => {
    if (git === undefined) git = load();
    return git !== null && landedElsewhere(record, path, git);
  };
}

/**
 * One spelling per tree. Git for Windows prints `C:/…` where `join` gives `C:\…`, and git prints
 * the real path where a transcript's `cwd` may go through a symlink.
 * @param {string} path
 */
function treeKey(path) {
  const full = existsSync(path) ? realpathSync.native(path) : resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/** Transcript path by session id, unsorted: `listTranscripts` stats every file to order them. */
function transcriptsById(dirs) {
  const byId = new Map();
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".jsonl")) byId.set(basename(name, ".jsonl"), join(dir, name));
    }
  }
  return byId;
}

/** Width of an `--owed` line's item text: the brief's, so the two read alike. */
const OWED_LINE = 118;

/**
 * Every record's not-done `## Next` items, newest record first, split by the auto-close rules
 * (`ledger-autoclose.mjs`). `network` lets the PR rule ask `gh`; the caller saves its cache.
 * @param {{ network: boolean }} options
 */
function ledgerItems({ network }) {
  const texts = listRecords(LEDGER_DIR, { archive: true }).map(({ name, path }) => ({
    name,
    path,
    text: readFileSync(path, "utf8").replace(/\r\n/g, "\n"),
  }));
  const sessionsByBranch = branchSessions(texts.map(({ name, text }) => parseFrontMatter(text, name) ?? {}));
  const facts = gitCloseFacts(ROOT, KIT.baseBranch, { network, sessionsByBranch });
  const options = { now: Date.now(), questionDays: KIT.ledgerAutoClose.questionDays };
  const records = texts.map(({ name, path, text }) => {
    const items = parseNextItems(parseAuthoredSections(text).get("Next"));
    const day = name.slice(0, 10);
    const record = { day, lastAt: lastActive(day, parsePrevious(text).files.map((file) => file.at)) };
    return { name, path, text, ...splitItems(items, record, facts, options) };
  });
  facts.save();
  return records;
}

/**
 * Every open `## Next` item across the ledger, newest record first — the items the brief never
 * shows again. One line per item: `<date> <id8>  <n>. <text>`, `n` being the item's number for
 * `--done`. A done item is skipped; `(unverified)` ones keep their prefix. The filter is a
 * case-insensitive substring of the item text, so a path or a skill name finds its items.
 * The items an auto-close rule closed follow in their own section, each with its reason.
 * @param {string} filter
 */
function printOwed(filter) {
  const needle = filter.toLowerCase();
  const matches = (item) => !needle || item.text.toLowerCase().includes(needle);
  const closedLines = [];
  for (const { name, open, closed } of ledgerItems({ network: true })) {
    const head = `${name.slice(0, 10)} ${name.slice(11, 19)}`;
    for (const item of open.filter(matches)) console.log(`${head}  ${item.n}. ${clip(item.text, OWED_LINE)}`);
    for (const { item, reason } of closed.filter(({ item }) => matches(item)))
      closedLines.push(`${head}  ${item.n}. ${clip(item.text, OWED_LINE - 40)} — ${reason}`);
  }
  if (!closedLines.length) return;
  const header = "Auto-closed (hidden from the brief; `session-ledger --sweep` marks them done):";
  console.log(["", header, "", ...closedLines].join("\n"));
}

/**
 * Write the done marks for every auto-closed item: `(done <today> <signer> auto: <reason>)`, the
 * `--done` mark plus why. Nothing is deleted; a record is rewritten once, atomically, whatever the
 * number of items. Signed by `--as`, else this session's id, else `sweep` (a run from a terminal).
 * @param {string[]} args
 */
function runSweep(args) {
  const dryRun = args.includes("--dry-run");
  const as = args.includes("--as") ? args[args.indexOf("--as") + 1] : undefined;
  const signer = (as ?? process.env.CLAUDE_CODE_SESSION_ID ?? "sweep").slice(0, 8);
  const today = new Date().toISOString().slice(0, 10);
  let items = 0;
  let records = 0;
  for (const { path, text, closed } of ledgerItems({ network: true })) {
    if (!closed.length) continue;
    let next = text;
    for (const { item, reason } of closed) {
      next = markDone(next, item.n, `${today} ${signer} auto: ${reason}`);
      console.log(`${recordRel(path)}\titem ${item.n}: ${reason}`);
    }
    if (!dryRun) writeFileAtomic(path, next);
    items += closed.length;
    records += 1;
  }
  const verb = dryRun ? "would mark" : "marked";
  console.log(`session-ledger --sweep${dryRun ? " --dry-run" : ""}: ${verb} ${items} auto-closed item(s) done in ${records} record(s)`);
}

/**
 * Prefix item `n` of another session's record with `(done <today> <own id8>)`. The only edit one
 * session makes to another's record, so it is scripted: one format, one line changed, atomically.
 * Exit 1 on an unknown record, an out-of-range `n`, an item already done, or no id to sign with.
 * @param {string} prefix The record's session id prefix. @param {string} n @param {string | undefined} own
 */
function markRecordDone(prefix, n, own) {
  const item = Number(n);
  const found = recordsFor(prefix)[0];
  const fail = (message) => {
    console.error(`session-ledger --done: ${message}`);
    process.exitCode = 1;
  };
  if (!found) return fail(`no record for ${prefix}`);
  if (!Number.isInteger(item) || item < 1) return fail(`item number must be a positive integer, not ${n}`);
  if (!own) return fail("no session id to sign with — set CLAUDE_CODE_SESSION_ID or pass --as <id8>");
  const { path } = found;
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  try {
    writeFileAtomic(path, markDone(text, item, `${new Date().toISOString().slice(0, 10)} ${own.slice(0, 8)}`));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`${recordRel(path)}\titem ${item} marked done`);
}

/**
 * Move one record into the archive: `git mv` for a tracked one, so the commit sees a rename; a plain
 * rename for one never committed. Returns the failure line, or null.
 * @param {string} path @param {string} target
 */
function moveRecord(path, target) {
  mkdirSync(dirname(target), { recursive: true });
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: ROOT, encoding: "utf8" });
  if (tracked.status !== 0) {
    renameSync(path, target);
    return null;
  }
  const mv = spawnSync("git", ["mv", "--", path, target], { cwd: ROOT, encoding: "utf8" });
  return mv.status === 0 ? null : `git mv ${basename(path)} failed: ${mv.stderr.trim()}`;
}

/** Live records older than `cutoff` (a `YYYY-MM-DD`) whose `## Next` owes nothing: what `--archive` moves. */
function archivableRecords(cutoff) {
  return listRecords(LEDGER_DIR).filter(
    ({ name, path }) => name.slice(0, 10) < cutoff && !isNextOpen(readFileSync(path, "utf8").replace(/\r\n/g, "\n")),
  );
}

/** `--archive [--days <n>] [--dry-run]`: validate the window, then move. */
function runArchive(args) {
  const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : ARCHIVE_DAYS;
  if (!Number.isInteger(days) || days < 1) {
    console.error("session-ledger --archive: --days takes a positive whole number");
    process.exitCode = 1;
    return;
  }
  archiveRecords(days, args.includes("--dry-run"));
}

/**
 * Move the settled records older than `days` to `archive/` (`moveRecord`), then rebuild the index.
 * User-run, never part of a Stop, so a Stop after the last commit still leaves the tree clean. A
 * busy project adds dozens of records a month, and every reader of the live folder lists them all.
 * @param {number} days @param {boolean} dryRun
 */
function archiveRecords(days, dryRun) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const records = archivableRecords(cutoff);
  const what = `${records.length} record(s) older than ${days} days with nothing owed`;
  if (dryRun) {
    for (const { name } of records) console.log(`${LEDGER_REL}/${name}`);
    console.log(`session-ledger --archive --dry-run: ${what} would move to ${LEDGER_REL}/${ARCHIVE_DIR}/`);
    return;
  }
  for (const { name, path } of records) {
    const failure = moveRecord(path, join(LEDGER_DIR, ARCHIVE_DIR, name));
    if (failure) {
      console.error(`session-ledger --archive: ${failure}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`session-ledger --archive: ${what} moved to ${LEDGER_REL}/${ARCHIVE_DIR}/`);
  if (records.length) renderIndex();
}

/**
 * The tree a transcript is parsed against. One in this checkout's own folder is this checkout's
 * session, even where it moved into a worktree (that tree records its own turns); one in a
 * worktree's folder is that worktree's, whose record lands here when its branch does.
 * @param {string} transcriptPath
 */
function rootOf(transcriptPath) {
  return basename(dirname(transcriptPath)) === PROJECT_SLUG ? ROOT : transcriptRoot(transcriptPath, ROOT);
}

function listTranscripts(dirs = [TRANSCRIPT_DIR]) {
  return dirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(dir, name)),
    )
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/** The words after `flag` that are not themselves flags: a command's session id prefixes. */
function flagOperands(args, flag) {
  return args.slice(args.indexOf(flag) + 1).filter((a) => !a.startsWith("--"));
}

/** The given prefixes, else the calling session's own id when it is set. */
function prefixesOrOwn(prefixes) {
  return prefixes.length > 0 ? prefixes : [process.env.CLAUDE_CODE_SESSION_ID].filter(Boolean);
}

/**
 * `--record` prints the path of a session's own record, so a session can write its summary
 * without reconstructing `<date>-<id8>.md` by hand.
 */
function runRecord(args) {
  const prefix = flagOperands(args, "--record")[0] ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!prefix) {
    console.error("session-ledger --record: no session id — CLAUDE_CODE_SESSION_ID is unset, pass a prefix");
    return;
  }
  const match = recordsFor(prefix.slice(0, 8))[0];
  if (match) console.log(recordRel(match.path));
  else {
    console.error(
      `session-ledger --record: no record yet for ${prefix.slice(0, 8)}; the Stop hook writes it at the end of the turn, and git-commit-session writes and commits it with this session's next commit`,
    );
  }
}

function runFiles(args) {
  // Skill `!` preambles cannot expand `$CLAUDE_CODE_SESSION_ID` (the permission check rejects
  // shell expansion), so a bare `--files` falls back to the calling session's own id.
  const prefixes = prefixesOrOwn(flagOperands(args, "--files"));
  if (prefixes.length === 0) {
    console.error("session-ledger --files: no session id — CLAUDE_CODE_SESSION_ID is unset, pass a prefix");
    return;
  }
  printSessionFiles(prefixes);
}

function runRefresh(args) {
  const own = prefixesOrOwn(flagOperands(args, "--refresh"));
  if (own.length === 0) {
    console.error("session-ledger --refresh: pass a session id prefix (or set CLAUDE_CODE_SESSION_ID)");
    process.exitCode = 1;
    return;
  }
  refreshRecords(own);
}

function runOwed(args) {
  const next = args[args.indexOf("--owed") + 1];
  printOwed(next && !next.startsWith("--") ? next : "");
}

function runDone(args) {
  const [prefix, n] = flagOperands(args, "--done");
  if (!prefix || n === undefined) {
    console.error("session-ledger --done: pass <session-id-prefix> <item number> [--as <id8>]");
    process.exitCode = 1;
    return;
  }
  const as = args.includes("--as") ? args[args.indexOf("--as") + 1] : undefined;
  markRecordDone(prefix, n, as ?? process.env.CLAUDE_CODE_SESSION_ID);
}

function runConflicts(args) {
  const separator = args.indexOf("--");
  const paths = separator === -1 ? [] : args.slice(separator + 1);
  const options = separator === -1 ? args : args.slice(0, separator);
  const allowed = new Set(options.filter((_, i) => options[i - 1] === "--allow-shared"));
  const prefixes = options
    .slice(options.indexOf("--conflicts") + 1)
    .filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--allow-shared");
  const own = prefixesOrOwn(prefixes);
  if (own.length === 0 || paths.length === 0) {
    console.error(
      "session-ledger --conflicts: pass a session id prefix (or set CLAUDE_CODE_SESSION_ID) and -- <paths>",
    );
    process.exitCode = 1;
    return;
  }
  printConflicts(own, paths, allowed);
}

const USAGE = `Session ledger: one Markdown record per Claude Code session, in kit.json paths.ledger
(default .claude/ledger/), when kit.json sets "ledger": true.

  session-ledger                 # Stop hook mode: payload on stdin
  session-ledger --backfill      # every transcript of this project
  session-ledger --transcript <path>
  session-ledger --files <session-id-prefix>...       # dirty files this session edited
  session-ledger --record [<session-id-prefix>]       # path of this session's record
  session-ledger --refresh [<session-id-prefix>...]   # rewrite the record now; print id + path
  session-ledger --conflicts <session-id-prefix>... [--allow-shared <path>]... -- <path>...
                                                      # paths another session also claims; exit 2 if any
  session-ledger --owed [<word>]                      # open \`## Next\` items, newest first, then
                                                      # the auto-closed ones with their reason
  session-ledger --done <id8> <n> [--as <id8>]        # mark item n of that record done
  session-ledger --sweep [--dry-run] [--as <id8>]     # mark every auto-closed item done, with its reason
  session-ledger --archive [--days <n>] [--dry-run]   # git mv settled records older than n days (60) to archive/
  session-ledger --help                               # print this and exit 0

Auto-closed: an "Open question at Stop" item older than kit.json ledgerAutoClose.questionDays (7),
an item past its "(until YYYY-MM-DD)", one naming a PR merged since (base merge subjects, else gh
when installed), one naming a branch that landed in the base since. The brief hides them.

Session id prefixes default to CLAUDE_CODE_SESSION_ID. LEDGER_NO_SUMMARY=1 disables the detached
summarizer (ledger-summarize.mjs, which spends tokens); LEDGER_SUMMARY_MODEL picks its model.
`;

function runHelp() {
  process.stdout.write(USAGE);
}

/** The flag commands, in the order `main` tests them: the first one present runs. */
const FLAG_COMMANDS = [
  ["--help", runHelp],
  ["--record", runRecord],
  ["--files", runFiles],
  ["--refresh", runRefresh],
  ["--owed", runOwed],
  ["--done", runDone],
  ["--sweep", runSweep],
  ["--archive", runArchive],
  ["--conflicts", runConflicts],
];

/** The transcripts a hook run, `--backfill` or `--transcript` records; `null` when there is nothing to record here. */
async function transcriptsToRecord(backfill, explicit) {
  if (backfill || explicit) {
    init(rootFor(process.cwd()));
    if (!KIT.ledger) {
      console.error(`session-ledger: kit.json in ${ROOT} does not set "ledger": true; nothing recorded`);
      process.exitCode = 1;
      return null;
    }
    return backfill ? listTranscripts() : [explicit];
  }
  const payload = await readHookInput();
  init(rootFor(payload.cwd));
  // Quiet when the project keeps no ledger or switched this hook off.
  if (!ledgerHookOn(HOOK_ID, KIT)) return null;
  logHookRun(payload);
  if (typeof payload.transcript_path !== "string") return null;
  return [payload.transcript_path];
}

function parseForRecord(path, explicit) {
  try {
    // The live hook keeps the turns of the checkout the session runs in: a worktree's are recorded there.
    return parseTranscript(path, explicit ? rootOf(path) : ROOT);
  } catch {
    return null;
  }
}

function writeRecords(transcripts, backfill, explicit) {
  let written = 0;
  let skipped = 0;
  for (const path of transcripts) {
    const record = parseForRecord(path, explicit);
    if (!record || isTrivial(record)) {
      skipped += 1;
      continue;
    }
    const { path: writtenPath, authored } = writeRecord(record);
    // Only the live hook and an explicit single transcript may summarize: a backfill would fire one
    // inference per record, which is a surprise bill rather than a feature.
    if (!backfill && authored.size === 0) spawnSummarizer(writtenPath, path);
    written += 1;
  }
  return { written, skipped };
}

/**
 * The summarizer runs `claude -p`, which opens its own session in this project. Without this the
 * child's Stop hook would write a record and summarize it again, forever. `--conflicts` is exempt:
 * returning early there would read as "nothing shared".
 */
function isSummarizerRun(args) {
  return Boolean(process.env.LEDGER_SUMMARIZING) && !args.includes("--conflicts") && !args.includes("--refresh");
}

function recordTranscripts(transcripts, backfill, explicit) {
  const { written, skipped } = writeRecords(transcripts, backfill, explicit);
  if (written === 0 && !existsSync(LEDGER_DIR)) return;
  const total = renderIndex();
  if (backfill || explicit) console.log(`ledger: ${written} record(s) written, ${skipped} skipped, ${total} in index`);
}

async function main() {
  const args = process.argv.slice(2);
  if (isSummarizerRun(args)) return;
  const command = FLAG_COMMANDS.find(([flag]) => args.includes(flag));
  if (command) {
    if (command[0] !== "--help") init(rootFor(process.cwd()));
    return command[1](args);
  }

  const backfill = args.includes("--backfill");
  const explicit = args.includes("--transcript") ? args[args.indexOf("--transcript") + 1] : null;
  const transcripts = await transcriptsToRecord(backfill, explicit);
  if (transcripts) recordTranscripts(transcripts, backfill, explicit);
}

// A hook must never print a stack trace into every session; stay silent on failure.
if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    if (process.argv.includes("--backfill")) throw error;
    // A commit waits on these answers: a crash that looked like "no shared paths" would let it through,
    // and a missing refresh would commit without its trailer.
    if (process.argv.includes("--conflicts") || process.argv.includes("--refresh")) {
      console.error(`session-ledger: ${error?.message ?? error}`);
      process.exitCode = 1;
    }
  });
}
