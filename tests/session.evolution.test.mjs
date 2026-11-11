// The session plugin's evolution pages: the page reader, the diagram lint, version bumps, the
// commit classifier, the templates, and the commands against a scratch repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { normalizeKit } from "../shared/kit-config.mjs";
import { compare } from "../plugins/core/src/docs-parity.mjs";
import {
  applyBump,
  changelogPath,
  unreleasedItems,
  classifyCommits,
  cmdBump,
  cmdCheck,
  cmdInit,
  cmdStatus,
  lintMermaid,
  lintPage,
  mirrorLanguages,
  nextVersion,
  parseLog,
  parsePage,
  template,
} from "../plugins/session/scripts/evolution.mjs";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-kit-evolution-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd, ...args) =>
  spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

const PAGE = `---
id: process-evolution
version: 1.2.0
last_verified: 2026-10-01
---

# How the way of working grew

Printable version: [PDF/process-evolution-v1.2.0.pdf](PDF/process-evolution-v1.2.0.pdf).

\`\`\`mermaid
flowchart TD
  EXT["other repo"]
  subgraph s1["Stage 1: start"]
    rules["[agent config] Rules<br/>first skills"]
    hooks["[tooling] Hooks"]
    rules --> hooks
  end
  EXT -. "from: skills, 09-12" .-> rules
  hooks -- later --> rules
  classDef tooling fill:#dee2e6
  classDef agentConfig fill:#a5d8ff
  class rules agentConfig
  class hooks tooling
\`\`\`

## Legend

1. Boxes in commit order.

## Sources

| Node | When | Source |
| --- | --- | --- |
| Rules | 2026-09-01 | \`feat(agent): add rules\` |
| Hooks | 2026-09-02 | \`feat(hooks): add hooks\` |
`;

const errors = (findings) => findings.filter((f) => f.level === "error").map((f) => f.message);
const warns = (findings) => findings.filter((f) => f.level === "warn").map((f) => f.message);

describe("parsePage", () => {
  it("reads the front matter, the diagram, the Sources rows and the printable link", () => {
    const page = parsePage(PAGE);
    assert.equal(page.version, "1.2.0");
    assert.equal(page.lastVerified, "2026-10-01");
    assert.equal(page.title, "How the way of working grew");
    assert.equal(page.sourcesRows, 2);
    assert.deepEqual(page.printable, [{ link: "PDF/process-evolution-v1.2.0.pdf", version: "1.2.0" }]);
    assert.match(page.mermaid, /^flowchart TD/);
  });

  it("takes quoted values and CRLF line ends", () => {
    const page = parsePage(PAGE.replace("version: 1.2.0", 'version: "1.2.0"').replace(/\n/g, "\r\n"));
    assert.equal(page.version, "1.2.0");
    assert.equal(page.sourcesRows, 2);
  });
});

describe("lintMermaid", () => {
  it("passes a well-formed flowchart, link text included", () => {
    const lint = lintMermaid(parsePage(PAGE).mermaid);
    assert.equal(lint.checked, true);
    assert.deepEqual(lint.findings, []);
    assert.deepEqual(lint.ids, ["EXT", "hooks", "rules", "s1"]);
  });

  it("fails an unclosed quote, a missing end and an undefined class", () => {
    const lint = lintMermaid('flowchart TD\n  subgraph s1["x"]\n    a["open]\n  class a nope\n');
    assert.deepEqual(errors(lint.findings), [
      "line 3: a quote is not closed",
      "1 `subgraph` without its `end`",
      "line 4: class `nope` has no `classDef`",
    ]);
  });

  it("fails unbalanced brackets and a stray end", () => {
    const lint = lintMermaid('flowchart TD\n  a["x"\n  end\n');
    assert.deepEqual(errors(lint.findings), ["line 2: 1 `[` against 0 `]`", "line 3: `end` without a `subgraph`"]);
  });

  it("warns on an id used but never labelled, once", () => {
    const lint = lintMermaid('flowchart TD\n  rules["Rules"]\n  rules --> rulse\n  rulse --> rules\n');
    assert.deepEqual(warns(lint.findings), ["line 3: `rulse` (edge) is not defined with a label; a typo draws a new empty box"]);
  });

  it("counts a bare node line as a definition and ignores --o and --x heads", () => {
    const lint = lintMermaid("flowchart LR\n  a & b\n  a --o b\n  b --x a\n");
    assert.deepEqual(lint.findings, []);
  });

  it("does not check another diagram type", () => {
    const lint = lintMermaid("timeline\n  2026 : start\n");
    assert.equal(lint.checked, false);
    assert.deepEqual(lint.findings, []);
  });
});

