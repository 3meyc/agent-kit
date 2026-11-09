// Tests for the core plugin's hooks and kit commands (plugins/core). Node built-ins plus Ajv,
// which only the schema cross-check uses.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { codegraphQueryDir } from "../plugins/core/hooks/codegraph-sync.mjs";
import { lintCommandFor } from "../plugins/core/hooks/lint-edited-file.mjs";
import { updateText } from "../plugins/core/hooks/session-start.mjs";
import { dispatch } from "../plugins/core/hooks/shell-pre.mjs";
import { mergeSettings, parseAdoptArgs, starterKitJson } from "../plugins/core/src/adopt.mjs";
import { compare, outline } from "../plugins/core/src/docs-parity.mjs";
import { checkKitJson, checkSettings } from "../plugins/core/src/doctor.mjs";
import { collectInventory, groupOf, measureDrift, summarize } from "../plugins/core/src/inventory.mjs";
import { hookOff, lintOnEdit } from "../plugins/core/lib/kit-config.mjs";
import { globMatcher, matchesAny, withFile } from "../plugins/core/src/lint-match.mjs";
import { findKitCopies, ownedBy } from "../plugins/core/src/kit-owned.mjs";
import { validate } from "../plugins/core/src/schema-check.mjs";
import { checkUpdates, pickRemoteSha, updateCommands } from "../plugins/core/src/update-check.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(repo, "plugins", "core");
const scratch = mkdtempSync(join(tmpdir(), "agent-kit-core-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function tempProject(name, files = {}) {
  const dir = join(scratch, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runHook(script, payload, env = {}) {
  return spawnSync(process.execPath, [join(core, "hooks", script)], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_DATA: join(scratch, "data"), ...env },
  });
}

describe("kit-config", () => {
  it("reads hooks.off", () => {
    assert.equal(hookOff("rules", { hooks: { off: ["rules"] } }), true);
    assert.equal(hookOff("update-check", { hooks: { off: ["rules"] } }), false);
    assert.equal(hookOff("rules", null), false);
  });

  it("matches globs over repo-relative paths", () => {
    assert.equal(globMatcher("*.ts").test("src/a/b.ts"), true);
    assert.equal(globMatcher("src/*.ts").test("src/a/b.ts"), false);
    assert.equal(globMatcher("src/**/*.ts").test("src/a/b.ts"), true);
    assert.equal(globMatcher("src/**/*.ts").test("src/b.ts"), true);
    assert.equal(globMatcher("*.{ts,svelte}").test("x/App.svelte"), true);
    assert.equal(matchesAny("README.md", []), true);
    assert.equal(matchesAny("README.md", ["*.ts"]), false);
  });

  it("puts the file into the lint command, quoted", () => {
    if (process.platform === "win32") return;
    assert.equal(withFile("eslint {file} --max-warnings 0", "src/a.ts"), "eslint src/a.ts --max-warnings 0");
    assert.equal(withFile("ruff check", "a b.py"), "ruff check 'a b.py'");
    assert.equal(withFile("x", "it's.py"), `x 'it'\\''s.py'`);
  });

  it("reads lintOnEdit only when it has a command", () => {
    assert.equal(lintOnEdit({ lintOnEdit: { match: ["*.ts"] } }), null);
    assert.deepEqual(lintOnEdit({ lintOnEdit: { command: "eslint" } }), { command: "eslint", match: [] });
  });
});

describe("lint-edited-file", () => {
  const root = tempProject("lint", { "src/a.ts": "x", "docs/a.md": "x" });
  const config = { lintOnEdit: { command: "eslint {file}", match: ["*.ts"] } };
  const edit = (file) => ({ tool_name: "Edit", tool_input: { file_path: join(root, file) }, cwd: root });

  it("lints a matching edited file and skips the rest", () => {
    const previous = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;
    try {
      // projectRoot() is memoized per process: this must be the first test that asks for it.
      const target = lintCommandFor(edit("src/a.ts"), config, root);
      assert.notEqual(target, null);
      assert.equal(target.command, "eslint src/a.ts");
      assert.equal(lintCommandFor(edit("docs/a.md"), config, root), null);
      assert.equal(lintCommandFor(edit("src/a.ts"), { ...config, hooks: { off: ["lint-edited-file"] } }, root), null);
      assert.equal(lintCommandFor(edit("src/a.ts"), {}, root), null);
      assert.equal(lintCommandFor({ ...edit("src/a.ts"), tool_name: "Read" }, config, root), null);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previous;
    }
  });

  it("exits 2 with the linter's output when the lint fails, as a process", () => {
    const project = tempProject("lint-proc", {
      "kit.json": { project: "my-app", lintOnEdit: { command: `node -e "console.error('bad style'); process.exit(1)" --`, match: ["*.ts"] } },
      "src/a.ts": "x",
      "src/b.md": "x",
    });
    const env = { CLAUDE_PROJECT_DIR: project };
    const failed = runHook("lint-edited-file.mjs", { tool_name: "Write", tool_input: { file_path: join(project, "src/a.ts") }, cwd: project }, env);
    assert.equal(failed.status, 2);
    assert.match(failed.stderr, /bad style/);
    const skipped = runHook("lint-edited-file.mjs", { tool_name: "Write", tool_input: { file_path: join(project, "src/b.md") }, cwd: project }, env);
    assert.equal(skipped.status, 0);
    assert.equal(skipped.stderr, "");
  });
});

describe("codegraphQueryDir", () => {
  const wt = "/repo/.claude/worktrees/x";
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command }, cwd: wt });

  it("returns the session cwd for a reading codegraph command", () => {
    assert.equal(codegraphQueryDir(bash("codegraph impact saveSettings 2>&1 | head -20")), wt);
    assert.equal(codegraphQueryDir(bash('for s in a b; do codegraph callers "$s"; done')), wt);
    assert.equal(codegraphQueryDir(bash("rtk codegraph explore StructurePickStore")), wt);
  });

  it("follows a leading cd", () => {
    assert.equal(codegraphQueryDir(bash("cd /repo/.claude/worktrees/y && codegraph query foo")), "/repo/.claude/worktrees/y");
    assert.equal(codegraphQueryDir(bash("cd '../y'; codegraph files")), "/repo/.claude/worktrees/y");
  });

  it("ignores commands that only maintain the index or merely mention codegraph", () => {
    assert.equal(codegraphQueryDir(bash("codegraph sync .")), null);
    assert.equal(codegraphQueryDir(bash("codegraph status 2>&1 | head -5")), null);
    assert.equal(codegraphQueryDir(bash("grep -n codegraph CLAUDE.md")), null);
    assert.equal(codegraphQueryDir(bash("cat <<'EOF' > notes.md\nrun codegraph impact foo\nEOF")), null);
  });

  it("reads an MCP query's projectPath and ignores other tools", () => {
    assert.equal(codegraphQueryDir({ tool_name: "mcp__codegraph__codegraph_explore", tool_input: { projectPath: wt }, cwd: "/" }), wt);
    assert.equal(codegraphQueryDir({ tool_name: "mcp__codegraph__codegraph_explore", tool_input: {}, cwd: wt }), null);
    assert.equal(codegraphQueryDir({ tool_name: "Read", tool_input: {}, cwd: wt }), null);
  });
});

