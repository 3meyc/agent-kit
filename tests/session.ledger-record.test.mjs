import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "./session/vitest-compat.mjs";
import {
  RECAP_MARKER,
  doneMarks,
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
} from "../plugins/session/scripts/ledger-record.mjs";

function record(overrides = {}) {
  return {
    id: "2796e327-fff6-4c0e-b520-e86ead69a34c",
    started: "2026-09-27T05:40:00.000Z",
    branch: "chore/x",
    edited: ["scripts/a.mjs", "docs/b.md"],
    editedVia: new Map([
      ["scripts/a.mjs", "edit"],
      ["docs/b.md", "mtime"],
    ]),
    pending: ["scripts/a.mjs", "docs/b.md"],
    commits: [],
    memoryFiles: new Set(),
    decisions: [],
    flags: ["uncommitted"],
    ...overrides,
  };
}

describe("renderRecord", () => {
  // Settled format: `uncommitted` is no longer stored (it is computed when read), so the fixture's
  // flag does not reach the text; everything else is as before the move.
  it("renders front matter, placeholders and the file list", () => {
    expect(renderRecord(record(), new Map())).toBe(
      [
        "---",
        "id: 2796e327-fff6-4c0e-b520-e86ead69a34c",
        "date: 2026-09-27",
        "branch: chore/x",
        "flags: []",
        "---",
        "",
        "# 2026-09-27 · 2796e327",
        "",
        "## Intent",
        "",
        "_What this session was for, and what it found. One or two lines._",
        "",
        "## Decisions",
        "",
        "_Choices worth not re-litigating, with the reason inline — including what was rejected and why._",
        "",
        "## Next",
        "",
        "_Imperative call to action for whoever picks this up. `None.` when nothing is owed._",
        "",
        "## Files (2)",
        "",
        "- scripts/a.mjs",
        "- docs/b.md (shell, by mtime)",
        "",
      ].join("\n"),
    );
  });

  // Settled format: `pending:` is no longer stored; the commits line and authored sections are.
  it("keeps authored sections, the title and the commits, and no longer stores pending", () => {
    const text = renderRecord(
      record({ commits: ["4303c6bdeadbeef"], pending: ["docs/b.md"] }),
      new Map([
        ["title", "Shared-tree commits"],
        ["Next", "None."],
      ]),
    );
    expect(text).toContain('title: "Shared-tree commits"\ncommits: [4303c6b]\nflags: []\n');
    expect(text).toContain("# 2026-09-27 · Shared-tree commits");
    expect(text).toContain("## Next\n\nNone.\n");
  });

  it("states AskUserQuestion answers when nobody wrote Decisions", () => {
    const text = renderRecord(record({ decisions: [{ question: "Branch?", answer: "main" }] }), new Map());
    expect(text).toContain("## Decisions\n\n- Branch? → **main**\n");
  });
});

describe("parseAuthoredSections", () => {
  it("reads the title and written sections, skipping placeholders", () => {
    const authored = parseAuthoredSections(renderRecord(record(), new Map([["Intent", "Did a thing."]])));
    expect([...authored]).toEqual([["Intent", "Did a thing."]]);
  });

  it("carries old headings across to their current names", () => {
    const authored = parseAuthoredSections('title: "Old"\n\n## Outcome\n\nDone.\n\n## Open threads\n\nShip it.\n');
    expect(Object.fromEntries(authored)).toEqual({ title: "Old", Intent: "Done.", Next: "Ship it." });
  });
});

