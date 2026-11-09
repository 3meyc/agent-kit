/**
 * SessionStart hook (id `ledger-brief`): put the ledger in front of the session instead of asking it
 * to go looking. Its stdout becomes context in the session.
 *
 * Asking sessions to read the ledger's `INDEX.md` does not work: they skip it — a voluntary
 * read at the moment the agent is most eager to start working loses every time.
 * This emits a short digest into the session's context, so the cost of knowing is zero and the
 * ledger is only opened when a row looks relevant.
 *
 * Deliberately small: the newest few sessions, whatever they left owed, and the files more than
 * one recent session has touched. Everything else stays one click away in the index.
 *
 * A worktree session's own unmerged records live in the worktree's ledger, so the checkout comes
 * from the payload's `cwd` (`rootFor`), as for the Stop hook. Quiet unless `kit.json` sets
 * `"ledger": true` and does not list `ledger-brief` in `hooks.off`. Every scan reads the live
 * folder only: `session-ledger --archive` moves nothing that still owes work, so `archive/` has
 * nothing for the brief.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitDirtyFiles, isDirectRun, parseWorktrees, readHookInput } from "../lib/hook-utils.mjs";
import { ledgerDir, ledgerHookOn, readKit, rootFor } from "../lib/kit-config.mjs";
import { UNCOMMITTED_RECORD_DAYS, openPaths } from "./ledger-claims.mjs";
import { filePaths, listRecords, parseFileLines, parseNextItems } from "./ledger-record.mjs";
import { clip } from "./ledger-text.mjs";
import { readCommitFacts } from "./ledger-utils.mjs";
import { mergedCleanWorktrees } from "./worktree-flow.mjs";

/** This plugin's hook id, as `kit.json` `hooks.off` names it. */
export const HOOK_ID = "ledger-brief";

// The checkout and its ledger, set by `main` from the payload before anything reads them.
let ROOT = "";
let KIT = readKit(".");
let LEDGER_DIR = "";
const RECENT = 5;
// Rank across a wider window than is shown, so a run of housekeeping sessions cannot push a
// session that left work owed off the brief entirely.
const CANDIDATES = 12;
// The two newest are always shown whatever they scored: "what just happened" is why the brief is
// read, and a quiet session immediately before yours is still the one most likely to collide.
const ALWAYS_NEWEST = 2;
const SHARED_FROM = 6;
const NEXT_ITEMS_PER_RECORD = 3;
// The brief is injected into every session, so it has to stay scannable. Past roughly twenty
// lines it becomes the thing people skip, which is what it was built to stop.
const MAX_OWED_LINES = 6;
const MAX_LINE = 118;
const MAX_SHARED = 6;
// Sessions in other worktrees, not merged here yet: always counted for shared files, a few shown.
const MAX_OTHER_WORKTREES = 3;

