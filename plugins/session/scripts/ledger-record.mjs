import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clip, sentenceTitle } from "./ledger-text.mjs";

/**
 * The text of a session record (testable): rendering it from the parsed transcript, and reading
 * its front matter and hand-written sections back. `session-ledger.mjs` does the file work and runs
 * `main()` on import, which is why these live here.
 */

/** The body sections a session writes itself; the hook renders them but never overwrites them. */
export const AUTHORED_SECTIONS = [
  ["Intent", "What this session was for, and what it found. One or two lines."],
  ["Decisions", "Choices worth not re-litigating, with the reason inline — including what was rejected and why."],
  ["Next", "Imperative call to action for whoever picks this up. `None.` when nothing is owed."],
];

const VIA_SUFFIX = { edit: "", shell: " (shell)", mtime: " (shell, by mtime)" };
const FIRMNESS = { mtime: 0, shell: 1, edit: 2 };

/** Edit times are stored to the second: git's commit times are, and finer only churns the text. */
const toSecond = (iso) => (iso ? `${new Date(iso).toISOString().slice(0, 19)}Z` : null);

/**
 * `## Files` lines: `- <path>[ (shell)| (shell, by mtime)][ · <time>]`; older records have no time.
 * A path may hold spaces (`~/Library/Application Support/…`), so it runs up to the suffixes rather
 * than the first space: every reader of the list goes through here or `filePaths`.
 * @param {string} block
 * @returns {{ path: string, via: "edit" | "shell" | "mtime", at: string | null }[]}
 */
export function parseFileLines(block) {
  return [...block.matchAll(/^- (.+?)(?: \((shell(?:, by mtime)?)\))?(?: · (\S+))?[ \t]*$/gm)].map((m) => ({
    path: m[1],
    via: m[2] === "shell" ? "shell" : m[2] ? "mtime" : "edit",
    at: m[3] ?? null,
  }));
}

/** @param {string} block A `## Files` (or legacy `## Files edited`) list. */
export const filePaths = (block) => parseFileLines(block).map(({ path }) => path);