describe("shell-pre dispatch", () => {
  it("runs every duty in order with the same payload and config, isolating failures", async () => {
    const calls = [];
    const input = { tool_name: "Bash", tool_input: { command: "ls" } };
    const config = { project: "my-app" };
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(line);
    try {
      await dispatch(
        input,
        [
          ["first", () => {
            throw new Error("boom");
          }],
          ["second", (payload, seen) => void calls.push(payload === input && seen === config)],
        ],
        config,
      );
    } finally {
      console.error = original;
    }
    assert.deepEqual(calls, [true]);
    assert.deepEqual(errors, ["first: boom"]);
  });

  it("exits 0 and prints nothing for a non-shell payload and a no-op command, as a process", () => {
    const project = tempProject("shell-pre", { "kit.json": { project: "my-app", ledger: true } });
    for (const payload of [{ tool_name: "Read", tool_input: {} }, { tool_name: "Bash", hook_event_name: "PreToolUse", tool_input: { command: "git status" }, cwd: project }]) {
      const result = runHook("shell-pre.mjs", payload, { CLAUDE_PROJECT_DIR: project });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  });
});

describe("shell-deletions", () => {
  it("logs pre and post snapshots of an opaque command when the ledger is on, and nothing when off", () => {
    const project = tempProject("deletions", { "kit.json": { project: "my-app", ledger: true }, "a.txt": "a", "b.txt": "b" });
    const git = (...args) => spawnSync("git", args, { cwd: project, encoding: "utf8" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
    const transcript = join(project, "t", "session-1.jsonl");
    const payload = (phase) => ({
      hook_event_name: phase,
      tool_name: "Bash",
      tool_use_id: "tool-1",
      transcript_path: transcript,
      cwd: project,
      tool_input: { command: "node scripts/clean.mjs" },
    });
    const env = { CLAUDE_PROJECT_DIR: project };
    assert.equal(runHook("shell-deletions.mjs", payload("PreToolUse"), env).status, 0);
    rmSync(join(project, "a.txt"));
    assert.equal(runHook("shell-deletions.mjs", payload("PostToolUse"), env).status, 0);
    const lines = readFileSync(join(project, "t", "session-1", "shell-deletions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.phase), ["pre", "post"]);
    assert.deepEqual(lines[0].deleted, []);
    assert.equal(lines[1].deleted.length, 1);
    assert.match(lines[1].deleted[0], /a\.txt$/);

    writeFileSync(join(project, "kit.json"), JSON.stringify({ project: "my-app", ledger: true, hooks: { off: ["shell-deletions"] } }));
    assert.equal(runHook("shell-deletions.mjs", { ...payload("PreToolUse"), tool_use_id: "tool-2" }, env).status, 0);
    assert.equal(readFileSync(join(project, "t", "session-1", "shell-deletions.jsonl"), "utf8").includes("tool-2"), false);
  });
});

describe("session-start", () => {
  it("prints the always-on rules, and nothing when both duties are off", () => {
    const on = tempProject("ss-on", { "kit.json": { project: "my-app", hooks: { off: ["update-check"] } } });
    const result = runHook("session-start.mjs", { source: "startup" }, { CLAUDE_PROJECT_DIR: on });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^# agent-kit core rules/);
    assert.match(result.stdout, /## Chat output/);
    assert.match(result.stdout, /## Shell \(per OS\)/);
    assert.match(result.stdout, /## Tooling limits/);
    const off = tempProject("ss-off", { "kit.json": { project: "my-app", hooks: { off: ["rules", "update-check"] } } });
    const quiet = runHook("session-start.mjs", { source: "startup" }, { CLAUDE_PROJECT_DIR: off });
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, "");
  });

  it("keeps project-specific rows out of the rules", () => {
    const rules = readFileSync(join(core, "rules", "always-on.md"), "utf8");
    for (const word of ["Fallow health baseline", "lefthook", "worktree-flow", "git-commit-session", "VPN"]) {
      assert.equal(rules.includes(word), false, word);
    }
  });

  it("words an update notice with both commands", () => {
    const text = updateText([{ plugin: "core", marketplace: "agent-kit", scope: "project", installed: "a".repeat(40), latest: "b".repeat(40), ref: "stable" }]);
    assert.match(text, /core@agent-kit: aaaaaaaaaaaa installed, stable is bbbbbbbbbbbb/);
    assert.match(text, /claude plugin marketplace update agent-kit/);
    assert.match(text, /claude plugin update core@agent-kit --scope project/);
    assert.equal(updateText([]), "");
  });
});

describe("update-check", () => {
  it("picks the peeled tag, then the tag, then a branch", () => {
    const output = "111\trefs/tags/stable\n222\trefs/tags/stable^{}\n333\trefs/heads/main\n";
    assert.equal(pickRemoteSha(output, "stable"), "222");
    assert.equal(pickRemoteSha("111\trefs/tags/stable\n", "stable"), "111");
    assert.equal(pickRemoteSha(output, "main"), "333");
    assert.equal(pickRemoteSha(output, "nope"), null);
  });

  it("flags commit-versioned plugins that lag their ref, for this project only", () => {
    const sha = (c) => c.repeat(40);
    const state = {
      marketplaces: {
        "agent-kit": { source: { source: "github", repo: "owner/agent-kit", ref: "stable" } },
        other: { source: { source: "github", repo: "owner/other" } },
      },
      installed: {
        "core@agent-kit": [{ scope: "user", version: sha("a").slice(0, 12), gitCommitSha: sha("a") }],
        "sdlc@agent-kit": [
          { scope: "project", projectPath: "/work/my-app", version: sha("b").slice(0, 12), gitCommitSha: sha("b") },
          { scope: "project", projectPath: "/work/elsewhere", version: sha("a").slice(0, 12), gitCommitSha: sha("a") },
        ],
        "tool@other": [{ scope: "user", version: "1.0.0", gitCommitSha: sha("c") }],
      },
    };
    const asked = [];
    const { lagging, checked } = checkUpdates({
      root: "/work/my-app",
      state,
      resolveSha: (remote) => {
        asked.push(remote);
        return sha("b");
      },
    });
    assert.deepEqual(checked.map((item) => item.plugin), ["core", "sdlc"]);
    assert.deepEqual(lagging.map((item) => item.plugin), ["core"]);
    assert.deepEqual(asked, [{ url: "https://github.com/owner/agent-kit.git", ref: "stable" }]);
    assert.deepEqual(updateCommands(lagging[0]), ["claude plugin marketplace update agent-kit", "claude plugin update core@agent-kit"]);
  });
});

describe("schema-check", () => {
  const schema = JSON.parse(readFileSync(join(core, "schema", "kit.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const minimal = { project: "my-app" };
  const cases = {
    example: JSON.parse(readFileSync(join(repo, "examples", "kit.json"), "utf8")),
    minimal,
    "missing project": {},
    "unknown top-level key": { ...minimal, extra: true },
    "lower-case item prefix": { ...minimal, itemPrefix: "app" },
    "absolute path": { ...minimal, paths: { docs: "/docs" } },
    "path leaving the repo": { ...minimal, paths: { ledger: "../ledger" } },
    "unknown command": { ...minimal, commands: { deploy: "make deploy" } },
    "port out of range": { ...minimal, devServer: { port: 70000 } },
    "port not an integer": { ...minimal, devServer: { port: 51.5 } },
    "duplicate hook ids": { ...minimal, hooks: { off: ["rules", "rules"] } },
    "bad hook id": { ...minimal, hooks: { off: ["Rules!"] } },
    "empty command": { ...minimal, commands: { test: "" } },
    "ledger not boolean": { ...minimal, ledger: "yes" },
    "lintOnEdit ok": { ...minimal, lintOnEdit: { command: "eslint {file}", match: ["*.ts"] } },
    "lintOnEdit without a command": { ...minimal, lintOnEdit: { match: ["*.ts"] } },
    "lintOnEdit empty glob": { ...minimal, lintOnEdit: { command: "eslint", match: [""] } },
    "dev and install commands": { ...minimal, commands: { dev: "npm run dev", install: "npm ci" } },
  };
  for (const [name, manifest] of Object.entries(cases)) {
    it(`agrees with Ajv: ${name}`, () => {
      assert.equal(validate(manifest, schema).length === 0, ajv(manifest));
    });
  }

  it("accepts lintOnEdit, commands.dev and commands.install", () => {
    const kit = { project: "my-app", lintOnEdit: { command: "eslint {file}", match: ["*.ts"] }, commands: { dev: "npm run dev", install: "npm ci" } };
    const project = tempProject("doctor-kit", { "kit.json": kit });
    const { findings } = checkKitJson(project, schema);
    assert.deepEqual(findings.map((finding) => finding.level), ["ok"]);
  });

  it("fails a lintOnEdit without a command", () => {
    const project = tempProject("doctor-kit-bad", { "kit.json": { project: "my-app", lintOnEdit: { match: ["*.ts"] } } });
    const { findings } = checkKitJson(project, schema);
    assert.ok(findings.some((finding) => finding.level === "fail"));
  });
});

describe("doctor settings", () => {
  const userDir = tempProject("user-home", { "settings.json": {} });

  it("fails when the base marketplace or a needed plugin is missing", () => {
    const project = tempProject("doctor-bare", { ".claude/settings.json": { enabledPlugins: { "org@overlay": true } } });
    const findings = checkSettings(project, { project: "my-app", ledger: true }, userDir);
    const fails = findings.filter((finding) => finding.level === "fail").map((finding) => finding.text);
    assert.ok(fails.some((text) => text.startsWith("core@agent-kit")));
    assert.ok(fails.some((text) => text.startsWith("session@agent-kit")));
    assert.ok(fails.some((text) => text.includes("marketplace agent-kit") && text.includes("S3a")));
    assert.ok(fails.some((text) => text.includes("marketplace overlay")));
  });

  it("passes a project that declares both marketplaces and enables core", () => {
    const project = tempProject("doctor-good", {
      ".claude/settings.json": {
        extraKnownMarketplaces: { "agent-kit": { source: {} }, overlay: { source: {} } },
        enabledPlugins: { "core@agent-kit": true, "org@overlay": true },
      },
    });
    assert.deepEqual(checkSettings(project, { project: "my-app" }, userDir).filter((finding) => finding.level !== "ok"), []);
  });
});

describe("kit-owned files", () => {
  it("lists core's legacy files, agents, skills and duplicate hook entries", () => {
    const owned = ownedBy({ root: core, name: "core" }).files.map((file) => file.path);
    assert.ok(owned.includes(".claude/rules/agent-output-rules.md"));
    assert.ok(owned.includes(".claude/agents/check-runner.md"));
    assert.ok(owned.includes(".claude/commands/check.md"));
    const project = tempProject("owned", {
      ".claude/rules/agent-output-rules.md": "x",
      ".claude/commands/dev.md": "x",
      ".claude/rules/my-app-only.md": "x",
      ".claude/settings.json": { hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "node scripts/hooks/lint-edited-file.mjs" }] }] } },
    });
    const copies = findKitCopies(project, [{ root: core, name: "core" }]).map((copy) => copy.path);
    assert.deepEqual(copies.sort(), [
      ".claude/commands/dev.md",
      ".claude/rules/agent-output-rules.md",
      ".claude/settings.json (PostToolUse hook: lint-edited-file.mjs)",
    ]);
  });

  it("lists session's ledger scripts, commands and agent, and its duplicate hook entries", () => {
    const session = join(repo, "plugins", "session");
    const manifest = JSON.parse(readFileSync(join(session, "kit-owned.json"), "utf8"));
    for (const path of Object.keys(manifest.partial)) assert.ok(manifest.files.includes(path), `partial names a listed file: ${path}`);
    const owned = ownedBy({ root: session, name: "session" }).files.map((file) => file.path);
    assert.ok(owned.includes(".claude/agents/git-ops.md"));
    assert.ok(owned.includes(".claude/commands/close-out.md"));
    const project = tempProject("owned-session", {
      "scripts/hooks/session-ledger.mjs": "x",
      ".claude/commands/handoff.md": "x",
      ".claude/settings.json": { hooks: { Stop: [{ hooks: [{ type: "command", command: "node scripts/hooks/session-ledger.mjs" }] }] } },
    });
    const copies = findKitCopies(project, [{ root: session, name: "session" }]).map((copy) => copy.path);
    assert.deepEqual(copies.sort(), [
      ".claude/commands/handoff.md",
      ".claude/settings.json (Stop hook: session-ledger.mjs)",
      "scripts/hooks/session-ledger.mjs",
    ]);
  });
});

describe("adopt", () => {
  it("drafts kit.json from package.json and launch.json", () => {
    const project = tempProject("My App", {
      "package.json": { scripts: { check: "tsc", "lint:check": "eslint .", lint: "eslint --fix .", test: "vitest", dev: "vite" } },
      "pnpm-lock.yaml": "",
      ".claude/launch.json": { configurations: [{ name: "dev", port: 5173 }] },
    });
    const kit = starterKitJson(project);
    assert.equal(kit.project, "my-app");
    assert.deepEqual(kit.commands, { check: "pnpm run check", lint: "pnpm run lint:check", test: "pnpm test" });
    assert.deepEqual(kit.devServer, { port: 5173 });
    assert.equal(kit.ledger, false);
  });

  it("adds marketplaces and plugins without changing what is there", () => {
    const { settings, changes } = mergeSettings(
      { enabledPlugins: { "core@agent-kit": false }, permissions: { allow: ["Bash(ls)"] } },
      { marketplaces: { "agent-kit": { source: "github", repo: "owner/agent-kit", ref: "stable" } }, plugins: ["core@agent-kit", "session@agent-kit"] },
    );
    assert.equal(settings.enabledPlugins["core@agent-kit"], false);
    assert.equal(settings.enabledPlugins["session@agent-kit"], true);
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
    assert.deepEqual(settings.extraKnownMarketplaces["agent-kit"], { source: { source: "github", repo: "owner/agent-kit", ref: "stable" } });
    assert.ok(changes.some((change) => change.startsWith("left as is: enabledPlugins.core@agent-kit")));
  });

  it("always includes core and parses overlays", () => {
    const options = parseAdoptArgs(["--plugins", "session", "--overlay", "org=owner/overlay#stable", "--overlay-plugin", "org@org"]);
    assert.deepEqual(options.plugins, ["core", "session"]);
    assert.deepEqual(options.overlays, { org: "owner/overlay#stable" });
    assert.throws(() => parseAdoptArgs(["--overlay", "nope"]));
  });

  it("writes nothing on a dry run, as a process", () => {
    const project = tempProject("adopt-proc", { "package.json": { scripts: { test: "node --test" } } });
    spawnSync("git", ["init", "-q"], { cwd: project });
    const result = spawnSync(process.execPath, [join(core, "src", "kit-cli.mjs"), "adopt"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run: nothing written/);
    assert.match(result.stdout, /enabledPlugins\.core@agent-kit = true/);
    assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).stdout.includes("kit.json"), false);
  });
});

describe("inventory", () => {
  it("groups files across repos and measures drift against the reference", () => {
    const a = tempProject("inv-a", { ".claude/rules/x.md": "one\ntwo\n", ".claude/skills/s/SKILL.md": "s", "CLAUDE.md": "a" });
    const b = tempProject("inv-b", { ".claude/rules/x.md": "one\nTWO\nthree\n", ".claude/skills/s/SKILL.md": "s", "scripts/only-b.mjs": "b" });
    const config = { repos: { a, b }, reference: "a", roots: [".claude/rules", ".claude/skills", "scripts"], files: ["CLAUDE.md"] };
    const rows = collectInventory(config);
    const status = Object.fromEntries(rows.map((row) => [row.rel, row.status]));
    assert.deepEqual(status, { ".claude/rules/x.md": "drift(2)", ".claude/skills/s/SKILL.md": "same", "CLAUDE.md": "single", "scripts/only-b.mjs": "single" });
    assert.equal(groupOf(".claude/skills/s/SKILL.md"), "skill:s");
    assert.equal(summarize(rows, ["a", "b"]).length, 4);
    const drift = measureDrift(rows, config);
    assert.deepEqual(drift.groups, [".claude/rules/x.md: b=3"]);
  });
});

describe("docs parity", () => {
  const en = "# Page\n\n**English** · [Українська](page.uk.md)\n\n## One\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n1. first\n2. second\n\n```bash\nnpm ci\n```\n";
  const uk = "# Сторінка\n\n[English](page.md) · **Українська**\n\n## Один\n\n| А | Б |\n| --- | --- |\n| 1 | 2 |\n\n1. перший\n2. другий\n\n```bash\nnpm ci\n```\n";

  it("accepts a faithful mirror", () => {
    assert.deepEqual(compare(en, uk, "page.md", "page.uk.md"), []);
    assert.deepEqual(outline(en).numbers, ["1", "2"]);
  });

  it("reports each kind of drift", () => {
    const drifted = uk
      .replace("## Один", "### Один")
      .replace("| 1 | 2 |\n", "| 1 | 2 |\n| 3 | 4 |\n")
      .replace("2. другий\n", "")
      .replace("npm ci", "npm install")
      .replace("[English](page.md)", "English");
    const problems = compare(en, drifted, "page.md", "page.uk.md").join("\n");
    for (const kind of ["language-switch", "headings", "tables", "numbered items", "command blocks"]) assert.match(problems, new RegExp(kind));
  });

  it("passes on this repo's own docs, as a process", () => {
    const result = spawnSync(process.execPath, [join(core, "bin", "kit-docs-parity")], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
});