/** @param {string} path */
function readRecord(path) {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const field = (name) => text.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1];
  const section = (name) => {
    const at = text.search(new RegExp(`^## ${name}\\s*$`, "m"));
    if (at === -1) return "";
    const body = text.slice(at).split("\n").slice(1).join("\n").split(/^## /m)[0].trim();
    return /^_.*_$/s.test(body) ? "" : body;
  };
  const files = text.split(/^## Files(?: \(\d+\))?\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  let title = field("title") ?? "";
  try {
    title = title ? JSON.parse(title) : "";
  } catch {
    /* a hand-edited title without quotes is still a title */
  }
  // Records predating `title` still carry their first prompt; use it rather than showing a bare id.
  // Those prompts open with the other machine's absolute path often enough that the label would be
  // all path and no task, so strip that here — the renderer no longer quotes prompts at all.
  let prompt = field("prompt") ?? "";
  try {
    prompt = prompt ? JSON.parse(prompt) : "";
  } catch {
    /* an unquoted prompt is still a prompt */
  }
  prompt = prompt.replace(/^\s*Repository:\s*\S+\.?\s*/i, "").trim();
  return {
    id: field("id") ?? "",
    date: field("date") ?? "",
    title,
    prompt,
    flags: (field("flags") ?? "[]")
      .replace(/^\[|\]$/g, "")
      .split(", ")
      .filter(Boolean),
    next: section("Next") || section("Open threads"),
    decisions: section("Decisions"),
    commits: /^commits: \[.+\]$/m.test(text),
    paths: filePaths(files),
    editedAt: new Map(parseFileLines(files).flatMap(({ path, at }) => (at ? [[path, at]] : []))),
  };
}

/**
 * The other worktrees of this repository, from `git worktree list --porcelain`. A session in a
 * fresh worktree sees only records merged into its base; the collision it most needs to hear about
 * is a neighbour's unmerged work, which lives in that neighbour's worktree.
 * @param {string} porcelain @param {string} self This checkout's root.
 * @returns {{ path: string, branch: string }[]}
 */
export function worktreeRoots(porcelain, self) {
  return parseWorktrees(porcelain)
    .filter((tree) => !tree.bare && resolve(tree.path) !== resolve(self))
    .map(({ path, branch }) => ({ path, branch: branch ?? "detached" }));
}

/**
 * One line naming worktrees that hold nothing unlanded, so they get removed rather than pile up:
 * left alone, they pile up unnoticed. Silent when there are none.
 * @param {number} count
 */
export function removableLine(count) {
  if (count === 0) return "";
  const what = count === 1 ? "1 other worktree is" : `${count} other worktrees are`;
  return `${what} merged and clean — safe to remove: worktree-flow status (✓ rows).`;
}

/**
 * Record files in another worktree's ledger that this checkout does not have: work not merged
 * here yet. Newest first; a record already here is the same session and is not counted twice.
 * Records before `sinceDay` are left out, or an abandoned worktree would feed old sessions forever.
 * @param {string[]} names @param {Set<string>} own @param {string} [sinceDay] `YYYY-MM-DD`
 */
export function unmergedRecordNames(names, own, sinceDay = "") {
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/.test(name) && !own.has(name))
    .filter((name) => name.slice(0, 10) >= sinceDay)
    .sort()
    .reverse();
}

/**
 * Records no longer store what a commit changes, so the brief computes it: `uncommitted` from a
 * settled record's open paths, commits from `Session-Id` trailers. An older record keeps the
 * flags and commits it stored.
 * @template {{ id: string, flags: string[], commits: boolean, editedAt: Map<string, string> }} R
 * @param {R} r
 * @param {{ lastCommitSec: (path: string) => number | null, dirty: Set<string>, commitsBySession: Map<string, string[]> }} facts
 * @returns {R}
 */
export function withComputedFacts(r, { lastCommitSec, dirty, commitsBySession }) {
  const commits = r.commits || (commitsBySession.get(r.id)?.length ?? 0) > 0;
  if (!r.editedAt.size) return { ...r, commits };
  const files = [...r.editedAt].map(([path, at]) => ({ path, at }));
  const open = openPaths(files, lastCommitSec, dirty).length > 0;
  return { ...r, commits, flags: open ? [...r.flags, "uncommitted"] : r.flags };
}

/**
 * A section that opens with "None." carries no signal, whatever follows it — the model likes to
 * answer "None." and then add a caveat, and the caveat is not work anyone owes.
 * @param {string} body
 */
function isEmptySection(body) {
  return !body || /^none\b/i.test(body.trim());
}

/**
 * What a record still owes: its `## Next` items minus those a later session marked `(done …)`.
 * A record whose every item is done owes nothing, however long its section.
 * @param {string} body
 */
export function openNextItems(body) {
  return parseNextItems(body).filter((item) => !item.done);
}

/**
 * What a record is worth to the session about to start. Unfinished work ranks above reasoning,
 * which ranks above having merely touched the repo — a session that produced no code but decided
 * something is worth more here than one that edited ten files and concluded nothing.
 * @param {ReturnType<typeof readRecord>} r
 */
function signal(r) {
  return (
    (openNextItems(r.next).length ? 3 : 0) +
    (isEmptySection(r.decisions) ? 0 : 2) +
    (r.paths.length || r.commits ? 1 : 0)
  );
}