describe("parseNextItems", () => {
  it("reads numbered and bulleted items, folding continuation lines into the item above", () => {
    const body = [
      "1. `/check` — run the suite once more",
      "   after the merge lands.",
      "- (unverified) `docs/x.md` — confirm the table",
      "* third",
    ].join("\n");
    expect(parseNextItems(body)).toEqual([
      { n: 1, text: "`/check` — run the suite once more after the merge lands.", done: false },
      { n: 2, text: "(unverified) `docs/x.md` — confirm the table", done: false },
      { n: 3, text: "third", done: false },
    ]);
  });

  it("marks a prefixed item done and keeps its number", () => {
    const items = parseNextItems("1. (done 2026-10-23 abcd1234) first\n2. second");
    expect(items.map((i) => [i.n, i.done])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("yields nothing for None., a caveat after None., an empty body, or prose without items", () => {
    expect(parseNextItems("None.")).toEqual([]);
    expect(parseNextItems("None. The e2e specs were not run (VPN).")).toEqual([]);
    expect(parseNextItems("")).toEqual([]);
    expect(parseNextItems(undefined)).toEqual([]);
    expect(parseNextItems("_(from the session's last recap)_\nNothing owed.")).toEqual([]);
  });
});

describe("fillFromRecap", () => {
  const recap = { recap: "Built the fill. Nothing committed yet.", ask: "Commit now?" };

  it("fills Intent, Next and the title when the session wrote nothing", () => {
    expect(Object.fromEntries(fillFromRecap(new Map(), recap))).toEqual({
      Intent: `${RECAP_MARKER}\nBuilt the fill. Nothing committed yet.`,
      Next: `${RECAP_MARKER}\n1. Open question at Stop: Commit now?`,
      title: "Built the fill",
    });
  });

  it("keeps a written section and title, re-fills a marked one, and says None. without an ask", () => {
    const authored = new Map([
      ["title", "Own title"],
      ["Intent", "Hand-written."],
      ["Next", `${RECAP_MARKER}\n1. Open question at Stop: old?`],
      ["Decisions", "- kept"],
    ]);
    const filled = fillFromRecap(authored, { recap: "Newer recap.", ask: "" });
    expect(Object.fromEntries(filled)).toEqual({
      title: "Own title",
      Intent: "Hand-written.",
      Next: `${RECAP_MARKER}\nNone.`,
      Decisions: "- kept",
    });
    expect(authored.get("Next")).toContain("old?");
  });

  it("renders a marked section as authored, so a re-render reads it back and fills it again", () => {
    const first = renderRecord(record(), fillFromRecap(new Map(), recap));
    const again = renderRecord(record(), fillFromRecap(parseAuthoredSections(first), recap));
    expect(again).toBe(first);
    expect(first).toMatch(/^title: "Built the fill"$/m);
  });
});

describe("markDone", () => {
  const text = [
    "---",
    "id: x",
    "---",
    "",
    "## Next",
    "",
    "1. first",
    "   continued.",
    "2. (done 2026-10-01 11111111) second",
    "3. third",
    "",
    "## Files (1)",
    "",
    "- a.md",
    "",
  ].join("\n");

  it("changes exactly the item's first line", () => {
    const marked = markDone(text, 3, "2026-10-23 abcd1234");
    const changed = marked.split("\n").filter((line, i) => line !== text.split("\n")[i]);
    expect(changed).toEqual(["3. (done 2026-10-23 abcd1234) third"]);
    expect(marked.split("\n").length).toBe(text.split("\n").length);
  });

  it("marks the item of an old `Open threads` heading too", () => {
    const old = text.replace("## Next", "## Open threads");
    expect(markDone(old, 1, "2026-10-23 abcd1234")).toContain("1. (done 2026-10-23 abcd1234) first");
  });

  it("refuses an item already done, one out of range, and a record without the section", () => {
    expect(() => markDone(text, 2, "s")).toThrow(/already marked done/);
    expect(() => markDone(text, 4, "s")).toThrow(/has 3 Next item\(s\), not 4/);
    expect(() => markDone(text, 0, "s")).toThrow(/not 0/);
    expect(() => markDone("## Intent\n\nx\n", 1, "s")).toThrow(/no `## Next`/);
  });
});

describe("doneMarks", () => {
  const text = ["## Intent", "", "1. not an item of Next", "", "## Next", "", "1. first", "2. second", ""].join("\n");

  it("returns the id8 of every mark markDone made, and nothing else", () => {
    const once = markDone(text, 2, "2026-10-24 abcd1234");
    expect(doneMarks(text, once)).toEqual(["abcd1234"]);
    expect(doneMarks(text, markDone(once, 1, "2026-10-24 11112222"))).toEqual(["11112222", "abcd1234"]);
    expect(doneMarks(text.replace(/\n/g, "\r\n"), once)).toEqual(["abcd1234"]);
  });

  it("is null for any other edit, alone or beside a mark", () => {
    const marked = markDone(text, 1, "2026-10-24 abcd1234");
    expect(doneMarks(text, text)).toBeNull();
    expect(doneMarks(text, marked.replace("second", "2nd"))).toBeNull();
    expect(doneMarks(text, `${marked}extra\n`)).toBeNull();
    expect(doneMarks(text, marked.replace("first", "changed"))).toBeNull();
    // Outside `## Next` the same prefix is an edit, not a mark.
    expect(doneMarks(text, text.replace("1. not", "1. (done 2026-10-24 abcd1234) not"))).toBeNull();
  });
});

describe("parseFrontMatter", () => {
  // Settled format: the rendered record carries no `uncommitted` flag to read back.
  it("reads a record: label, flags, files, and pending defaulting to every file", () => {
    const meta = parseFrontMatter(renderRecord(record(), new Map()), "2026-09-27-2796e327.md");
    expect(meta).toMatchObject({
      id: "2796e327-fff6-4c0e-b520-e86ead69a34c",
      label: "(unsummarized 2796e327)",
      flags: [],
      commits: [],
      editedPaths: ["scripts/a.mjs", "docs/b.md"],
      pending: ["scripts/a.mjs", "docs/b.md"],
    });
  });

  it("reads the older front-matter file list and a stored pending", () => {
    const text = '---\nid: x\ndate: 2026-09-01\nedited: ["a.ts (shell)", "b.ts"]\npending: ["b.ts"]\nflags: []\n---\n';
    expect(parseFrontMatter(text, "2026-09-01-xxxxxxxx.md")).toMatchObject({
      editedPaths: ["a.ts", "b.ts"],
      editedCount: 2,
      pending: ["b.ts"],
    });
  });

  it("returns null without front matter", () => {
    expect(parseFrontMatter("# no front matter\n", "x.md")).toBeNull();
  });
});

describe("settled format", () => {
  const at = new Map([
    ["scripts/a.mjs", "2026-09-27T09:12:05.321Z"],
    ["docs/b.md", "2026-09-27T09:20:00.000Z"],
  ]);
  const settled = (overrides = {}) =>
    record({ editedAt: at, flags: ["process-change"], phraseFlags: ["follow-up"], ...overrides });

  it("renders the same bytes when rendered again from its own output", () => {
    const first = renderRecord(settled(), new Map());
    const again = renderRecord(settled(), parseAuthoredSections(first), parsePrevious(first));
    expect(again).toBe(first);
  });

  it("lists each file with its last edit time, to the second", () => {
    const text = renderRecord(settled(), new Map());
    expect(text).toContain(
      "- scripts/a.mjs · 2026-09-27T09:12:05Z\n- docs/b.md (shell, by mtime) · 2026-09-27T09:20:00Z\n",
    );
    expect(parseFrontMatter(text, "2026-09-27-2796e327.md").editedAt).toEqual(
      new Map([
        ["scripts/a.mjs", "2026-09-27T09:12:05Z"],
        ["docs/b.md", "2026-09-27T09:20:00Z"],
      ]),
    );
  });

  it("keeps a path the previous record listed after it drops out of the transcript's dirty set", () => {
    const first = renderRecord(settled(), new Map());
    const committed = settled({ edited: ["scripts/a.mjs"], editedVia: new Map([["scripts/a.mjs", "edit"]]) });
    const again = renderRecord(committed, parseAuthoredSections(first), parsePrevious(first));
    expect(again).toContain("- docs/b.md (shell, by mtime) · 2026-09-27T09:20:00Z");
    expect(again).toContain("## Files (2)");
  });

  it("renders the same bytes when a path that is not last drops out of the transcript", () => {
    // `rm old.md` / `mv a b`: once committed, the named source is gone and clean, so the
    // transcript no longer lists it. Moving it would rewrite the record after the last commit.
    const first = renderRecord(settled(), new Map([["Next", "None."]]));
    const dropped = settled({ edited: ["docs/b.md"], editedVia: new Map([["docs/b.md", "mtime"]]) });
    expect(renderRecord(dropped, parseAuthoredSections(first), parsePrevious(first))).toBe(first);
  });

  it("stores neither pending nor uncommitted", () => {
    const text = renderRecord(settled({ pending: ["docs/b.md"], flags: ["uncommitted", "process-change"] }), new Map());
    expect(text).not.toMatch(/^pending:/m);
    expect(text).toMatch(/^flags: \[follow-up, process-change\]$/m);
  });

  it("shows phrase flags only while the session has not written its Next", () => {
    const withNext = renderRecord(settled(), new Map([["Next", "None."]]));
    expect(withNext).toMatch(/^flags: \[process-change\]$/m);
  });

  it("carries commits the previous record stored alongside the transcript's", () => {
    const first = renderRecord(settled({ commits: ["06df1d5aaaa"] }), new Map());
    const again = renderRecord(
      settled({ commits: ["92c56adbbbb"] }),
      parseAuthoredSections(first),
      parsePrevious(first),
    );
    expect(again).toMatch(/^commits: \[06df1d5, 92c56ad\]$/m);
  });

  it("reads a path with spaces back whole, with its kind and time", () => {
    // An Edit/Write outside the repo is stored home-relative, and macOS's notes folder has a space.
    const notes = "~/Library/Application Support/Claude/side-session-notes/x/findings.md";
    const spaced = settled({
      edited: [notes, "docs/a b.md"],
      editedVia: new Map([
        [notes, "edit"],
        ["docs/a b.md", "shell"],
      ]),
      editedAt: new Map([
        [notes, "2026-09-27T09:12:05Z"],
        ["docs/a b.md", "2026-09-27T09:20:00Z"],
      ]),
    });
    const first = renderRecord(spaced, new Map());
    expect(first).toContain(`- ${notes} · 2026-09-27T09:12:05Z\n- docs/a b.md (shell) · 2026-09-27T09:20:00Z\n`);
    const meta = parseFrontMatter(first, "2026-09-27-2796e327.md");
    expect(meta.editedPaths).toEqual([notes, "docs/a b.md"]);
    expect(meta.editedAt.get(notes)).toBe("2026-09-27T09:12:05Z");
    expect(parsePrevious(first).files.map((f) => [f.path, f.via])).toEqual([
      [notes, "edit"],
      ["docs/a b.md", "shell"],
    ]);
    expect(renderRecord(spaced, parseAuthoredSections(first), parsePrevious(first))).toBe(first);
  });
});

describe("listRecords, resolveRecordPath and isNextOpen", () => {
  const record = (next) => `---\nid: x\n---\n\n## Intent\n\nx\n\n## Next\n\n${next}\n\n## Files (0)\n`;
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-record-"));
    mkdirSync(join(dir, "archive"));
    writeFileSync(join(dir, "2026-10-20-aaaaaaaa.md"), record("None."));
    writeFileSync(join(dir, "2026-10-21-bbbbbbbb.md"), record("1. open"));
    writeFileSync(join(dir, "INDEX.md"), "index\n");
    writeFileSync(join(dir, "2026-10-21-bbbbbbbb.md.123.tmp"), "half-written\n");
    writeFileSync(join(dir, "archive", "2026-06-01-cccccccc.md"), record("None."));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the live folder newest first, and the archive after it only when asked", () => {
    expect(listRecords(dir).map((r) => r.name)).toEqual(["2026-10-21-bbbbbbbb.md", "2026-10-20-aaaaaaaa.md"]);
    expect(listRecords(dir, { archive: true }).map((r) => [r.name, r.archived])).toEqual([
      ["2026-10-21-bbbbbbbb.md", false],
      ["2026-10-20-aaaaaaaa.md", false],
      ["2026-06-01-cccccccc.md", true],
    ]);
    expect(listRecords(join(dir, "missing"))).toEqual([]);
  });

  it("resolves a record by name into the live folder, then the archive, else null", () => {
    expect(resolveRecordPath(dir, "2026-10-20-aaaaaaaa.md")).toBe(join(dir, "2026-10-20-aaaaaaaa.md"));
    expect(resolveRecordPath(dir, "2026-06-01-cccccccc.md")).toBe(join(dir, "archive", "2026-06-01-cccccccc.md"));
    expect(resolveRecordPath(dir, "2026-01-01-dddddddd.md")).toBeNull();
  });

  it("calls a Next open only while an item is not marked done", () => {
    expect(isNextOpen(record("1. open"))).toBe(true);
    expect(isNextOpen(record("1. (done 2026-10-23 abcd1234) a\n2. (done 2026-10-23 abcd1234) b"))).toBe(false);
    expect(isNextOpen(record("None."))).toBe(false);
    expect(isNextOpen(record("_Imperative call to action for whoever picks this up._"))).toBe(false);
    expect(isNextOpen("---\nid: x\n---\n\n## Intent\n\nx\n")).toBe(false);
  });
});
