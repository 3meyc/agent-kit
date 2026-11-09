import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "./session/vitest-compat.mjs";
import {
  applySummary,
  applyTitle,
  buildPrompt,
  parseSummary,
  looksLikeContinuation,
  needsSummary,
  redactRecord,
  SUMMARIZER_MARKER,
  summarizeRecord,
  titleFromIntent,
} from "../plugins/session/scripts/ledger-summarize.mjs";
import { RECAP_MARKER } from "../plugins/session/scripts/ledger-record.mjs";

/** A record the Stop hook filled from a recap: Intent and Next derived, Decisions still a placeholder. */
const RECAP_RECORD = `---
id: abc123
date: 2026-09-19
title: "Built the fill"
branch: feat/x
flags: []
---

# 2026-09-19 · Built the fill

## Intent

${RECAP_MARKER}
Built the fill. Nothing committed yet.

## Decisions

_Choices worth not re-litigating._

## Next

${RECAP_MARKER}
1. Open question at Stop: Commit now?
`;

const RECORD = `---
id: abc123
date: 2026-09-19
branch: feat/x
flags: []
---

# 2026-09-19 · abc123

## Intent

_What this session was for, and what it found._

## Decisions

- Keep the adapter → **it is cheaper than a rewrite**

## Next

_Imperative call to action._

## Files (1)

- docs/a.md
`;

describe("parseSummary", () => {
  it("splits the title from the sections", () => {
    const { title, sections } = parseSummary("TITLE: Fixed the upload gate\n## Intent\nWhy.\n## Next\n- do it");
    expect(title).toBe("Fixed the upload gate");
    expect(sections.get("Intent")).toBe("Why.");
    expect(sections.get("Next")).toBe("- do it");
  });

  it("ignores a section with no body", () => {
    expect(parseSummary("TITLE: x\n## Intent\n\n## Next\n- y").sections.has("Intent")).toBe(false);
  });
});

describe("applySummary", () => {
  it("fills placeholders and leaves authored sections alone", () => {
    const out = applySummary(RECORD, {
      title: "Located the Nextcloud auth docs",
      sections: new Map([
        ["Intent", "Found where auth is documented."],
        ["Next", "- Run the backfill on the other machine."],
        ["Decisions", "- the model should not overwrite this"],
      ]),
    });
    expect(out).toContain("## Intent\n\nFound where auth is documented.");
    expect(out).toContain("## Next\n\n- Run the backfill on the other machine.");
    // Decisions already carried real content, so the summary must not replace it.
    expect(out).toContain("- Keep the adapter → **it is cheaper than a rewrite**");
    expect(out).not.toContain("the model should not overwrite this");
  });

  it("keeps the blank line before the next heading", () => {
    const out = applySummary(RECORD, { sections: new Map([["Intent", "One line."]]) });
    expect(out).toContain("One line.\n\n## Decisions");
  });

  it("adds the title to the front matter and the H1", () => {
    const out = applySummary(RECORD, { title: "Located the auth docs", sections: new Map() });
    expect(out).toContain('title: "Located the auth docs"');
    expect(out).toContain("# 2026-09-19 · Located the auth docs");
  });

  it("does not add a title twice", () => {
    const once = applySummary(RECORD, { title: "A", sections: new Map() });
    expect(applySummary(once, { title: "B", sections: new Map() })).not.toContain('title: "B"');
  });

  it("never replaces a section the Stop hook derived from a recap", () => {
    const out = applySummary(RECAP_RECORD, {
      sections: new Map([
        ["Intent", "MODEL INTENT"],
        ["Next", "MODEL NEXT"],
        ["Decisions", "- a model decision"],
      ]),
    });
    expect(out).toContain(`## Intent\n\n${RECAP_MARKER}\nBuilt the fill. Nothing committed yet.`);
    expect(out).toContain(`## Next\n\n${RECAP_MARKER}\n1. Open question at Stop: Commit now?`);
    expect(out).not.toContain("MODEL");
    expect(out).toContain("## Decisions\n\n- a model decision");
  });
});

describe("needsSummary", () => {
  it("is true for a record with a placeholder and no recap, false once a recap filled it or everything is written", () => {
    expect(needsSummary(RECORD)).toBe(true);
    expect(needsSummary(RECAP_RECORD)).toBe(false);
    expect(
      needsSummary(
        applySummary(RECORD, {
          sections: new Map([
            ["Intent", "x"],
            ["Next", "y"],
          ]),
        }),
      ),
    ).toBe(false);
  });
});