/**
 * Items a session wrote without checking them. The marker is a prefix because `MAX_LINE` clips
 * the end of a line; a suffix would be cut exactly where it matters. An item since marked done
 * is no longer a claim anyone relies on.
 * @param {string} body
 */
export function countUnverified(body) {
  return openNextItems(body).filter((item) => /^\(unverified\)/i.test(item.text)).length;
}

/**
 * One line for the owed work the brief does not show: the open items of every record outside the
 * ones listed above it, with the command that lists them. Empty at zero, so the brief grows by a
 * line only when there is something behind it.
 * @param {number} items @param {number} records
 */
export function owedCountLine(items, records) {
  if (items === 0) return "";
  const what = items === 1 ? "1 open Next item" : `${items} open Next items`;
  const where = records === 1 ? "1 older record" : `${records} older records`;
  return `${what} in ${where} — session-ledger --owed`;
}

/** A record's title, else its prompt, else its session id prefix; clipped to `width`. */
function labelOf(r, width) {
  const label = r.title || r.prompt || r.name.slice(11, 19);
  return label.length > width ? `${label.slice(0, width - 1)}…` : label;
}

/** The newest `CANDIDATES` live records, with the facts a commit changes computed from git. */
function readCandidates(names) {
  const commitFacts = readCommitFacts(ROOT);
  const facts = {
    lastCommitSec: (path) => commitFacts.lastCommit.get(path) ?? commitFacts.sinceSec,
    dirty: gitDirtyFiles(ROOT),
    commitsBySession: commitFacts.commitsBySession,
  };
  return names
    .slice(0, CANDIDATES)
    .map((n) => ({ name: n, ...withComputedFacts(readRecord(join(LEDGER_DIR, n)), facts) }));
}

/**
 * Recent records in the other worktrees' ledgers that this checkout lacks; `own` grows as they are
 * read, so a record in two worktrees counts once.
 * @param {Set<string>} own
 * @returns {(ReturnType<typeof readRecord> & { name: string, branch: string })[]}
 */
function otherWorktreeRecords(own) {
  const sinceDay = new Date(Date.now() - UNCOMMITTED_RECORD_DAYS * 86_400_000).toISOString().slice(0, 10);
  const others = [];
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  for (const { path, branch } of worktreeRoots(listed.status === 0 ? listed.stdout : "", ROOT)) {
    // Another worktree on another branch may keep its ledger elsewhere; its own kit.json says.
    const dir = ledgerDir(path, readKit(path));
    if (!existsSync(dir)) continue;
    for (const name of unmergedRecordNames(readdirSync(dir), own, sinceDay).slice(0, CANDIDATES)) {
      own.add(name);
      others.push({ name, branch, ...readRecord(join(dir, name)) });
    }
  }
  return others;
}

/** The newest few always, the rest by signal; shown newest first so the list still reads as a timeline. */
function pickShown(candidates) {
  const newest = candidates.slice(0, ALWAYS_NEWEST);
  const ranked = candidates
    .slice(ALWAYS_NEWEST)
    .sort((a, b) => signal(b) - signal(a) || b.name.localeCompare(a.name))
    .slice(0, Math.max(0, RECENT - newest.length));
  return [...newest, ...ranked].sort((a, b) => b.name.localeCompare(a.name));
}

function recentLines(shown) {
  const lines = [`Recent sessions in this repo (from ${KIT.paths.ledger}/, by what they left behind):`, ""];
  for (const r of shown) {
    const flags = r.flags.length ? ` [${r.flags.join(" ")}]` : "";
    lines.push(`- ${r.date} ${labelOf(r, 80)}${flags}`);
  }
  return lines;
}

function otherWorktreeLines(others) {
  if (!others.length) return [];
  const lines = ["", "In other worktrees, not merged here:"];
  for (const r of others.slice(0, MAX_OTHER_WORKTREES)) lines.push(`- ${r.date} ${labelOf(r, 70)} @${r.branch}`);
  return lines;
}

