// Tests for the core plugin's hooks and kit commands (plugins/core). Node built-ins plus Ajv,
// which only the schema cross-check uses.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { codegraphQueryDir } from "../plugins/core/hooks/codegraph-sync.mjs";
import { lintCommandsFor, lintRootFor } from "../plugins/core/hooks/lint-edited-file.mjs";
import { updateText } from "../plugins/core/hooks/session-start.mjs";
import { dispatch } from "../plugins/core/hooks/shell-pre.mjs";
import { baseBranch, mergeSettings, otherCommands, parseAdoptArgs, repoName, sdlcPath, starterKitJson } from "../plugins/core/src/adopt.mjs";
import { compare, outline } from "../plugins/core/src/docs-parity.mjs";
import { checkKitJson, checkLoadedPlugins, checkMarketplaceRefs, checkSettings, checkVersions } from "../plugins/core/src/doctor.mjs";
import { collectInventory, groupOf, measureDrift, summarize } from "../plugins/core/src/inventory.mjs";
import { hookOff, lintOnEdit } from "../plugins/core/lib/kit-config.mjs";
import { globMatcher, matchesAny, withFile } from "../plugins/core/src/lint-match.mjs";
import { enabledForProject, findKitCopies, isClaudeProcess, ownedBy, pluginDirArgs, pluginRoots, relativeImports, sessionPluginDirs, testsOfOwned, textCopies, textLines } from "../plugins/core/src/kit-owned.mjs";
import { optionValues, printCommands } from "../plugins/core/src/kit-cli.mjs";
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
    assert.deepEqual(lintOnEdit({ lintOnEdit: { match: ["*.ts"] } }), []);
    assert.deepEqual(lintOnEdit({ lintOnEdit: { command: "eslint" } }), [{ command: "eslint", match: [] }]);
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
      const targets = lintCommandsFor(edit("src/a.ts"), config, root);
      assert.deepEqual(targets.map((target) => target.command), ["eslint src/a.ts"]);
      assert.deepEqual(lintCommandsFor(edit("docs/a.md"), config, root), []);
      assert.deepEqual(lintCommandsFor(edit("src/a.ts"), { ...config, hooks: { off: ["lint-edited-file"] } }, root), []);
      assert.deepEqual(lintCommandsFor(edit("src/a.ts"), {}, root), []);
      assert.deepEqual(lintCommandsFor({ ...edit("src/a.ts"), tool_name: "Read" }, config, root), []);
      // A list of rules: every rule whose globs fit runs, in order.
      const rules = {
        lintOnEdit: [
          { command: "eslint {file}", match: ["*.ts"] },
          { command: "check-docs", match: ["docs/**"] },
          { command: "typos {file}" },
        ],
      };
      assert.deepEqual(lintCommandsFor(edit("src/a.ts"), rules, root).map((target) => target.command), ["eslint src/a.ts", "typos src/a.ts"]);
      assert.deepEqual(lintCommandsFor(edit("docs/a.md"), rules, root).map((target) => target.command), ["check-docs docs/a.md", "typos docs/a.md"]);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previous;
    }
  });

  it("takes the root from the checkout holding the file, so a nested worktree lints", () => {
    const outer = tempProject("lint-outer", { "src/a.ts": "x" });
    const inner = join(outer, ".claude", "worktrees", "w1");
    mkdirSync(join(inner, "src"), { recursive: true });
    writeFileSync(join(inner, "src", "b.ts"), "x");
    for (const dir of [outer, inner]) spawnSync("git", ["init", "-q", dir]);
    const payload = { tool_name: "Edit", tool_input: { file_path: join(inner, "src", "b.ts") }, cwd: inner };
    const root = lintRootFor(payload);
    assert.equal(realpathSync(root), realpathSync(inner));
    assert.deepEqual(lintCommandsFor(payload, config, root).map((target) => target.command), ["eslint src/b.ts"]);
    // The outer checkout as root sees `.claude/worktrees/w1/src/b.ts`, which a `src/**` glob misses.
    const scoped = { lintOnEdit: { command: "eslint {file}", match: ["src/**"] } };
    assert.deepEqual(lintCommandsFor(payload, scoped, outer), []);
    assert.equal(lintCommandsFor(payload, scoped, root).length, 1);
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

  it("runs every matching rule and reports each failure, as a process", () => {
    const fail = (word) => `node -e "console.error('${word}'); process.exit(1)" --`;
    const project = tempProject("lint-rules", {
      "kit.json": {
        project: "my-app",
        lintOnEdit: [
          { command: fail("style broken"), match: ["*.json"] },
          { command: `node -e "process.exit(0)" --`, match: ["*.json"] },
          { command: fail("i18n keys missing"), match: ["locales/*.json"] },
          { command: fail("never"), match: ["*.ts"] },
        ],
      },
      "locales/en.json": "{}",
    });
    const result = runHook("lint-edited-file.mjs", { tool_name: "Edit", tool_input: { file_path: join(project, "locales/en.json") }, cwd: project }, { CLAUDE_PROJECT_DIR: project });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /style broken/);
    assert.match(result.stderr, /i18n keys missing/);
    assert.doesNotMatch(result.stderr, /never/);
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

  it("words an update notice for the user copy, and clears a project copy with kit installs", () => {
    const user = updateText([{ plugin: "core", marketplace: "agent-kit", scope: "user", installed: "a".repeat(40), latest: "b".repeat(40), ref: "stable", loaded: true, userInstalled: "a".repeat(40) }]);
    assert.match(user, /core@agent-kit: aaaaaaaaaaaa installed, stable is bbbbbbbbbbbb/);
    assert.match(user, /claude plugin marketplace update agent-kit/);
    assert.match(user, /claude plugin update core@agent-kit --scope user/);
    assert.doesNotMatch(user, /kit installs/);
    const project = updateText([{ plugin: "core", marketplace: "agent-kit", scope: "project", installed: "a".repeat(40), latest: "b".repeat(40), ref: "stable", loaded: true, userInstalled: "b".repeat(40) }]);
    assert.match(project, /core@agent-kit \(project-scope copy, loaded instead of the user copy\): aaaaaaaaaaaa installed/);
    assert.match(project, /claude plugin update core@agent-kit --scope user/);
    assert.match(project, /^ {4}kit installs --clean$/m);
    assert.doesNotMatch(project, /--scope project/);
    const noUser = updateText([{ plugin: "core", marketplace: "agent-kit", scope: "project", installed: "a".repeat(40), latest: "b".repeat(40), ref: "stable", loaded: true, userInstalled: null }]);
    assert.match(noUser, /claude plugin install core@agent-kit --scope user/);
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
    assert.deepEqual(updateCommands(lagging[0]), ["claude plugin marketplace update agent-kit", "claude plugin update core@agent-kit --scope user"]);
  });

  const sha = (c) => c.repeat(40);
  const kitState = (registered) => ({
    marketplaces: { "agent-kit": { source: { source: "github", repo: "owner/agent-kit", ...registered } } },
    installed: { "core@agent-kit": [{ scope: "user", version: sha("a").slice(0, 12), gitCommitSha: sha("a") }] },
  });
  const cacheKey = (ref) => `agent-kit https://github.com/owner/agent-kit.git ${ref}`;

  it("fresh reads the remote past a recent cache entry that still names the installed commit", () => {
    const cacheFile = join(tempProject("update-fresh"), "update-check.json");
    const now = 1_000_000_000;
    writeFileSync(cacheFile, JSON.stringify({ [cacheKey("stable")]: { sha: sha("a"), at: now - 60_000 } }));
    const state = kitState({ ref: "stable" });
    const cached = checkUpdates({ state, cacheFile, now, resolveSha: () => sha("b") });
    assert.deepEqual(cached.lagging, [], "the session-start check trusts a cache younger than six hours");
    const fresh = checkUpdates({ state, cacheFile, now, fresh: true, resolveSha: () => sha("b") });
    assert.equal(fresh.lagging.length, 1);
    assert.equal(fresh.lagging[0].latest, sha("b"));
    assert.equal(fresh.lagging[0].from, "remote");
    assert.equal(JSON.parse(readFileSync(cacheFile, "utf8"))[cacheKey("stable")].sha, sha("b"));
  });

  it("fresh falls back to the cached SHA, marked as such, when the remote cannot be read", () => {
    const cacheFile = join(tempProject("update-fresh-offline"), "update-check.json");
    const now = 1_000_000_000;
    writeFileSync(cacheFile, JSON.stringify({ [cacheKey("stable")]: { sha: sha("a"), at: now - 3 * 3600_000 } }));
    const { checked } = checkUpdates({ state: kitState({ ref: "stable" }), cacheFile, now, fresh: true, resolveSha: () => null });
    assert.deepEqual(
      checked.map(({ latest, from, cachedAt }) => ({ latest, from, cachedAt })),
      [{ latest: sha("a"), from: "cache", cachedAt: now - 3 * 3600_000 }],
    );
    assert.equal(JSON.parse(readFileSync(cacheFile, "utf8"))[cacheKey("stable")].sha, sha("a"), "a failed fresh read keeps the last good SHA");
  });

  it("compares against the project's declared ref and keeps the registered one", () => {
    const asked = [];
    const { lagging } = checkUpdates({
      state: kitState({}),
      declared: { "agent-kit": { source: "github", repo: "owner/agent-kit", ref: "stable" } },
      resolveSha: (remote) => {
        asked.push(remote.ref);
        return sha("b");
      },
    });
    assert.deepEqual(asked, ["stable"]);
    assert.equal(lagging[0].ref, "stable");
    assert.equal(lagging[0].registeredRef, "HEAD");
    assert.match(updateText(lagging), /registered agent-kit \(HEAD, project wants stable\)/);
  });

  it("checks a plugin whose catalog entry names its own repository against that repository's ref", () => {
    const location = tempProject("own-source-marketplace", {
      ".claude-plugin/marketplace.json": {
        name: "my-kit",
        plugins: [
          { name: "inside", source: "./plugins/inside" },
          { name: "outside", source: { source: "github", repo: "owner/outside-plugin", ref: "local" } },
          { name: "pinned", source: { source: "url", url: "https://example.com/pinned.git", sha: sha("p") } },
        ],
      },
    });
    const record = (c) => [{ scope: "user", version: sha(c).slice(0, 12), gitCommitSha: sha(c) }];
    const state = {
      marketplaces: { "my-kit": { source: { source: "github", repo: "owner/my-kit" }, installLocation: location } },
      installed: { "inside@my-kit": record("a"), "outside@my-kit": record("o"), "pinned@my-kit": record("p") },
    };
    const asked = [];
    const { checked, lagging } = checkUpdates({
      state,
      resolveSha: (remote) => {
        asked.push(`${remote.url} ${remote.ref}`);
        return remote.url.includes("outside") ? sha("o") : sha("m");
      },
    });
    assert.deepEqual(asked.sort(), ["https://github.com/owner/my-kit.git HEAD", "https://github.com/owner/outside-plugin.git local"]);
    assert.deepEqual(
      checked.map(({ plugin, ref, from, source }) => ({ plugin, ref, from, source })),
      [
        { plugin: "inside", ref: "HEAD", from: "remote", source: null },
        { plugin: "outside", ref: "local", from: "remote", source: "https://github.com/owner/outside-plugin.git" },
        { plugin: "pinned", ref: "HEAD", from: "pinned", source: "https://example.com/pinned.git" },
      ],
    );
    assert.deepEqual(lagging.map((item) => item.plugin), ["inside"], "only the plugin inside the marketplace lags its HEAD");
    const project = tempProject("own-source-doctor");
    const texts = checkVersions(project, { state, cacheFile: null, resolveSha: (remote) => (remote.url.includes("outside") ? sha("o") : sha("m")) }).map((finding) => `${finding.level} ${finding.text}`);
    assert.ok(texts.includes(`ok outside@my-kit (user) is at local ${sha("o").slice(0, 12)} (read from the remote, plugin source https://github.com/owner/outside-plugin.git)`), texts.join("\n"));
    assert.ok(texts.includes(`ok pinned@my-kit (user) is at the commit its catalog entry pins ${sha("p").slice(0, 12)} (pinned, plugin source https://example.com/pinned.git)`), texts.join("\n"));
  });

  it("caches outside a hook in the folder the hook uses, core-agent-kit", () => {
    const configDir = tempProject("claude-config", { "plugins/data/.keep": "" });
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import { defaultCacheFile } from ${JSON.stringify(join(core, "src", "update-check.mjs"))}; console.log(defaultCacheFile());`],
      { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_PLUGIN_DATA: "" } },
    );
    assert.equal(run.stdout.trim(), join(configDir, "plugins", "data", "core-agent-kit", "update-check.json"));
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
    "lintOnEdit list": { ...minimal, lintOnEdit: [{ command: "eslint {file}", match: ["*.ts"] }, { command: "i18n-check", match: ["locales/*.json"] }] },
    "lintOnEdit empty list": { ...minimal, lintOnEdit: [] },
    "lintOnEdit list with a bad rule": { ...minimal, lintOnEdit: [{ command: "eslint" }, { match: ["*.ts"] }] },
    "lintOnEdit list with an unknown key": { ...minimal, lintOnEdit: [{ command: "eslint", files: ["*.ts"] }] },
    "lintOnEdit a string": { ...minimal, lintOnEdit: "eslint" },
    "checks ok": { ...minimal, checks: { i18n: ["a", "b"], docs: ["c"] } },
    "checks empty suite": { ...minimal, checks: { i18n: [] } },
    "checks named like a command": { ...minimal, checks: { test: ["a"] } },
    "checks named all": { ...minimal, checks: { all: ["a"] } },
    "checks bad name": { ...minimal, checks: { "I18N!": ["a"] } },
    "checks not a list": { ...minimal, checks: { i18n: "a" } },
    "preflight ok": { ...minimal, preflight: { docs: { description: "Docs review", match: ["docs/**"], remindAfter: 3 }, audit: { description: "Audit", command: "npm run audit" } } },
    "preflight without description": { ...minimal, preflight: { docs: { command: "x" } } },
    "preflight remindAfter zero": { ...minimal, preflight: { docs: { description: "x", remindAfter: 0 } } },
    "preflight unknown key": { ...minimal, preflight: { docs: { description: "x", every: 3 } } },
    "preflight bad id": { ...minimal, preflight: { "Docs Review": { description: "x" } } },
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

  it("accepts a list of lintOnEdit rules, check suites and preflight steps", () => {
    const kit = {
      project: "my-app",
      lintOnEdit: [{ command: "eslint {file}", match: ["*.ts"] }, { command: "i18n-check", match: ["locales/*.json"] }],
      checks: { i18n: ["pnpm run i18n:check"] },
      preflight: { docs: { description: "Docs review" } },
    };
    const { findings } = checkKitJson(tempProject("doctor-kit-lists", { "kit.json": kit }), schema);
    assert.deepEqual(findings.map((finding) => finding.level), ["ok"]);
  });

  it("fails a check suite named like a command", () => {
    const { findings } = checkKitJson(tempProject("doctor-kit-suite", { "kit.json": { project: "my-app", checks: { build: ["x"] } } }), schema);
    assert.ok(findings.some((finding) => finding.level === "fail" && finding.text.includes('"build"')));
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

  it("accepts the kit's own repo without declaring its marketplace, and only that repo", () => {
    const home = tempProject("user-home-kit", { "settings.json": { enabledPlugins: { "core@agent-kit": true } } });
    const kitRepo = (name, marketplace) =>
      tempProject(name, {
        ".claude-plugin/marketplace.json": { name: marketplace, plugins: [{ name: "core", source: "./plugins/core" }] },
        "plugins/core/.claude-plugin/plugin.json": { name: "core" },
      });
    const levels = (dir) => checkSettings(dir, { project: "my-kit" }, home).map((finding) => `${finding.level} ${finding.text}`);
    for (const strict of [false, true]) {
      const findings = checkSettings(kitRepo("doctor-kit-repo", "agent-kit"), { project: "my-kit" }, home, { repoOnly: strict });
      assert.deepEqual(findings.filter((finding) => finding.level !== "ok"), [], `strict: ${strict}`);
      assert.ok(findings.some((finding) => /core@agent-kit is this repo's own plugin \(plugins\/core\)/.test(finding.text)));
      assert.ok(findings.some((finding) => /marketplace agent-kit is this repo's own/.test(finding.text)));
    }
    // A consumer project, and an overlay kit's repo, still need the base kit declared and enabled.
    for (const dir of [tempProject("doctor-consumer", {}), kitRepo("doctor-overlay-repo", "overlay")]) {
      const found = levels(dir);
      assert.ok(found.some((line) => line.startsWith("warn core@agent-kit (always) is enabled only for you")), found.join("\n"));
      assert.ok(found.some((line) => line.startsWith("fail marketplace agent-kit is not declared")), found.join("\n"));
    }
    // A marketplace.json whose core source is not a plugin folder does not make the repo the kit.
    const broken = tempProject("doctor-kit-no-source", { ".claude-plugin/marketplace.json": { name: "agent-kit", plugins: [{ name: "core", source: "./plugins/core" }] } });
    assert.ok(levels(broken).some((line) => line.startsWith("warn core@agent-kit")));
  });

  it("warns when this machine or the user's settings hold the marketplace at another ref", () => {
    const stable = { source: { source: "github", repo: "owner/agent-kit", ref: "stable" } };
    const refless = { source: { source: "github", repo: "owner/agent-kit" } };
    const home = tempProject("user-home-refless", {
      "settings.json": { extraKnownMarketplaces: { "agent-kit": refless } },
      "plugins/known_marketplaces.json": { "agent-kit": refless },
    });
    const project = tempProject("doctor-ref", {
      ".claude/settings.json": { extraKnownMarketplaces: { "agent-kit": stable }, enabledPlugins: { "core@agent-kit": true } },
    });
    const warns = checkSettings(project, { project: "my-app" }, home).filter((finding) => finding.level === "warn").map((finding) => finding.text);
    assert.equal(warns.length, 2);
    assert.match(warns[0], /user settings\.json declares it with no ref \(HEAD\).*add "ref": "stable".*claude plugin marketplace add owner\/agent-kit#stable/);
    assert.match(warns[1], /registered on this machine with no ref \(HEAD\).*After the user settings fix/);
    assert.deepEqual(checkMarketplaceRefs({ "agent-kit": stable }, { "agent-kit": stable }, { "agent-kit": stable }), []);
    assert.deepEqual(checkMarketplaceRefs({ "agent-kit": refless }, {}, { "agent-kit": stable }), [], "a project that names no ref accepts any");
  });

  it("reports a plugin behind the remote even when the cache says it is current", () => {
    const project = tempProject("doctor-versions");
    const sha = (c) => c.repeat(40);
    const state = {
      marketplaces: { "agent-kit": { source: { source: "github", repo: "owner/agent-kit", ref: "stable" } } },
      installed: { "core@agent-kit": [{ scope: "user", version: sha("a").slice(0, 12), gitCommitSha: sha("a") }] },
    };
    const cacheFile = join(project, "update-check.json");
    const now = 1_000_000_000;
    writeFileSync(cacheFile, JSON.stringify({ "agent-kit https://github.com/owner/agent-kit.git stable": { sha: sha("a"), at: now - 60_000 } }));
    const behind = checkVersions(project, { state, cacheFile, now, resolveSha: () => sha("b") });
    assert.equal(behind.length, 1);
    assert.equal(behind[0].level, "warn");
    assert.match(behind[0].text, /installed aaaaaaaaaaaa, stable on the remote is bbbbbbbbbbbb/);
    writeFileSync(cacheFile, JSON.stringify({ "agent-kit https://github.com/owner/agent-kit.git stable": { sha: sha("a"), at: now - 60_000 } }));
    const offline = checkVersions(project, { state, cacheFile, now, resolveSha: () => null });
    assert.equal(offline[0].level, "warn");
    assert.match(offline[0].text, /remote could not be read; a cached stable from \d+ min ago matches the installed aaaaaaaaaaaa; not proof/);
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

  it("still claims a project copy under a renamed skill's or agent's former name", () => {
    const sdlc = join(repo, "plugins", "sdlc");
    const owned = ownedBy({ root: sdlc, name: "sdlc" }).files;
    const former = owned.find((file) => file.path === ".claude/skills/sdlc-plan");
    assert.equal(former?.note, "former name of skill sdlc:plan");
    assert.ok(owned.some((file) => file.path === ".claude/agents/sdlc-verifier.md"));
    const project = tempProject("owned-former", {
      ".claude/skills/sdlc-plan/SKILL.md": "x",
      ".claude/commands/svelte-runes.md": "x",
      ".claude/skills/my-app-plan/SKILL.md": "x",
    });
    const plugins = ["sdlc", "svelte"].map((name) => ({ root: join(repo, "plugins", name), name }));
    const copies = findKitCopies(project, plugins).map((copy) => copy.path);
    assert.deepEqual(copies.sort(), [".claude/commands/svelte-runes.md", ".claude/skills/sdlc-plan"]);
  });

  it("claims one JSON key with a `file#key.path` entry and leaves the project's own keys alone", () => {
    const overlay = tempProject("owned-json-key-plugin", {
      "kit-owned.json": { files: [".mcp.json#mcpServers.ui-docs", ".mcp.json#mcpServers.browser"] },
    });
    const plugins = [{ root: overlay, name: "overlay" }];
    const own = tempProject("owned-json-key-own", { ".mcp.json": { mcpServers: { "my-index": { command: "x" } } } });
    assert.deepEqual(findKitCopies(own, plugins), []);
    const mixed = tempProject("owned-json-key-mixed", {
      ".mcp.json": { mcpServers: { "my-index": { command: "x" }, browser: { command: "y" } } },
    });
    assert.deepEqual(findKitCopies(mixed, plugins).map((copy) => copy.path), [".mcp.json (mcpServers.browser)"]);
    assert.deepEqual(findKitCopies(tempProject("owned-json-key-none", {}), plugins), []);
  });

  it("counts an installed or sibling plugin only when the project enables it or a plugin that needs it", () => {
    const lang = tempProject("enabled-lang", { ".claude-plugin/plugin.json": { name: "lang" } });
    const overlay = tempProject("enabled-overlay", { ".claude-plugin/plugin.json": { name: "overlay", dependencies: ["base@kit"] } });
    const base = tempProject("enabled-base", { ".claude-plugin/plugin.json": { name: "base" } });
    const plugins = [
      { root: core, name: "core", source: "self" },
      { root: lang, name: "lang", source: "sibling" },
      { root: overlay, name: "overlay", source: "installed" },
      { root: base, name: "base", source: "installed" },
    ];
    const names = (dir) => enabledForProject(dir, plugins).map((plugin) => plugin.name);
    assert.deepEqual(names(tempProject("enabled-none", {})), ["core", "lang", "overlay", "base"]);
    const project = tempProject("enabled-some", { ".claude/settings.json": { enabledPlugins: { "overlay@ov": true, "lang@kit": true } } });
    assert.deepEqual(names(project), ["core", "lang", "overlay", "base"]);
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "lang@kit": false } }));
    assert.deepEqual(names(project), ["core", "overlay", "base"]);
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

describe("kit text copied under another name", () => {
  const rule = readFileSync(join(core, "rules", "always-on.md"), "utf8");

  it("textLines drops short lines, list marks and front matter", () => {
    const lines = textLines("---\nname: x\n---\n# Title\n1. **Use English** in chat by default, always.\n- ok\n|  a table cell that is long enough |\n");
    assert.deepEqual([...lines], ["**use english** in chat by default, always.", "a table cell that is long enough"]);
  });

  it("flags core's rule pasted into a renamed rule file or CLAUDE.md, not a file that quotes a line", () => {
    const project = tempProject("renamed-rule", {
      ".claude/rules/house-style.md": `# Our house style\n\n${rule}\n\nProject line that the kit does not have at all.\n`,
      "CLAUDE.md": `# Project\n\n${rule.split("\n").slice(0, 3).join("\n")}\n`,
      ".claude/rules/own.md": "# Own\n\nA rule only this project has, long enough to count as a line.\n",
    });
    const copies = textCopies(project, { root: core, name: "core" });
    assert.deepEqual(copies.map((copy) => copy.path), [".claude/rules/house-style.md"]);
    assert.match(copies[0].note, /of core's rules\/always-on\.md/);
    const all = findKitCopies(project, [{ root: core, name: "core" }]);
    assert.ok(all.some((copy) => copy.path === ".claude/rules/house-style.md" && copy.plugin === "core"));
  });

  it("flags a kit skill copied under a new folder name once", () => {
    const skill = readFileSync(join(core, "skills", "check", "SKILL.md"), "utf8");
    const project = tempProject("renamed-skill", { ".claude/skills/run-checks/SKILL.md": skill, ".claude/skills/check/SKILL.md": skill });
    const paths = findKitCopies(project, [{ root: core, name: "core" }]).map((copy) => copy.path);
    assert.ok(paths.includes(".claude/skills/run-checks/SKILL.md"));
    assert.ok(paths.includes(".claude/skills/check"));
    assert.ok(!paths.includes(".claude/skills/check/SKILL.md"), "a same-name copy is named once, by its folder");
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

  it("names the project after its repo, not a linked worktree's folder", () => {
    const main = tempProject("named-repo", { "README.md": "x" });
    const git = (...args) => spawnSync("git", args, { cwd: main, encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(main, ".claude", "worktrees", "brave-otter-1a2b3c");
    git("worktree", "add", "-q", "-b", "w", worktree);
    assert.equal(repoName(worktree), "named-repo");
    git("remote", "add", "origin", "git@github.com:owner/real-name.git");
    assert.equal(repoName(worktree), "real-name");
  });

  it("takes an integration branch before origin/HEAD", () => {
    const main = tempProject("integration-branch", { "README.md": "x" });
    const git = (...args) => spawnSync("git", args, { cwd: main, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    assert.equal(baseBranch(main), "main");
    git("branch", "dev");
    assert.equal(baseBranch(main), "dev");
    assert.equal(starterKitJson(main).baseBranch, "dev");
  });

  it("finds the SDLC folder that already holds items", () => {
    const archived = tempProject("sdlc-archived", { "intent/archive/2026-01-01-x/intent.md": "x" });
    assert.equal(sdlcPath(archived), "intent");
    assert.deepEqual(starterKitJson(archived).paths, { sdlc: "intent" });
    const active = tempProject("sdlc-active", { "docs/specs/login/intent.md": "x", "intent/notes.md": "x" });
    assert.equal(sdlcPath(active), "docs/specs");
    const plain = tempProject("sdlc-default", { "docs/sdlc/a/intent.md": "x" });
    assert.equal(sdlcPath(plain), "docs/sdlc");
    assert.equal(starterKitJson(plain).paths, undefined);
    assert.equal(sdlcPath(tempProject("sdlc-none", { "README.md": "x" })), null);
  });

  it("guesses Python and Makefile commands when package.json has none", () => {
    const py = tempProject("py-app", {
      "pyproject.toml": "[project]\nname = 'x'\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n",
      "uv.lock": "",
      "tests/test_x.py": "",
      Makefile: "build:\n\tpython -m build\n",
    });
    assert.deepEqual(starterKitJson(py).commands, { check: "uv run mypy .", lint: "uv run ruff check .", test: "uv run pytest", build: "make build" });
    const plain = tempProject("py-plain", { ".python-version": "3.12", "pytest.ini": "" });
    assert.deepEqual(otherCommands(plain), { test: "pytest" });
    assert.deepEqual(otherCommands(plain, { test: "npm test" }), {}, "a command package.json gave wins");
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

describe("kit-owned tests and ownership fixes", () => {
  it("finds a test beside a kit-owned script and one importing it, even after the script is gone", () => {
    const owned = ["scripts/hooks/ledger-brief.mjs", "scripts/git-commit-session.mjs", ".claude/rules/x.md"];
    const texts = {
      "tests/commit.test.ts": `import { a } from "../scripts/git-commit-session.js";`,
      "tests/other.test.ts": `import { b } from "../src/other";`,
    };
    const found = testsOfOwned(owned, ["scripts/hooks/ledger-brief.test.ts", "tests/commit.test.ts", "tests/other.test.ts"], (path) => texts[path] ?? "");
    assert.deepEqual(found, [
      { test: "scripts/hooks/ledger-brief.test.ts", of: "scripts/hooks/ledger-brief.mjs" },
      { test: "tests/commit.test.ts", of: "scripts/git-commit-session.mjs" },
    ]);
    assert.deepEqual(relativeImports(`import x from "./a.mjs"; export * from "../b"; await import('./c.js'); require("./d"); import "node:fs";`), ["./a.mjs", "../b", "./c.js", "./d"]);
  });

  it("lists those tests in a project, through git", () => {
    const session = join(repo, "plugins", "session");
    const project = tempProject("owned-tests", {
      "scripts/hooks/session-ledger.test.ts": "x",
      "scripts/hooks/my-own-hook.test.ts": "x",
      "test/flow.test.mjs": `import { flow } from "../scripts/worktree-flow.mjs";`,
    });
    spawnSync("git", ["init", "-q"], { cwd: project });
    const copies = findKitCopies(project, [{ root: session, name: "session" }]);
    assert.deepEqual(copies.map((copy) => copy.path).sort(), ["scripts/hooks/session-ledger.test.ts", "test/flow.test.mjs"]);
    assert.ok(copies.every((copy) => copy.note.includes("already gone")));
  });

  it("skips tests of kit-owned scripts in the repo the plugin comes from, and keeps its other copies", () => {
    const session = join(repo, "plugins", "session");
    const files = {
      // Fixture data in the kit's own tests: an import of a kit-owned script inside a string.
      "tests/session.test.mjs": "const fixture = `import { a } from \"../scripts/git-commit-session.mjs\";`;",
      ".claude/commands/handoff.md": "x",
    };
    const kit = tempProject("owned-tests-kit-repo", {
      ...files,
      ".claude-plugin/marketplace.json": { name: "agent-kit", plugins: [{ name: "session", source: "./plugins/session" }] },
      "plugins/session/.claude-plugin/plugin.json": { name: "session" },
    });
    const consumer = tempProject("owned-tests-consumer", files);
    for (const dir of [kit, consumer]) spawnSync("git", ["init", "-q"], { cwd: dir });
    const paths = (dir) => findKitCopies(dir, [{ root: session, name: "session" }]).map((copy) => copy.path).sort();
    assert.deepEqual(paths(kit), [".claude/commands/handoff.md"]);
    assert.deepEqual(paths(consumer), [".claude/commands/handoff.md", "tests/session.test.mjs"]);
  });

  it("names the worktree set-up hook where projects keep it, and leaves design-language rules to an overlay", () => {
    const session = JSON.parse(readFileSync(join(repo, "plugins", "session", "kit-owned.json"), "utf8"));
    assert.ok(session.files.includes("scripts/hooks/worktree-setup-hook.mjs"));
    assert.ok(!session.files.includes("scripts/worktree-setup-hook.mjs"));
    const svelte = JSON.parse(readFileSync(join(repo, "plugins", "svelte", "kit-owned.json"), "utf8"));
    assert.ok(!svelte.files.includes(".claude/rules/ui-styling.md"));
    for (const path of Object.keys(svelte.partial)) assert.ok(svelte.files.includes(path), `partial names a listed file: ${path}`);
  });
});

describe("plugins loaded with --plugin-dir", () => {
  const plugins = join(repo, "plugins");

  it("reads --plugin-dir from the claude process, a path with spaces included", () => {
    const spaced = tempProject("my plugins/overlay", { ".claude-plugin/plugin.json": { name: "overlay" } });
    const command = `/opt/Some Folder/claude -p x --plugin-dir ${spaced} --plugin-dir=plugins/sdlc --model sonnet`;
    assert.deepEqual(pluginDirArgs(command.split(/\s+/), repo), [spaced, join(plugins, "sdlc")]);
    assert.equal(isClaudeProcess({ exe: "/opt/Some Folder/claude", command }), true);
    assert.equal(isClaudeProcess({ exe: "/bin/zsh", command: "zsh -c claude --plugin-dir x" }), false);
    const dirs = sessionPluginDirs({
      env: { KIT_PLUGIN_DIRS: join(plugins, "python") },
      extra: ["plugins/svelte", "plugins/missing"],
      processes: [{ exe: "/bin/zsh", command: "zsh -c 'claude --plugin-dir plugins/session'" }, { exe: "/opt/Some Folder/claude", command }],
      cwd: repo,
    });
    assert.deepEqual(dirs, [join(plugins, "svelte"), join(plugins, "python"), spaced, join(plugins, "sdlc")]);
  });

  it("puts session plugins before installed copies of the same name", () => {
    const overlay = tempProject("overlay-plugin", { ".claude-plugin/plugin.json": { name: "overlay", dependencies: ["core", "missing@other"] } });
    const roots = pluginRoots("/nowhere", { installed: {}, marketplaces: {} }, [overlay]);
    assert.deepEqual(roots.slice(0, 2).map((root) => [root.name, root.source]), [["core", "self"], ["overlay", "session"]]);
    const userDir = tempProject("loaded-user", { "settings.json": {} });
    const findings = checkLoadedPlugins(tempProject("loaded-project"), roots, userDir);
    assert.ok(findings.some((finding) => finding.level === "ok" && finding.text.startsWith("overlay loaded for this session")));
    const warns = findings.filter((finding) => finding.level === "warn").map((finding) => finding.text);
    assert.deepEqual(warns, ["overlay needs missing@other, which is neither enabled nor loaded with --plugin-dir"]);
  });

  it("takes repeated --plugin-dir arguments", () => {
    assert.deepEqual(optionValues(["--offline", "--plugin-dir", "a", "--plugin-dir=b"], "--plugin-dir"), ["a", "b"]);
  });
});

describe("kit commands", () => {
  it("lists check suites after the commands", () => {
    const project = tempProject("suites", { "kit.json": { project: "my-app", commands: { test: "npm test" }, checks: { i18n: ["a", "b"] } } });
    const lines = [];
    printCommands(project, (line) => lines.push(line));
    assert.deepEqual(lines, [
      "1. test: `npm test`",
      "",
      "Check suites (kit.json checks), each run in order by `/core:check <suite>`:",
      "1. i18n:",
      "   1.1. `a`",
      "   1.2. `b`",
    ]);
  });
});