const filesBlock = (text) => text.split(/^## Files(?: \(\d+\))?\s*$/m)[1]?.split(/^## /m)[0] ?? "";

/**
 * A front-matter string as written: the hook writes JSON (`"…"`), while a session or `/handoff`
 * that types `title:` by hand may leave a plain scalar or a YAML single-quoted one. Every reader of
 * `title` and `prompt` goes through here, so a hand-typed value never fails a read.
 * @param {string | undefined} raw The text after `<field>: `.
 * @returns {string}
 */
export function frontMatterString(raw) {
  const value = String(raw ?? "").trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* `"quoted" then more` is a plain scalar that happens to open with a quote */
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * What a re-render must keep from the record it replaces: the files it listed, with their times,
 * and the commits it stored. A shell edit attributed by mtime is matched against the dirty set, so
 * once committed it would drop out of the file list and rewrite the record after the commit.
 * @param {string} text
 */
export function parsePrevious(text) {
  return { files: parseFileLines(filesBlock(text)), commits: parseFrontMatter(text, "")?.commits ?? [] };
}

/**
 * The previous record's files in their order, then paths new to this render in the transcript's
 * order. A path the transcript stops listing (a committed `rm`/`mv` source, a by-mtime file that
 * is clean again) keeps its place, so dropping it never reorders the list after the last commit.
 */
function mergeFiles(r, previous) {
  const current = new Map(
    r.edited.map((path) => [path, { path, via: r.editedVia.get(path) ?? "edit", at: toSecond(r.editedAt?.get(path)) }]),
  );
  const merged = previous.files.map((before) => {
    const now = current.get(before.path);
    if (!now) return before;
    const at = before.at && (!now.at || before.at > now.at) ? before.at : now.at;
    const via = FIRMNESS[before.via] > FIRMNESS[now.via] ? before.via : now.via;
    return { path: before.path, via, at };
  });
  const listed = new Set(merged.map((file) => file.path));
  return [...merged, ...[...current.values()].filter((file) => !listed.has(file.path))];
}

/**
 * Facts from the hook, meaning from the session — never mixed. Front matter and the file list are
 * computed and cannot lie; every prose section is written by whoever did the work (a commit route,
 * or the summarizer fallback). Nothing here clips a prompt or an assistant message: a truncated
 * quote reads like a record of the session while describing only its first or last minute.
 * @param {object} r The parsed transcript (`emptyRecord` shape in `session-ledger.mjs`).
 *
 * Nothing a commit changes is stored — not pending paths, not an `uncommitted` flag, not the
 * commits a trailer can name — so rendering again after the last commit gives the same bytes.
 * Readers compute those facts from git (`ledger-claims.mjs`).
 * @param {Map<string, string>} authored Sections preserved from the previous write.
 * @param {ReturnType<typeof parsePrevious>} [previous] The record this render replaces.
 */
export function renderRecord(r, authored, previous = { files: [], commits: [] }) {
  const day = r.started.slice(0, 10);
  const files = mergeFiles(r, previous);
  const commits = [...new Set([...previous.commits, ...r.commits.map((h) => h.slice(0, 7))])];
  const title = authored.get("title");
  // Phrase flags come from the latest closing message, so they change every turn. They stand in
  // for a missing `## Next`; once the session has written its own, they add nothing.
  const facts = r.flags.filter((flag) => flag !== "uncommitted");
  const phrases = authored.get("Next") ? [] : (r.phraseFlags ?? []);
  const flags = [
    ...facts.filter((flag) => flag === "continued"),
    ...phrases,
    ...facts.filter((flag) => flag !== "continued"),
  ];

  const lines = ["---", `id: ${r.id}`, `date: ${day}`, `branch: ${r.branch ?? "unknown"}`];
  // The label the index shows. A session's first prompt is a poor name for it — this one opened on
  // MCP connectors and ended rewriting the ledger — so the session names itself and the prompt is
  // only the fallback for a record nobody summarized.
  if (title) lines.push(`title: ${JSON.stringify(title)}`);
  // Commits seen in the transcript (a plain `git commit`) and those an older record stored; the
  // commit script's commits are found by their `Session-Id` trailer instead.
  if (commits.length) lines.push(`commits: [${commits.join(", ")}]`);
  lines.push(`flags: [${flags.join(", ")}]`, "---", "", `# ${day} · ${title ?? r.id.slice(0, 8)}`);

  if (r.memoryFiles.size) lines.push("", `**Memory written:** ${[...r.memoryFiles].join(", ")}`);

  for (const [heading, hint] of AUTHORED_SECTIONS) {
    const written = authored.get(heading);
    if (heading === "Decisions" && !written && r.decisions.length) {
      // AskUserQuestion answers are facts, not prose: the hook may state them when nobody has.
      lines.push("", "## Decisions", "");
      for (const d of r.decisions) {
        lines.push(d.question ? `- ${clip(d.question, 220)} → **${clip(d.answer, 160)}**` : `- ${d.answer}`);
      }
      continue;
    }
    lines.push("", `## ${heading}`, "", written ?? `_${hint}_`);
  }

  if (files.length) {
    lines.push("", `## Files (${files.length})`, "");
    for (const { path, via, at } of files) lines.push(`- ${path}${VIA_SUFFIX[via] ?? ""}${at ? ` · ${at}` : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Sections a session wrote by hand, plus the H1's title when it carries one. The hook must never
 * overwrite these, so every rewrite reads them back first.
 * @param {string} text The record, with `\n` line ends.
 * @returns {Map<string, string>}
 */
export function parseAuthoredSections(text) {
  /** @type {Map<string, string>} */
  const authored = new Map();
  const title = text.match(/^title: (.+)$/m);
  if (title) authored.set("title", frontMatterString(title[1]));
  // Headings this format has used before. `Outcome` and `Result` were dropped once it was clear
  // they restate the commit message; `Open threads` became the imperative `Next`.
  const ALIASES = { "Open threads": "Next", Outcome: "Intent", Result: "Intent" };
  for (const [heading] of [...AUTHORED_SECTIONS, ...Object.keys(ALIASES).map((h) => [h])]) {
    const at = text.search(new RegExp(`^## ${heading}\\s*$`, "m"));
    if (at === -1) continue;
    const body = text.slice(at).split("\n").slice(1).join("\n").split(/^## /m)[0].trim();
    // A placeholder is the hook's own hint, not something a session wrote.
    if (!body || /^_.*_$/s.test(body)) continue;
    const target = ALIASES[heading] ?? heading;
    // A section still under its current name wins over one carried across from an old name.
    if (!authored.has(target) || heading === target) authored.set(target, body);
  }
  return authored;
}

/**
 * First line of a section the hook filled from the session's last `wrap_up` recap rather than
 * from the session's own writing, so a reader knows which it is. A section that opens with it is
 * derived and may be filled again from a newer recap; one without it was written and is kept.
 */
export const RECAP_MARKER = "_(from the session's last recap)_";

/**
 * The authored sections with `Intent` and `Next` filled from the session's last `wrap_up` call
 * where the session wrote neither: the recap already says what was done and what is left, and it
 * costs nothing, where the summarizer costs an inference and only sees the transcript. A written
 * section is never touched; a marked one follows the latest recap. The title comes from the
 * recap's first sentence when the record has none, so the index names the session.
 * @param {Map<string, string>} authored @param {{ recap: string, ask?: string | null }} recap
 * @returns {Map<string, string>} a new map
 */
export function fillFromRecap(authored, { recap, ask }) {
  const filled = new Map(authored);
  const derived = (heading) => !filled.has(heading) || filled.get(heading).startsWith(RECAP_MARKER);
  if (derived("Intent")) filled.set("Intent", `${RECAP_MARKER}\n${recap.trim()}`);
  if (derived("Next"))
    filled.set("Next", `${RECAP_MARKER}\n${ask?.trim() ? `1. Open question at Stop: ${ask.trim()}` : "None."}`);
  const title = filled.get("title") ?? sentenceTitle(recap);
  if (title) filled.set("title", title);
  return filled;
}

/** A `## Next` item starts a line with a bullet or a number; what follows up to the next one is its text. */
const ITEM_START = /^(\s*(?:[-*]|\d+\.)\s+)(.*)$/;
/** The prefix a later session puts on an item it finished: `(done <YYYY-MM-DD> <id8>) <text>`. */
const DONE_PREFIX = /^\(done /;

/**
 * The items of a `## Next` section, in order, with continuation lines folded into the item above.
 * `None.` (with or without a caveat after it) is no items, and so is a section with no bullet at
 * all. An item is `done` once a session has prefixed it; `n` counts every item, done or not, so it
 * names the same line whether or not the ones before it were finished since.
 * @param {string} body The section's text, as `parseAuthoredSections` returns it.
 * @returns {{ n: number, text: string, done: boolean }[]}
 */
export function parseNextItems(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  if (/^\s*none\b/i.test(text)) return [];
  /** @type {{ n: number, text: string, done: boolean }[]} */
  const items = [];
  for (const line of text.split("\n")) {
    const start = line.match(ITEM_START);
    // The prefix sits on the item's first line, so continuation lines cannot change `done`.
    if (start) items.push({ n: items.length + 1, text: start[2].trim(), done: DONE_PREFIX.test(start[2]) });
    else if (items.length && line.trim()) items[items.length - 1].text += ` ${line.trim()}`;
  }
  return items;
}

/**
 * The record with item `n` of its `## Next` prefixed `(done <stamp>) `: one line changes and nothing
 * else, so the front matter and `## Files` the hook owns stay as they were. Throws when the record
 * has no such item or it is already marked, so the caller can refuse rather than guess.
 * @param {string} text The whole record, with `\n` line ends. @param {number} n 1-based.
 * @param {string} stamp `<YYYY-MM-DD> <id8>` of the session that finished it.
 */
export function markDone(text, n, stamp) {
  const lines = text.split("\n");
  // `Open threads` is the heading this section had before it became `Next`.
  const heading = lines.findIndex((line) => /^## (?:Next|Open threads)\s*$/.test(line));
  if (heading === -1) throw new Error("the record has no `## Next` section");
  let count = 0;
  for (let i = heading + 1; i < lines.length && !/^## /.test(lines[i]); i += 1) {
    const start = lines[i].match(ITEM_START);
    if (!start) continue;
    count += 1;
    if (count !== n) continue;
    if (DONE_PREFIX.test(start[2])) throw new Error(`item ${n} is already marked done`);
    lines[i] = `${start[1]}(done ${stamp}) ${start[2]}`;
    return lines.join("\n");
  }
  throw new Error(`the record has ${count} Next item(s), not ${n}`);
}

const DONE_MARK = /^(\s*(?:[-*]|\d+\.)\s+)\(done \d{4}-\d{2}-\d{2} ([^\s)]+)\) (.*)$/;

/**
 * The inverse of `markDone`: the id8s that signed the marks turning `before` into `after`, or null
 * when the two differ in anything else. A worktree commit uses it to tell a session's own
 * `--done … --as <id8>` on another session's record from an edit of that record.
 * @param {string} before @param {string} after
 * @returns {string[] | null}
 */
export function doneMarks(before, after) {
  const was = before.replace(/\r\n/g, "\n").split("\n");
  const now = after.replace(/\r\n/g, "\n").split("\n");
  if (was.length !== now.length) return null;
  const ids = [];
  let inNext = false;
  for (let i = 0; i < was.length; i += 1) {
    if (/^## /.test(was[i])) inNext = /^## (?:Next|Open threads)\s*$/.test(was[i]);
    if (was[i] === now[i]) continue;
    const start = was[i].match(ITEM_START);
    const mark = now[i].match(DONE_MARK);
    const isMark =
      inNext && start && mark && !DONE_PREFIX.test(start[2]) && mark[1] === start[1] && mark[3] === start[2];
    if (!isMark) return null;
    ids.push(mark[2]);
  }
  return ids.length ? ids.sort() : null;
}

/**
 * Front matter is the only part of a record the index needs; parsing it beats re-reading transcripts.
 * @param {string} text The record, with `\n` line ends. @param {string} file Its file name.
 */
export function parseFrontMatter(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const meta = { file };
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(": ");
    if (idx === -1) continue;
    meta[line.slice(0, idx)] = line.slice(idx + 2);
  }
  // A session that named itself gets that name in the index. Older records fall back to their
  // first prompt; a record with neither is shown by id rather than by a misleading quote.
  meta.prompt = frontMatterString(meta.prompt);
  meta.label = frontMatterString(meta.title) || meta.prompt || `(unsummarized ${meta.file.slice(11, 19)})`;
  meta.commits = (meta.commits ?? "[]")
    .replace(/^\[|\]$/g, "")
    .split(", ")
    .filter(Boolean);
  meta.flags = (meta.flags ?? "[]")
    .replace(/^\[|\]$/g, "")
    .split(", ")
    .filter(Boolean);

  // Three shapes have existed: the file list as a `## Files` footer (current), as an `edited: [...]`
  // front-matter array, and as a `## Files edited` body section with `edited: <count>`. Read all
  // three so the older records stay indexable instead of silently dropping out of the index.
  const editedRaw = meta.edited ?? "";
  const footer = filesBlock(text);
  const legacyBody = text.split(/^## Files edited.*$/m)[1]?.split(/^## /m)[0] ?? "";
  if (footer.trim()) meta.editedPaths = filePaths(footer);
  else if (editedRaw.startsWith("[")) meta.editedPaths = JSON.parse(editedRaw).map((e) => e.split(" ")[0]);
  else meta.editedPaths = filePaths(legacyBody);
  // New-format records carry each file's last edit time; older ones have none.
  meta.editedAt = new Map(parseFileLines(footer).flatMap(({ path, at }) => (at ? [[path, at]] : [])));
  meta.editedCount = editedRaw && !editedRaw.startsWith("[") ? Number(editedRaw) : meta.editedPaths.length;
  // Absent `pending` means every edited file is still dirty; older records always spell it out.
  meta.pending = meta.pending === undefined ? meta.editedPaths : JSON.parse(meta.pending);
  return meta;
}

/** Where `session-ledger.mjs --archive` moves records older than its cut-off; their file names stay. */
export const ARCHIVE_DIR = "archive";
const RECORD_NAME = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/;

/**
 * The record files of a ledger folder, newest first: the live folder, plus `archive/` when asked.
 * A reader that looks a record up by session id asks for the archive (a record keeps its name
 * when it moves); the brief's ranking, the index rows and the summarizer read the live folder only.
 * @param {string} ledgerDir @param {{ archive?: boolean }} [options]
 * @returns {{ name: string, path: string, archived: boolean }[]}
 */
export function listRecords(ledgerDir, { archive = false } = {}) {
  const read = (dir, archived) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => RECORD_NAME.test(name))
          .map((name) => ({ name, path: join(dir, name), archived }))
      : [];
  const records = [...read(ledgerDir, false), ...(archive ? read(join(ledgerDir, ARCHIVE_DIR), true) : [])];
  return records.sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * The path of a record by file name: the live folder first, then `archive/`, else null. Links to
 * records by their live path are never rewritten when they move; this is how a reader follows one.
 * @param {string} ledgerDir @param {string} name
 */
export function resolveRecordPath(ledgerDir, name) {
  for (const dir of [ledgerDir, join(ledgerDir, ARCHIVE_DIR)]) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Whether a record still owes work: a `## Next` item nobody marked `(done …)`. `None.`, a
 * placeholder, a missing section and a section of done items all owe nothing. The archive guard:
 * a record with an open Next never leaves the folder the brief and `--owed` scan.
 * @param {string} text The record, with `\n` line ends.
 */
export function isNextOpen(text) {
  return parseNextItems(parseAuthoredSections(text).get("Next")).some((item) => !item.done);
}
