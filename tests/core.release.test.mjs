// `kit release`: scratch kit repos, each with a bare remote, released for real and refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { cutChangelog, cutTable, ordinalNumber, ordinalWord, parseReleaseArgs, runRelease } from "../plugins/core/src/release.mjs";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-kit-release-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const hooks = join(scratch, "no-hooks");
mkdirSync(hooks);
const TODAY = "2026-01-02";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Repo-local settings only, so the machine's identity, signing and hooks stay out. */
function configure(dir) {
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgsign", "false");
  git(dir, "config", "core.hooksPath", hooks);
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

/** A kit repo with a bare remote: `files` committed on main and pushed, `stable` on that commit unless `tagged` is false. */
function kitRepo(name, files, { tagged = true } = {}) {
  const remote = join(scratch, `${name}.git`);
  const dir = join(scratch, name);
  git(scratch, "init", "-q", "--bare", "-b", "main", remote);
  git(scratch, "init", "-q", "-b", "main", dir);
  configure(dir);
  git(dir, "remote", "add", "origin", remote);
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feat: start");
  if (tagged) git(dir, "tag", "-a", "stable", "-m", "first");
  git(dir, "push", "-q", "origin", "main", ...(tagged ? ["refs/tags/stable"] : []));
  return { dir, remote };
}

/** Commit a change on main and push it, so there is something to release. */
function land(dir, files, message = "fix: something") {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  git(dir, "push", "-q", "origin", "main");
}

function release(dir, args = [], options = {}) {
  const lines = [];
  const code = runRelease(dir, args, { print: (line) => lines.push(line), today: TODAY, checkOutput: "pipe", ...options });
  return { code, out: lines.join("\n") };
}

function remoteRef(remote, ref) {
  return git(scratch, "--git-dir", remote, "rev-parse", ref);
}

const CHANGELOG = `# Changelog

Intro.

## Unreleased

## 2025-12-01 — first \`stable\`

\`stable\` points at the commit that adds this entry.

- core: the start.
`;

const changelogKit = (check = "node -e 0") => ({ "kit.json": { project: "base-kit", baseBranch: "main", commands: { check } }, "CHANGELOG.md": CHANGELOG });

describe("ordinals", () => {
  it("names release numbers in words and reads them back", () => {
    assert.deepEqual([1, 2, 8, 9, 12, 20, 21, 42, 99].map(ordinalWord), ["first", "second", "eighth", "ninth", "twelfth", "twentieth", "twenty-first", "forty-second", "ninety-ninth"]);
    assert.deepEqual([101, 111, 112, 123].map(ordinalWord), ["101st", "111th", "112th", "123rd"]);
    for (const n of [1, 8, 13, 30, 57, 99, 104]) assert.equal(ordinalNumber(ordinalWord(n)), n);
    assert.equal(ordinalNumber("9"), 9);
    assert.equal(ordinalNumber("nineth"), null);
  });
});

describe("release notes", () => {
  it("moves Unreleased under a dated, counted heading and keeps the rest", () => {
    const cut = cutChangelog(CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- session: a fix.\n- core: a feature.\n"), { date: TODAY, tag: "stable", summary: "Two changes." });
    assert.equal(cut.next, 2);
    assert.equal(cut.moved, 2);
    assert.match(cut.content, /## Unreleased\n\n## 2026-01-02 — second `stable`\n\n`stable` points at the commit that adds this entry\. Two changes\.\n\n- session: a fix\.\n- core: a feature\.\n\n## 2025-12-01 — first `stable`/);
    assert.ok(cut.content.endsWith("- core: the start.\n"));
  });

  it("finds the Keep a Changelog heading `## [Unreleased]` and keeps it as written", () => {
    const keep = CHANGELOG.replace("## Unreleased\n", "## [Unreleased] - 2026-01-02\n\n- session: a fix.\n");
    const cut = cutChangelog(keep, { date: TODAY, tag: "stable", summary: null });
    assert.equal(cut.moved, 1);
    assert.match(cut.content, /## \[Unreleased\] - 2026-01-02\n\n## 2026-01-02 — second `stable`\n\n`stable` points at the commit that adds this entry\.\n\n- session: a fix\.\n/);
    assert.match(cutChangelog("# Changelog\n\n## Unreleased changes\n\n- x\n", { date: TODAY, tag: "stable", summary: null }).error, /no `## Unreleased` \(or `## \[Unreleased\]`\)/);
  });

  it("refuses an empty Unreleased, a missing one, and a count that disagrees with the latest heading", () => {
    assert.match(cutChangelog(CHANGELOG, { date: TODAY, tag: "stable", summary: null }).error, /nothing under/);
    assert.match(cutChangelog("# Changelog\n", { date: TODAY, tag: "stable", summary: null }).error, /no `## Unreleased`/);
    const skipped = CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- x\n").replace("— first", "— third");
    assert.match(cutChangelog(skipped, { date: TODAY, tag: "stable", summary: null }).error, /latest says "third"/);
  });

  it("adds a table row like the last one, with the next id, today's date and the summary", () => {
    const doc = "# Evolution\n\n## Releases\n\n| ID | Date | Kit | Points at | Summary |\n| --- | --- | --- | --- | --- |\n| 1 | 2025-12-01 | my-overlay | The commit that adds this row | Start |\n";
    const cut = cutTable(doc, { date: TODAY, summary: "Fixes a | b" });
    assert.equal(cut.next, 2);
    assert.ok(cut.content.endsWith("| Start |\n| 2 | 2026-01-02 | my-overlay | The commit that adds this row | Fixes a \\| b |\n"));
    assert.match(cutTable(doc, { date: TODAY, summary: null }).error, /needs a summary/);
    assert.match(cutTable("# Empty\n\n| ID | Date |\n| --- | --- |\n", { date: TODAY, summary: "x" }).error, /no row to follow/);
  });

  it("parses --yes and per-language summaries, and rejects anything else", () => {
    assert.deepEqual(parseReleaseArgs(["--yes", "--summary", "One.", "--summary-uk=Один."]), { yes: true, summaries: { "": "One.", uk: "Один." }, errors: [] });
    assert.deepEqual(parseReleaseArgs(["--force", "--summary"]).errors, ["unknown argument --force", "--summary needs a text"]);
  });
});

describe("kit release", () => {
  it("dry run: prints every step and changes nothing", () => {
    const { dir, remote } = kitRepo("dry", changelogKit());
    land(dir, { "CHANGELOG.md": CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- core: a fix.\n") });
    const head = git(dir, "rev-parse", "HEAD");
    const tag = remoteRef(remote, "refs/tags/stable^{}");
    const { code, out } = release(dir, ["--summary", "A fix."]);
    assert.equal(code, 0, out);
    assert.match(out, /dry run/);
    assert.match(out, /1 commit\(s\) to release/);
    assert.match(out, /Release: second `stable`, dated 2026-01-02/);
    assert.match(out, /Check `node -e 0` on the current tree: passed/);
    assert.match(out, /Would write CHANGELOG\.md: move 1 line\(s\)/);
    assert.match(out, /Would move the annotated tag stable \("2026-01-02: second release"\)/);
    assert.match(out, /Ready:/);
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.equal(git(dir, "status", "--porcelain"), "");
    assert.equal(remoteRef(remote, "refs/tags/stable^{}"), tag);
  });

  it("--yes: writes the notes, commits, pushes main, moves stable and confirms the remote", () => {
    const { dir, remote } = kitRepo("yes", changelogKit());
    land(dir, { "CHANGELOG.md": CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- core: a fix.\n") });
    const { code, out } = release(dir, ["--yes", "--summary", "A fix."]);
    assert.equal(code, 0, out);
    const head = git(dir, "rev-parse", "HEAD");
    assert.equal(git(dir, "log", "-1", "--format=%s"), "chore(release): second stable release");
    assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n"), ["CHANGELOG.md"]);
    assert.equal(remoteRef(remote, "refs/heads/main"), head);
    assert.equal(remoteRef(remote, "refs/tags/stable^{}"), head);
    assert.equal(git(scratch, "--git-dir", remote, "cat-file", "-t", "refs/tags/stable"), "tag");
    assert.match(git(scratch, "--git-dir", remote, "cat-file", "-p", "refs/tags/stable"), /2026-01-02: second release/);
    const notes = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    assert.match(notes, /## Unreleased\n\n## 2026-01-02 — second `stable`\n\n`stable` points at the commit that adds this entry\. A fix\.\n\n- core: a fix\.\n\n## 2025-12-01/);
    assert.match(out, /both the release commit/);
    // Right after a release there is nothing left to release.
    const again = release(dir, ["--yes"]);
    assert.equal(again.code, 1);
    assert.match(again.out, /nothing to release/);
    assert.match(again.out, /nothing under `## Unreleased`/);
  });

  it("cuts the first release when the remote has no stable tag yet", () => {
    const first = CHANGELOG.replace(/## 2025-12-01[\s\S]*$/, "").replace("## Unreleased\n", "## Unreleased\n\n- core: the start.\n");
    const { dir, remote } = kitRepo("first", { ...changelogKit(), "CHANGELOG.md": first }, { tagged: false });
    const { code, out } = release(dir, ["--yes"]);
    assert.equal(code, 0, out);
    assert.match(out, /none yet \(first release\)/);
    assert.equal(git(dir, "log", "-1", "--format=%s"), "chore(release): first stable release");
    assert.equal(remoteRef(remote, "refs/tags/stable^{}"), git(dir, "rev-parse", "HEAD"));
  });

  it("refuses a dirty tree, another branch, an unpushed or an unpulled main", () => {
    const { dir } = kitRepo("refuse", changelogKit());
    land(dir, { "CHANGELOG.md": CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- core: a fix.\n") });

    write(dir, { "stray.txt": "x" });
    assert.match(release(dir, ["--yes"]).out, /uncommitted or untracked files/);
    rmSync(join(dir, "stray.txt"));

    git(dir, "switch", "-q", "-c", "topic");
    assert.match(release(dir).out, /on topic, not main/);
    git(dir, "switch", "-q", "main");

    write(dir, { "a.txt": "a" });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feat: local only");
    const ahead = release(dir, ["--yes"]);
    assert.equal(ahead.code, 1);
    assert.match(ahead.out, /1 commit\(s\) ahead of origin\/main/);
    assert.match(ahead.out, /nothing was changed/);
    git(dir, "push", "-q", "origin", "main");

    const other = join(scratch, "refuse-other");
    git(scratch, "clone", "-q", join(scratch, "refuse.git"), other);
    configure(other);
    land(other, { "b.txt": "b" });
    const behind = release(dir, ["--yes"]);
    assert.equal(behind.code, 1);
    assert.match(behind.out, /1 commit\(s\) behind origin\/main; pull first/);
    assert.equal(git(dir, "log", "-1", "--format=%s"), "feat: local only");
  });

  it("refuses a failing check and puts the notes back", () => {
    const { dir, remote } = kitRepo("failing", changelogKit("node -e \"process.exit(require('fs').readFileSync('CHANGELOG.md','utf8').includes('second') ? 1 : 0)\""));
    const unreleased = CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- core: a fix.\n");
    land(dir, { "CHANGELOG.md": unreleased });
    const tag = remoteRef(remote, "refs/tags/stable^{}");
    // The dry run checks the tree as it is (passes); --yes checks the written notes (fails).
    assert.equal(release(dir).code, 0);
    const { code, out } = release(dir, ["--yes"]);
    assert.equal(code, 1, out);
    assert.match(out, /the check fails; the notes are back/);
    assert.equal(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), unreleased);
    assert.equal(git(dir, "status", "--porcelain"), "");
    assert.equal(git(dir, "log", "-1", "--format=%s"), "fix: something");
    assert.equal(remoteRef(remote, "refs/tags/stable^{}"), tag);

    const broken = kitRepo("failing-now", changelogKit("node -e \"process.exit(3)\""));
    land(broken.dir, { "CHANGELOG.md": unreleased });
    const dry = release(broken.dir);
    assert.equal(dry.code, 1);
    assert.match(dry.out, /on the current tree: failed/);
  });

  it("releases from dev: commits there, fast-forwards main, and refuses a main that dev lacks", () => {
    const devKit = { "kit.json": { project: "base-kit", baseBranch: "dev", commands: { check: "node -e 0" } }, "CHANGELOG.md": CHANGELOG };
    const { dir, remote } = kitRepo("promote", devKit);
    git(dir, "switch", "-q", "-c", "dev");
    git(dir, "push", "-q", "origin", "dev");
    write(dir, { "CHANGELOG.md": CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- core: a fix.\n") });
    git(dir, "commit", "-q", "-am", "fix: on dev");
    git(dir, "push", "-q", "origin", "dev");

    git(dir, "switch", "-q", "main");
    assert.match(release(dir).out, /on main, not dev/);
    git(dir, "switch", "-q", "dev");

    const dry = release(dir);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /Release branch origin\/main: [0-9a-f]{12}, 1 commit\(s\) behind dev/);
    assert.match(dry.out, /Would fast-forward origin main to the release commit/);

    const { code, out } = release(dir, ["--yes", "--summary", "A fix."]);
    assert.equal(code, 0, out);
    const head = git(dir, "rev-parse", "HEAD");
    assert.equal(git(dir, "log", "-1", "--format=%s"), "chore(release): second stable release");
    assert.equal(remoteRef(remote, "refs/heads/dev"), head);
    assert.equal(remoteRef(remote, "refs/heads/main"), head);
    assert.equal(remoteRef(remote, "refs/tags/stable^{}"), head);
    assert.equal(git(dir, "rev-parse", "refs/heads/main"), head);
    assert.match(out, /all the release commit/);

    // A commit that reached main but not dev stops the next release before anything moves.
    const other = join(scratch, "promote-other");
    git(scratch, "clone", "-q", "-b", "main", remote, other);
    configure(other);
    land(other, { "hotfix.txt": "x" }, "fix: straight on main");
    write(dir, { "CHANGELOG.md": readFileSync(join(dir, "CHANGELOG.md"), "utf8").replace("## Unreleased\n", "## Unreleased\n\n- core: more.\n") });
    git(dir, "commit", "-q", "-am", "fix: more on dev");
    git(dir, "push", "-q", "origin", "dev");
    const blocked = release(dir, ["--yes"]);
    assert.equal(blocked.code, 1, blocked.out);
    assert.match(blocked.out, /origin\/main has commits that dev lacks; merge main into dev/);
    assert.equal(remoteRef(remote, "refs/tags/stable^{}"), head);
  });

  it("refuses without a check to run", () => {
    const { dir } = kitRepo("no-check", { "kit.json": { project: "base-kit", baseBranch: "main" }, "CHANGELOG.md": CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- x\n") });
    land(dir, { "a.txt": "a" });
    assert.match(release(dir).out, /no check to run/);
  });
});

describe("kit release for an overlay", () => {
  const TABLE = "# Evolution\n\n## Releases\n\n| ID | Date | Kit | Points at | Summary |\n| --- | --- | --- | --- | --- |\n| 1 | 2025-12-01 | my-overlay | The commit that adds this row | Start |\n";
  const TABLE_UK = "# Еволюція\n\n## Випуски\n\n| ID | Дата | Набір | Вказує на | Підсумок |\n| --- | --- | --- | --- | --- |\n| 1 | 2025-12-01 | my-overlay | Коміт, що додає цей рядок | Початок |\n";

  it("adds a row to each release table and refuses until the base kit's stable holds the release it needs", () => {
    const base = kitRepo("base", changelogKit());
    const overlay = kitRepo("overlay", {
      "kit.json": {
        project: "my-overlay",
        baseBranch: "main",
        commands: { check: "node -e 0" },
        release: {
          notes: [{ path: "docs/evolution.md", format: "table" }, { path: "docs/evolution.uk.md", format: "table", lang: "uk" }],
          base: { repo: base.remote, needs: "second" },
        },
      },
      "docs/evolution.md": TABLE,
      "docs/evolution.uk.md": TABLE_UK,
    });
    land(overlay.dir, { "a.txt": "a" });

    const noUk = release(overlay.dir, ["--summary", "A fix"]);
    assert.equal(noUk.code, 1);
    assert.match(noUk.out, /docs\/evolution\.uk\.md needs a summary for the new row \(--summary-uk "<text>"\)/);

    const early = release(overlay.dir, ["--yes", "--summary", "A fix", "--summary-uk", "Виправлення"]);
    assert.equal(early.code, 1);
    assert.match(early.out, /does not yet contain its second release/);
    assert.match(early.out, /release\.base\.needs second/);

    land(base.dir, { "CHANGELOG.md": CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- core: what the overlay needs.\n") });
    assert.equal(release(base.dir, ["--yes"]).code, 0);

    const { code, out } = release(overlay.dir, ["--yes", "--summary", "A fix", "--summary-uk", "Виправлення"]);
    assert.equal(code, 0, out);
    assert.match(out, /contains its second release/);
    assert.equal(git(overlay.dir, "log", "-1", "--format=%s"), "chore(release): second stable release");
    assert.ok(readFileSync(join(overlay.dir, "docs/evolution.md"), "utf8").endsWith("| 2 | 2026-01-02 | my-overlay | The commit that adds this row | A fix |\n"));
    assert.ok(readFileSync(join(overlay.dir, "docs/evolution.uk.md"), "utf8").endsWith("| 2 | 2026-01-02 | my-overlay | Коміт, що додає цей рядок | Виправлення |\n"));
    assert.equal(remoteRef(overlay.remote, "refs/tags/stable^{}"), git(overlay.dir, "rev-parse", "HEAD"));
  });

  it("checks a needed base commit by ancestry", () => {
    const base = kitRepo("base-sha", changelogKit());
    const tagged = git(base.dir, "rev-parse", "HEAD");
    land(base.dir, { "later.txt": "x" });
    const later = git(base.dir, "rev-parse", "HEAD");
    const files = (needs) => ({
      "kit.json": { project: "my-overlay", baseBranch: "main", commands: { check: "node -e 0" }, release: { notes: [{ path: "docs/evolution.md", format: "table" }], base: { repo: base.remote, needs } } },
      "docs/evolution.md": TABLE,
    });
    const ok = kitRepo("overlay-sha-ok", files(tagged));
    land(ok.dir, { "a.txt": "a" });
    assert.match(release(ok.dir, ["--summary", "x"]).out, /contains [0-9a-f]{40}/);
    const missing = kitRepo("overlay-sha-missing", files(later));
    land(missing.dir, { "a.txt": "a" });
    const refused = release(missing.dir, ["--summary", "x"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /does not contain/);
  });

  it("names the evolution pages the release has not updated, and never refuses for them", () => {
    const page = "---\nversion: 1.0.0\nlast_verified: 2025-12-01\n---\n\n# P\n";
    const { dir } = kitRepo("evolution", { ...changelogKit(), "docs/evolution/process-evolution.md": page, "docs/evolution/features-evolution.md": page });
    land(dir, { "CHANGELOG.md": CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- core: a fix.\n"), "docs/evolution/features-evolution.md": page.replace("1.0.0", "1.1.0") });
    const { code, out } = release(dir, ["--summary", "A fix."]);
    assert.equal(code, 0, out);
    assert.match(out, /Evolution pages: docs\/evolution\/process-evolution\.md unchanged since stable; bring them up to date first: `evolution status --since-release`/);
    const none = kitRepo("no-evolution", changelogKit());
    land(none.dir, { "CHANGELOG.md": CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- core: a fix.\n") });
    assert.doesNotMatch(release(none.dir, ["--summary", "A fix."]).out, /Evolution pages/);
  });
});