describe("lintPage", () => {
  it("passes the sample page", () => assert.deepEqual(lintPage(PAGE), []));

  it("fails a printable link that names another version, and a bad front matter", () => {
    const text = PAGE.replace("version: 1.2.0", "version: 1.3").replace("last_verified: 2026-10-01", "last_verified: 01.10.2026");
    assert.deepEqual(errors(lintPage(text)), [
      "`version: 1.3` is not MAJOR.MINOR.PATCH",
      "`last_verified: 01.10.2026` is not YYYY-MM-DD",
      "the printable link PDF/process-evolution-v1.2.0.pdf names v1.2.0, the page is v1.3: run `evolution bump` or re-render",
    ]);
  });

  it("fails a mirror with another version or other boxes", () => {
    const mirror = PAGE.replace("version: 1.2.0", "version: 1.1.0").replace('hooks["[tooling] Hooks"]', 'hookz["[tooling] Хуки"]').replace(/rules --> hooks/, "rules --> hookz").replace("hooks -- later", "hookz -- later").replace("class hooks", "class hookz");
    assert.deepEqual(errors(lintPage(PAGE, [{ name: "p.uk.md", text: mirror }])), [
      "p.uk.md is v1.1.0, the page is v1.2.0",
      "p.uk.md lacks the boxes hooks",
      "p.uk.md has boxes the page lacks: hookz",
    ]);
  });

  it("fails a page with no diagram and warns on one with no Sources", () => {
    const findings = lintPage("---\nversion: 1.0.0\nlast_verified: 2026-01-01\n---\n\n# T\n");
    assert.deepEqual(errors(findings), ["no ```mermaid block"]);
    assert.equal(warns(findings).length, 1);
  });
});

describe("bumps", () => {
  it("raises minor or patch", () => {
    assert.equal(nextVersion("1.13.4", "minor"), "1.14.0");
    assert.equal(nextVersion("1.13.4", "patch"), "1.13.5");
    assert.throws(() => nextVersion("1.13", "minor"));
  });

  it("sets version and last_verified and moves the printable link", () => {
    const bumped = parsePage(applyBump(PAGE, "1.3.0", "2026-11-11"));
    assert.equal(bumped.version, "1.3.0");
    assert.equal(bumped.lastVerified, "2026-11-11");
    assert.deepEqual(bumped.printable.map((p) => p.version), ["1.3.0"]);
    assert.deepEqual(lintPage(applyBump(PAGE, "1.3.0", "2026-11-11")), []);
  });

  it("adds a missing last_verified", () => {
    const text = applyBump("---\nid: x\nversion: 1.0.0\n---\n\n# T\n", "1.1.0", "2026-11-11");
    assert.match(text, /^---\nid: x\nversion: 1.1.0\nlast_verified: 2026-11-11\n---\n/);
  });
});