function removableLines() {
  const removable = removableLine(mergedCleanWorktrees(ROOT).length);
  return removable ? ["", removable] : [];
}

function owedLines(shown) {
  const owed = shown.map((r) => openNextItems(r.next)).filter((items) => items.length);
  if (!owed.length) return [];
  const items = [];
  for (const open of owed) {
    // A `Next` item can run to a paragraph; the brief shows the instruction, the record holds the
    // reasoning. One line per item, its number kept so `--done <id8> <n>` names it; clip rather
    // than let one entry dominate the whole digest.
    for (const item of open.slice(0, NEXT_ITEMS_PER_RECORD)) items.push(`  ${item.n}. ${clip(item.text, MAX_LINE)}`);
  }
  const lines = ["", "Left owed by those sessions:", ...items.slice(0, MAX_OWED_LINES)];
  if (items.length > MAX_OWED_LINES) lines.push(`  … more in the records below`);
  return lines;
}

/**
 * The rest of the ledger owes work too, often far more than the shown records, and the brief would
 * never show it again. One line says how much and where to list it; nothing when there is none.
 */
function olderOwedLines(shown) {
  const shownNames = new Set(shown.map((r) => r.name));
  let olderItems = 0;
  let olderRecords = 0;
  // Live folder only: `--archive` never moves a record with an open item, so the archive owes
  // nothing by construction and reading it would grow this scan by the size the archive bounds.
  for (const { name, path } of listRecords(LEDGER_DIR, { archive: false })) {
    if (shownNames.has(name)) continue;
    const open = openNextItems(readRecord(path).next).length;
    if (open === 0) continue;
    olderItems += open;
    olderRecords += 1;
  }
  const older = owedCountLine(olderItems, olderRecords);
  return older ? ["", older] : [];
}

/**
 * One line, not a list: the brief tells every session to trust these records, so it must say
 * when some of their claims were never checked — without growing past what gets read.
 */
function unverifiedLines(shown) {
  const unverified = shown.reduce((n, r) => n + countUnverified(r.decisions) + countUnverified(r.next), 0);
  return unverified > 0 ? ["", `${unverified} item(s) marked (unverified) — confirm before relying on them.`] : [];
}

function sharedLines(records, withOthers) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const r of records) for (const p of new Set(r.paths)) counts.set(p, (counts.get(p) ?? 0) + 1);
  const shared = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  if (!shared.length) return [];
  const scope = withOthers
    ? `the last ${SHARED_FROM} sessions and other worktrees`
    : `the last ${SHARED_FROM} sessions`;
  const lines = ["", `Touched by more than one of ${scope} — check before editing:`];
  for (const [path, n] of shared.slice(0, MAX_SHARED)) lines.push(`  ${path} (${n})`);
  return lines;
}

/** @param {{ cwd?: unknown }} payload */
async function main(payload) {
  ROOT = rootFor(payload.cwd);
  KIT = readKit(ROOT);
  if (!ledgerHookOn(HOOK_ID, KIT)) return;
  LEDGER_DIR = ledgerDir(ROOT, KIT);
  const names = listRecords(LEDGER_DIR, { archive: false }).map((r) => r.name);
  if (names.length === 0) return;

  const candidates = readCandidates(names);
  const others = otherWorktreeRecords(new Set(names));
  const shown = pickShown(candidates);
  const lines = [
    ...recentLines(shown),
    ...otherWorktreeLines(others),
    ...removableLines(),
    ...owedLines(shown),
    ...olderOwedLines(shown),
    ...unverifiedLines(shown),
    ...sharedLines([...candidates.slice(0, SHARED_FROM), ...others], others.length > 0),
    "",
    `Open the record under ${KIT.paths.ledger}/ before reopening any topic above.`,
  ];
  console.log(lines.join("\n"));
}

// Only as the hook, so a test can import `countUnverified` without printing a brief.
if (isDirectRun(import.meta.url)) {
  try {
    // A terminal run has no payload to wait for.
    await main(process.stdin.isTTY ? {} : await readHookInput());
  } catch {
    // A session must start whether or not its ledger can be read.
  }
}
