import { describe, expect, it } from "./session/vitest-compat.mjs";
import { parseRecord, publicRemote, renderExport } from "../plugins/session/scripts/ledger-export.mjs";
import { findSecrets } from "../plugins/session/scripts/ledger-text.mjs";

const RECORD = `---
id: 7fe19a1f-59ce-4b7e-9391-f2a6a71e7f64
date: 2026-09-25
branch: feat/x
title: "Adopt handoff ideas into the ledger"
commits: [4221530, 3ee080b]
flags: [process-change]
---

# 2026-09-25 · Adopt handoff ideas into the ledger

## Intent

Port five handoff ideas.

## Decisions

- (unverified) The summarizer honours the prefix.

## Next

1. Resume: \`scripts/hooks/ledger-export.mjs\` half-done; run \`pnpm run test\`.

## Files (2)

- scripts/hooks/ledger-export.mjs
- CLAUDE.md (shell)
`;

const facts = {
  repo: "my-app",
  remote: "https://github.com/org/my-app",
  branch: "feat/x",
  head: "0009b28",
  dirty: 2,
  date: "2026-09-25",
  recordPath: ".claude/ledger/2026-09-25-7fe19a1f.md",
};

describe("parseRecord", () => {
  it("reads title, commits, files and the authored sections", () => {
    const r = parseRecord(RECORD);
    expect(r.title).toBe("Adopt handoff ideas into the ledger");
    expect(r.commits).toEqual(["4221530", "3ee080b"]);
    expect(r.files).toEqual(["scripts/hooks/ledger-export.mjs", "CLAUDE.md"]);
    expect(r.sections.get("Next")).toContain("Resume:");
  });

  it("skips placeholder sections", () => {
    expect(parseRecord(RECORD.replace("Port five handoff ideas.", "_hint_")).sections.has("Intent")).toBe(false);
  });
});

describe("publicRemote", () => {
  it("drops credentials from an https remote", () => {
    expect(publicRemote("https://user:secret-token@github.com/org/repo.git")).toBe("https://github.com/org/repo");
  });

  it("turns an ssh remote into https", () => {
    expect(publicRemote("git@github.com:org/repo.git")).toBe("https://github.com/org/repo");
  });
});

describe("renderExport", () => {
  const out = renderExport({ ...facts, note: "Continue item 5 in another repo." }, parseRecord(RECORD));

  it("carries the git header and the note", () => {
    expect(out).toContain("feat/x` at `0009b28`");
    expect(out).toContain("dirty (2 path(s)");
    expect(out).toContain("**For the next agent:** Continue item 5 in another repo.");
    expect(out).toContain("**Suggested start:**");
  });

  it("keeps the sections with their (unverified) prefixes", () => {
    expect(out).toContain("## Decisions\n\n- (unverified) The summarizer honours the prefix.");
    expect(out).toContain("1. Resume:");
  });

  it("links commits and names files by path only", () => {
    expect(out).toContain("https://github.com/org/my-app/commit/4221530");
    expect(out).toContain("`scripts/hooks/ledger-export.mjs`");
    expect(out).not.toContain("diff --git");
  });

  it("redacts a secret that reached the record", () => {
    const key = `sk-${"ant"}-${"q".repeat(30)}`;
    const leaked = renderExport(facts, parseRecord(RECORD.replace("Port five", `Port ${key} five`)));
    expect(leaked).not.toContain(key);
    expect(findSecrets(leaked)).toEqual([]);
  });
});