describe("classifyCommits", () => {
  const log = parseLog(
    "\x1e2026-11-01\x1ffeat(agent): add a review skill\n\n.claude/skills/review/SKILL.md\n" +
      "\x1e2026-11-02\x1ffeat(export): CSV export\n\nsrc/export.ts\nCLAUDE.md\n" +
      "\x1e2026-11-03\x1ffix(export): quote cells\n\nsrc/export.ts\n" +
      "\x1e2026-11-04\x1fci: run e2e\n\n.github/workflows/ci.yml\n" +
      "\x1e2026-11-05\x1fdocs: ADR on storage\n\ndocs/decisions/ADR-002.md\n",
  );

  it("parses the log", () => {
    assert.equal(log.length, 5);
    assert.deepEqual(log[1], { date: "2026-11-02", subject: "feat(export): CSV export", files: ["src/export.ts", "CLAUDE.md"] });
  });

  it("puts process paths on the process page and product feat commits on the features page", () => {
    const { process, features } = classifyCommits(log, ["docs/decisions"]);
    assert.deepEqual(process.map((c) => c.subject), ["feat(agent): add a review skill", "feat(export): CSV export", "ci: run e2e", "docs: ADR on storage"]);
    assert.deepEqual(process[1].files, ["CLAUDE.md"]);
    assert.deepEqual(features.map((c) => c.subject), ["feat(export): CSV export"]);
  });
});

describe("the changelog's Unreleased lines", () => {
  it("reads each top-level item with its wrapped lines, up to the next heading", () => {
    const text = "# C\n\n## Unreleased\n\n- core: one,\n  wrapped.\n* sdlc: two.\n\n## 2026-01-01 — first\n\n- old.\n";
    assert.deepEqual(unreleasedItems(text), ["core: one, wrapped.", "sdlc: two."]);
    assert.deepEqual(unreleasedItems("# C\n\n## 2026-01-01\n\n- old.\n"), []);
  });

  it("takes the first changelog of release.notes without a language", () => {
    assert.equal(changelogPath(normalizeKit({ project: "t" })), "CHANGELOG.md");
    const notes = [{ path: "docs/releases.md", format: "table" }, { path: "CHANGES.uk.md", lang: "uk" }, "docs/CHANGES.md"];
    assert.equal(changelogPath(normalizeKit({ project: "t", release: { notes } })), "docs/CHANGES.md");
  });
});

describe("templates", () => {
  for (const kind of ["process", "features"]) {
    it(`${kind}: the page and its Ukrainian mirror pass the check and the docs parity`, () => {
      const en = template(kind, "2026-11-11", ["uk"]);
      const uk = template(kind, "2026-11-11", ["uk"], "uk");
      assert.deepEqual(lintPage(en, [{ name: "m.uk.md", text: uk }]), []);
      const name = `${kind}-evolution`;
      assert.deepEqual(compare(en, uk, `${name}.md`, `${name}.uk.md`), []);
    });
  }

  it("has no switch line without mirrors", () => {
    assert.doesNotMatch(template("process", "2026-11-11"), /English/);
  });
});