describe("summarizeRecord", () => {
  /** A record as `--transcript` first writes it: every section still the hook's placeholder. */
  const UNWRITTEN = RECORD.replace(
    "- Keep the adapter → **it is cheaper than a rewrite**",
    "_Choices worth not re-litigating._",
  );
  const REPLY = "TITLE: Model title\n## Intent\nMODEL INTENT\n## Decisions\n- MODEL DECISION\n## Next\n- MODEL NEXT";
  let dir = "";

  /** Run the summarizer while `handEdit` stands in for the session writing its record mid-call. */
  function summarizeWhile(handEdit) {
    dir = mkdtempSync(join(tmpdir(), "ledger-summarize-"));
    const recordPath = join(dir, "2026-09-19-abc123.md");
    const transcriptPath = join(dir, "abc123.jsonl");
    writeFileSync(recordPath, UNWRITTEN);
    writeFileSync(transcriptPath, `${JSON.stringify({ type: "user", message: { content: "Fix the gate" } })}\n`);
    const attempt = summarizeRecord(recordPath, transcriptPath, () => {
      writeFileSync(recordPath, handEdit(readFileSync(recordPath, "utf8")));
      return REPLY;
    });
    return { attempt, text: readFileSync(recordPath, "utf8") };
  }

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("leaves a record the session wrote while the model ran exactly as the session wrote it", () => {
    let handWritten = "";
    const { attempt, text } = summarizeWhile((before) => {
      handWritten = before
        .replace("date: 2026-09-19\n", 'date: 2026-09-19\ntitle: "Hand title"\n')
        .replace("_What this session was for, and what it found._", "Hand intent.")
        .replace("_Choices worth not re-litigating._", "- Hand decision")
        .replace("_Imperative call to action._", "None.");
      return handWritten;
    });
    expect(attempt).toBe(0);
    expect(text).toBe(handWritten);
    expect(text).not.toContain("MODEL");
  });

  it("fills only the sections still a placeholder on disk at write time", () => {
    const { attempt, text } = summarizeWhile((before) =>
      before.replace("_What this session was for, and what it found._", "Hand intent."),
    );
    expect(attempt).toBe(1);
    expect(text).toContain("## Intent\n\nHand intent.\n\n## Decisions\n\n- MODEL DECISION");
    expect(text).toContain("## Next\n\n- MODEL NEXT");
    expect(text).not.toContain("MODEL INTENT");
  });
});

describe("buildPrompt", () => {
  it("carries the recursion marker so the child transcript is never recorded", () => {
    expect(buildPrompt([{ role: "User", text: "hi" }], ["a.ts"])).toContain(SUMMARIZER_MARKER);
  });

  it("includes the edited files and the turns", () => {
    const prompt = buildPrompt([{ role: "User", text: "fix the gate" }], ["src/a.ts"]);
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("[User] fix the gate");
  });

  it("asks each Next bullet to start with its entry point", () => {
    expect(buildPrompt([], [])).toContain("Each bullet starts with its entry point in backticks");
  });

  it("asks for the (unverified) prefix on unchecked items", () => {
    expect(buildPrompt([], [])).toContain('Start a Decisions or Next item with "(unverified)"');
  });
});

describe("titleFromIntent", () => {
  const record = (intent) =>
    `---\ndate: 2026-09-19\n---\n\n# 2026-09-19 · abc123\n\n## Intent\n\n${intent}\n\n## Next\n\nNone.\n`;

  it("takes the first sentence", () => {
    expect(titleFromIntent(record("Fixed the upload gate. Then tidied the tests."))).toBe("Fixed the upload gate");
  });

  it("flattens a wrapped sentence", () => {
    expect(titleFromIntent(record("Audited the\n  hook output. More."))).toBe("Audited the hook output");
  });

  it("ignores a placeholder body", () => {
    expect(titleFromIntent(record("_What this session was for._"))).toBeUndefined();
  });

  it("truncates an over-long sentence", () => {
    const long = `${"word ".repeat(30)}end.`;
    expect(titleFromIntent(record(long)).length).toBeLessThanOrEqual(70);
  });

  it("skips the recap marker of a derived Intent", () => {
    expect(titleFromIntent(RECAP_RECORD.replace('title: "Built the fill"\n', ""))).toBe("Built the fill");
  });

  it("returns undefined without an Intent section", () => {
    expect(titleFromIntent("---\ndate: x\n---\n\n# h\n")).toBeUndefined();
  });
});

describe("applyTitle", () => {
  const record = "---\ndate: 2026-09-19\n---\n\n# 2026-09-19 · abc123\n\n## Intent\n\nFixed the gate.\n";

  it("derives a title when the model returned none", () => {
    const out = applyTitle(record);
    expect(out).toContain('title: "Fixed the gate"');
    expect(out).toContain("# 2026-09-19 · Fixed the gate");
  });

  it("prefers the model's title", () => {
    expect(applyTitle(record, "Model supplied name")).toContain('title: "Model supplied name"');
  });

  it("never overwrites an existing title", () => {
    const titled = record.replace("date: 2026-09-19", 'date: 2026-09-19\ntitle: "Kept"');
    expect(applyTitle(titled, "New")).toBe(titled);
  });
});

describe("looksLikeContinuation", () => {
  it("rejects a reply that calls tools", () => {
    expect(looksLikeContinuation('ok\n<function_calls>\n<invoke name="bash">')).toBe(true);
  });

  it("rejects a reply that offers to keep working", () => {
    expect(looksLikeContinuation("Done. Want me to run the linter now?")).toBe(true);
  });

  it("accepts a plain summary", () => {
    expect(looksLikeContinuation("TITLE: Fixed the gate\n## Intent\n\nIt was broken.")).toBe(false);
  });
});

describe("redactRecord", () => {
  // Assembled at runtime so the source never carries a literal token.
  const key = `ghp${"_"}${"k3".repeat(18)}`;

  it("redacts a key and adds the flag", () => {
    const out = redactRecord(RECORD.replace("- docs/a.md", `- docs/a.md\n\nPasted ${key}`));
    expect(out).not.toContain(key);
    expect(out).toContain("[redacted]");
    expect(out).toContain("flags: [secret-redacted]");
  });

  it("appends to existing flags once", () => {
    const once = redactRecord(`${RECORD.replace("flags: []", "flags: [uncommitted]")}\n${key}\n`);
    expect(once).toContain("flags: [uncommitted, secret-redacted]\n");
    expect(redactRecord(`${once}${key}\n`)).toContain("flags: [uncommitted, secret-redacted]\n");
  });

  it("leaves a clean record untouched", () => {
    expect(redactRecord(RECORD)).toBe(RECORD);
  });
});
