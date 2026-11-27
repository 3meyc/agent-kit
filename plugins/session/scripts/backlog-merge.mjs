/**
 * `<paths.sdlc>/backlog.md` merges by its rows, not by git's lines (#56).
 *
 * A union merge keeps both sides of a conflicting hunk, so rows one side removed (`/backlog pick`,
 * `expire`) came back when the other side appended a row beside them. The backlog now merges as
 * text, so such a merge conflicts, and `worktree-flow regenerate` resolves the conflict here: a
 * three-way merge of the table's rows keyed by **Source**, the first cell.
 *
 * Node built-ins only.
 */

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