describe("commands", () => {
  const repo = join(scratch, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.hooksPath", "no-hooks");
  writeFileSync(join(repo, "README.md"), "# R\n\n**English** · [Українська](README.uk.md)\n");
  writeFileSync(join(repo, "README.uk.md"), "# R\n\n[English](README.md) · **Українська**\n");
  writeFileSync(join(repo, "kit.json"), JSON.stringify({ project: "t", commands: { evolutionRender: "render {page}" } }));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "chore: start", "--date=2026-11-01T12:00:00");
  const kit = normalizeKit(JSON.parse(readFileSync(join(repo, "kit.json"), "utf8")));
  const lines = [];
  const print = (line) => lines.push(line);

  it("status with no pages says how to start them", () => {
    lines.length = 0;
    assert.equal(cmdStatus(repo, kit, [], print), 0);
    assert.match(lines[0], /No evolution pages in docs\/evolution/);
  });

  it("init writes both pages and a mirror per language the repo keeps", () => {
    assert.deepEqual(mirrorLanguages(repo), ["uk"]);
    lines.length = 0;
    cmdInit(repo, kit, [], print, "2026-11-01");
    assert.equal(lines.filter((line) => line.startsWith("wrote")).length, 4);
    lines.length = 0;
    cmdInit(repo, kit, [], print, "2026-11-01");
    assert.equal(lines.filter((line) => line.startsWith("kept")).length, 4);
    assert.equal(cmdCheck(repo, kit, [], print), 0);
  });

  it("status lists the commits after last_verified that the page does not name", () => {
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "docs: start the evolution pages", "--date=2026-11-01T13:00:00");
    mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
    writeFileSync(join(repo, ".claude", "rules", "x.md"), "x\n");
    writeFileSync(join(repo, "app.js"), "x\n");
    git(repo, "add", ".");
    const env = { ...process.env, GIT_COMMITTER_DATE: "2026-11-05T12:00:00" };
    spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "feat(app): first screen", "--date=2026-11-05T12:00:00"], { cwd: repo, env });
    lines.length = 0;
    cmdStatus(repo, kit, [], print);
    const text = lines.join("\n");
    assert.match(text, /1\. process-evolution\.md v1\.0\.0, last verified 2026-11-01, 1 Sources rows; mirrors process-evolution\.uk\.md; check passed/);
    assert.match(text, /1\.1\. 2026-11-05 `feat\(app\): first screen` — \.claude\/rules\/x\.md/);
    assert.match(text, /2\.1\. 2026-11-05 `feat\(app\): first screen`\n/);
    lines.length = 0;
    cmdStatus(repo, kit, ["--base", "HEAD"], print);
    assert.match(lines.join("\n"), /Nothing changed the way of working in HEAD\.\.HEAD/);
  });

  it("status --since-release counts from the release tag and takes the features from Unreleased", () => {
    git(repo, "tag", "stable", "HEAD~1");
    writeFileSync(join(repo, "CHANGELOG.md"), "# C\n\n## Unreleased\n\n- app: the first screen.\n");
    lines.length = 0;
    cmdStatus(repo, kit, ["--since-release"], print);
    const text = lines.join("\n");
    assert.match(text, /^Evolution pages in docs\/evolution, counting from stable:/);
    assert.match(text, /process-evolution\.md v1\.0\.0, .*; unchanged since stable; check passed/);
    assert.match(text, /1\.1\. 2026-11-05 `feat\(app\): first screen` — \.claude\/rules\/x\.md/);
    assert.match(text, /Its candidates are the CHANGELOG\.md `## Unreleased` lines \(3 below\)/);
    assert.match(text, /3\. CHANGELOG\.md `## Unreleased`: 1 line, the triaged list for this release/);
    assert.match(text, /3\.1\. app: the first screen\./);
    rmSync(join(repo, "CHANGELOG.md"));
  });

  it("bump raises the page and its mirror and runs the renderer with the page", () => {
    const ran = [];
    lines.length = 0;
    const code = cmdBump(repo, kit, ["process", "--date", "2026-11-06"], print, (command) => {
      ran.push(command);
      return 0;
    });
    assert.equal(code, 0);
    assert.deepEqual(ran, ['render "docs/evolution/process-evolution.md"']);
    for (const file of ["process-evolution.md", "process-evolution.uk.md"]) {
      const page = parsePage(readFileSync(join(repo, "docs", "evolution", file), "utf8"));
      assert.equal(page.version, "1.1.0");
      assert.equal(page.lastVerified, "2026-11-06");
    }
    assert.equal(cmdBump(repo, kit, ["features", "--patch", "--date", "2026-11-06"], print, () => 3), 1);
    assert.match(lines.at(-1), /Render failed \(exit 3\)/);
  });

  it("check fails a broken page and names it", () => {
    const file = join(repo, "docs", "evolution", "features-evolution.uk.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("  end\n", ""));
    lines.length = 0;
    assert.equal(cmdCheck(repo, kit, ["features"], print), 1);
    assert.match(lines.join("\n"), /features-evolution\.uk\.md: 1 `subgraph` without its `end`/);
  });

  it("bump refuses a page that is not there", () => {
    assert.equal(cmdBump(repo, kit, ["nope"], print), 2);
  });
});
