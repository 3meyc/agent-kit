import { describe, expect, it } from "./session/vitest-compat.mjs";
import { hasUnionLine, mergeBacklog, withTextMerge } from "../plugins/session/scripts/backlog-merge.mjs";

const HEAD = "# Backlog\n\nDeferred follow-ups.\n\n| Source | What | Why | Added | Until |\n| --- | --- | --- | --- | --- |\n";
const row = (source, what = `do ${source}`, until = "2026-12-01") => `| ${source} | ${what} | why | 2026-11-17 | ${until} |\n`;
const file = (...rows) => HEAD + rows.join("");

describe("mergeBacklog", () => {
  it("keeps rows one side removed removed, and adds the rows the other side appended (#56)", () => {
    const base = file(row("a 1"), row("a 2"), row("a 3"));
    const picked = file();
    const appended = file(row("a 1"), row("a 2"), row("a 3"), row("b 1"));
    expect(mergeBacklog({ base, ours: picked, theirs: appended })).toEqual({ text: file(row("b 1")) });
    expect(mergeBacklog({ base, ours: appended, theirs: picked })).toEqual({ text: file(row("b 1")) });
  });

  it("keeps the rows both sides appended, each once, ours first", () => {
    const base = file(row("a 1"));
    expect(mergeBacklog({ base, ours: file(row("a 1"), row("b 1")), theirs: file(row("a 1"), row("c 1"), row("c 2")) })).toEqual({
      text: file(row("a 1"), row("b 1"), row("c 1"), row("c 2")),
    });
  });

  it("removes a row both sides removed once (C1)", () => {
    const base = file(row("a 1"), row("a 2"));
    expect(mergeBacklog({ base, ours: file(row("a 2")), theirs: file(row("a 2")) })).toEqual({ text: file(row("a 2")) });
  });

  it("lets a removal win over an edit of the same row (C2)", () => {
    const base = file(row("a 1"), row("a 2"));
    const edited = file(row("a 1", "do a 1", "2026-12-24"), row("a 2"));
    expect(mergeBacklog({ base, ours: edited, theirs: file(row("a 2")) })).toEqual({ text: file(row("a 2")) });
    expect(mergeBacklog({ base, ours: file(row("a 2")), theirs: edited })).toEqual({ text: file(row("a 2")) });
  });

  it("keeps one row, ours, when both sides added the same Source (C3)", () => {
    expect(mergeBacklog({ base: file(), ours: file(row("b 1", "ours")), theirs: file(row("b 1", "theirs")) })).toEqual({
      text: file(row("b 1", "ours")),
    });
  });

  it("takes the one changed side of the text around the table, and refuses when both changed it (C4)", () => {
    const base = file(row("a 1"));
    const retitled = file(row("a 1")).replace("Deferred follow-ups.", "Deferred work.");
    expect(mergeBacklog({ base, ours: file(row("a 1"), row("b 1")), theirs: retitled })).toEqual({
      text: retitled.replace(row("a 1"), row("a 1") + row("b 1")),
    });
    const other = file(row("a 1")).replace("Deferred follow-ups.", "Something else.");
    expect(mergeBacklog({ base, ours: retitled, theirs: other }).refused).toMatch(/text outside the table/);
  });

  it("reads a missing base as empty, as in an add/add conflict (C5)", () => {
    expect(mergeBacklog({ base: "", ours: file(row("b 1")), theirs: file(row("c 1")) })).toEqual({ text: file(row("b 1"), row("c 1")) });
  });

  it("refuses a side with no table", () => {
    expect(mergeBacklog({ base: file(), ours: "# Backlog\n", theirs: file(row("b 1")) }).refused).toMatch(/no table/);
  });
});

describe("withTextMerge", () => {
  it("adds the backlog's merge=text line once, keeping what the file held", () => {
    expect(withTextMerge("", "docs/sdlc")).toBe("docs/sdlc/backlog.md merge=text\n");
    expect(withTextMerge("*.bin -diff", "work")).toBe("*.bin -diff\nwork/backlog.md merge=text\n");
    expect(withTextMerge("work/backlog.md merge=text\n", "work")).toBe(null);
    expect(withTextMerge("/work/backlog.md  merge=text\n", "work")).toBe(null);
  });
});

describe("hasUnionLine", () => {
  it("finds the union line /backlog used to add, and nothing else", () => {
    expect(hasUnionLine("docs/sdlc/backlog.md merge=union\n", "docs/sdlc")).toBe(true);
    expect(hasUnionLine("*.md text\n/docs/sdlc/backlog.md   merge=union\n", "docs/sdlc")).toBe(true);
    expect(hasUnionLine("docs/sdlc/backlog.md merge=text\n", "docs/sdlc")).toBe(false);
    expect(hasUnionLine("CHANGELOG.md merge=union\n", "docs/sdlc")).toBe(false);
    expect(hasUnionLine("", "docs/sdlc")).toBe(false);
  });
});
