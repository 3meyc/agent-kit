/**
 * `<paths.sdlc>/backlog.md` merges by its rows, not by git's lines (#56).
 *
 * A union merge keeps both sides of a conflicting hunk, so rows one side removed (`/backlog pick`,
 * `expire`) came back when the other side appended a row beside them. The backlog now merges as
 * text, so such a merge conflicts, and `worktree-flow regenerate` resolves the conflict here: a
 * three-way merge of the table's rows keyed by **Source**, the first cell.
 *
 * A merge reads the attributes of the side checked out, so a branch cut before the project dropped
 * the union line would still merge by union. `ensureBacklogMerge` therefore sets `merge=text` for
 * the backlog in the clone's `info/attributes`, which outranks every `.gitattributes`; the
 * `worktree-setup` SessionStart hook and `worktree-flow conflicts` both call it.
 *
 * Node built-ins only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { escapeRegExp, readKit } from "../lib/kit-config.mjs";

/** Lines of a text, each keeping its newline. @param {string} text */
function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const SEPARATOR = /^\|\s*:?-{3,}/;

/**
 * The text before and after the table, and its rows; null when there is no table. An empty text
 * (a side git has no copy of) is an empty file.
 * @param {string} text
 * @returns {{ head: string, rows: string[], tail: string } | null}
 */
function parse(text) {
  if (text === "") return { head: "", rows: [], tail: "" };
  const all = lines(text);
  const sep = all.findIndex((line) => SEPARATOR.test(line));
  if (sep < 0) return null;
  let end = sep + 1;
  while (end < all.length && all[end].startsWith("|")) end += 1;
  return { head: all.slice(0, sep + 1).join(""), rows: all.slice(sep + 1, end), tail: all.slice(end).join("") };
}

/** A row's Source, its first cell. @param {string} row */
const sourceOf = (row) => row.split("|")[1].trim();

/** One block three ways: the side that changed it, or null when both changed it differently. */
function threeWay(base, ours, theirs) {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  return null;
}

/**
 * Merge three copies of the backlog. A row either side removed stays removed (a removal wins over
 * an edit of the same row); a row either side added is added once, ours first. The text around
 * the table merges as whole blocks and is refused when both sides changed it differently. Pure.
 * @param {{ base: string, ours: string, theirs: string }} sides
 * @returns {{ text: string } | { refused: string }}
 */
export function mergeBacklog({ base, ours, theirs }) {
  const [b, o, t] = [parse(base), parse(ours), parse(theirs)];
  if (!b || !o || !t) return { refused: "a side has no table; resolve it by hand" };
  const head = threeWay(b.head, o.head, t.head);
  const tail = threeWay(b.tail, o.tail, t.tail);
  if (head === null || tail === null) return { refused: "both sides changed the text outside the table; resolve it by hand" };
  const inBase = new Set(b.rows.map(sourceOf));
  const inOurs = new Set(o.rows.map(sourceOf));
  const inTheirs = new Set(t.rows.map(sourceOf));
  const kept = o.rows.filter((row) => !(inBase.has(sourceOf(row)) && !inTheirs.has(sourceOf(row))));
  const added = t.rows.filter((row) => !inBase.has(sourceOf(row)) && !inOurs.has(sourceOf(row)));
  return { text: head + kept.join("") + added.join("") + tail };
}

/** An attributes line for the backlog that sets `merge=<driver>`. @param {string} sdlc @param {string} driver */
const backlogLine = (sdlc, driver) => new RegExp(`^\\s*/?${escapeRegExp(`${sdlc}/backlog.md`)}\\s.*\\bmerge=${driver}\\b`, "m");

/**
 * `info/attributes` text with the backlog's `merge=text` line added, or null when it is there.
 * Pure. @param {string} text @param {string} sdlc
 */
export function withTextMerge(text, sdlc) {
  if (backlogLine(sdlc, "text").test(text)) return null;
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${sdlc}/backlog.md merge=text\n`;
}

/** Whether a `.gitattributes` text still merges the backlog by union. Pure. @param {string} text @param {string} sdlc */
export function hasUnionLine(text, sdlc) {
  return backlogLine(sdlc, "union").test(text);
}

/** The line `worktree-flow conflicts` prints while the union line is in `.gitattributes`. @param {string} sdlc */
export const unionLineNote = (sdlc) =>
  `backlog: .gitattributes still merges ${sdlc}/backlog.md by union, which brings removed rows back; delete that line (/backlog does on its next triage, pick or expire)`;

/**
 * In a project with a `kit.json`: make sure the clone's `info/attributes` merges the backlog as
 * text, and say whether `.gitattributes` still holds the union line. Never throws.
 * @param {string} top the checkout's top folder
 * @returns {{ sdlc: string, error: string | null, union: boolean }}
 */
export function ensureBacklogMerge(top) {
  const sdlc = readKit(top).paths.sdlc;
  if (!existsSync(join(top, "kit.json"))) return { sdlc, error: null, union: false };
  let error = null;
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: top, encoding: "utf8" });
  if (common.status === 0) {
    const file = join(resolve(top, common.stdout.trim()), "info", "attributes");
    try {
      const next = withTextMerge(existsSync(file) ? readFileSync(file, "utf8") : "", sdlc);
      if (next !== null) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, next);
      }
    } catch (caught) {
      error = `backlog: could not set merge=text for ${sdlc}/backlog.md in ${file}: ${caught instanceof Error ? caught.message : caught}`;
    }
  }
  let union = false;
  try {
    union = hasUnionLine(readFileSync(join(top, ".gitattributes"), "utf8"), sdlc);
  } catch {
    // No .gitattributes: nothing left over.
  }
  return { sdlc, error, union };
}
