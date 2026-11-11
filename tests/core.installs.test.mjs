// Project-scope install records (docs/spikes.md S11): which record a session loads, how the doctor
// and the session-start notice report them, and `kit installs` clearing the stale ones.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkInstalled, checkNestedWorktree, checkVersions, outerCheckout } from "../plugins/core/src/doctor.mjs";
import { runInstalls, surveyInstalls, uninstallCopy } from "../plugins/core/src/installs.mjs";
import { checkUpdates, loadedRecord, recordApplies, repoRoot } from "../plugins/core/src/update-check.mjs";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-kit-installs-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A repo `my-app` with a worktree under it, a sibling worktree beside it, and an unrelated repo. */
function layout(name) {
  const base = join(scratch, name);
  const main = join(base, "my-app");
  mkdirSync(join(main, ".claude"), { recursive: true });
  writeFileSync(join(main, ".claude", "settings.json"), '{"enabledPlugins":{"core@agent-kit":true}}\n');
  git(base, "init", "-q", "-b", "main", "my-app");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "init");
  git(main, "worktree", "add", "-q", ".claude/worktrees/inner", "-b", "inner");
  git(main, "worktree", "add", "-q", "../my-app-sibling", "-b", "sibling");
  const other = join(base, "other-app");
  mkdirSync(other, { recursive: true });
  git(other, "init", "-q", "-b", "main");
  return { base, main, inner: join(main, ".claude", "worktrees", "inner"), sibling: join(base, "my-app-sibling"), other };
}

const sha = (c) => c.repeat(40);
const record = (scope, c, projectPath) => ({
  scope,
  ...(projectPath ? { projectPath } : {}),
  installPath: `/cache/agent-kit/core/${sha(c).slice(0, 12)}`,
  version: sha(c).slice(0, 12),
  gitCommitSha: sha(c),
});
const kitState = (entries) => ({
  marketplaces: { "agent-kit": { source: { source: "github", repo: "owner/agent-kit", ref: "stable" } } },
  installed: { "core@agent-kit": entries },
});

describe("install scopes (S11)", () => {
  const dirs = layout("scopes");

  it("resolves every worktree, and a removed one under the main checkout, to the main checkout", () => {
    assert.equal(repoRoot(dirs.main), dirs.main);
    assert.equal(repoRoot(join(dirs.main, "sub", "dir")), dirs.main);
    assert.equal(repoRoot(dirs.inner), dirs.main);
    assert.equal(repoRoot(dirs.sibling), dirs.main);
    assert.equal(repoRoot(join(dirs.main, ".claude", "worktrees", "gone")), dirs.main, "a removed worktree under the main checkout");
    assert.equal(repoRoot(join(dirs.base, "gone-sibling")), null, "a removed sibling outside every repo");
    assert.equal(repoRoot(dirs.other), dirs.other);
  });

  it("loads the first record that applies, in file order", () => {
    const user = record("user", "u");
    const sibling = record("project", "s", dirs.sibling);
    const elsewhere = record("project", "e", dirs.other);
    assert.equal(loadedRecord([user, sibling], dirs.main), user, "the user record comes first");
    assert.equal(loadedRecord([sibling, user], dirs.main), sibling, "a sibling worktree's record shadows the user copy");
    assert.equal(loadedRecord([sibling, user], dirs.inner), sibling);
    assert.equal(loadedRecord([elsewhere, user], dirs.main), user, "another repository's record does not apply");
    assert.equal(loadedRecord([record("project", "x", dirs.main)], dirs.other), null);
    assert.equal(recordApplies(record("project", "g", join(dirs.main, ".claude", "worktrees", "gone")), dirs.main), true);
    assert.equal(recordApplies(record("project", "g", join(dirs.base, "gone-sibling")), dirs.main), false);
  });

  it("marks the loaded copy and this folder's own copy, and keeps other repositories out", () => {
    const state = kitState([record("project", "s", dirs.sibling), record("user", "u"), record("project", "m", dirs.main), record("project", "e", dirs.other)]);
    const { checked, lagging } = checkUpdates({ root: dirs.main, state, resolveSha: () => sha("u") });
    assert.deepEqual(
      checked.map(({ scope, installed, loaded, own, userInstalled }) => ({ scope, installed: installed[0], loaded, own, user: userInstalled[0] })),
      [
        { scope: "project", installed: "s", loaded: true, own: false, user: "u" },
        { scope: "user", installed: "u", loaded: false, own: false, user: "u" },
        { scope: "project", installed: "m", loaded: false, own: true, user: "u" },
      ],
    );
    assert.deepEqual(lagging.map((item) => item.installed[0]), ["s", "m"]);
  });
});

describe("kit doctor: project-scope copies", () => {
  const dirs = layout("doctor");

  it("warns when a project copy is loaded instead of the user copy, and names stale copies of the repo and elsewhere", () => {
    const state = kitState([
      record("project", "s", dirs.sibling),
      record("user", "b"),
      record("project", "b", dirs.inner),
      record("project", "a", dirs.main),
      record("project", "a", dirs.other),
    ]);
    const findings = checkVersions(dirs.main, { state, cacheFile: null, resolveSha: () => sha("b") });
    const texts = findings.map((finding) => `${finding.level} ${finding.text}`);
    assert.equal(findings.filter((finding) => finding.level === "fail").length, 0);
    assert.ok(
      texts.some((text) => /^warn core@agent-kit \(project-scope copy for .*my-app-sibling\): installed s{12}, stable on the remote is b{12}; sessions here load this copy instead of the user copy \(b{12}\)/.test(text)),
      texts.join("\n"),
    );
    assert.ok(texts.some((text) => /^warn .*kit installs --clean/.test(text) && /--scope user/.test(text)), "the fix names --scope user and kit installs --clean");
    assert.ok(texts.some((text) => /^ok core@agent-kit \(user\) is at stable b{12}/.test(text)));
    assert.ok(texts.some((text) => /^warn core@agent-kit \(project-scope copy for this folder\): a{12} differs from the user copy b{12} and stable b{12}\. Sessions here don't load it/.test(text)));
    assert.equal(texts.filter((text) => text.includes("inner")).length, 0, "a copy that matches the user copy and the channel is not reported");
    assert.ok(texts.some((text) => /^warn 1 project-scope copies of kit plugins in 1 other folder\(s\) differ from their user copy; `kit installs`/.test(text)));
  });

  it("stays quiet about project copies when there are none to report", () => {
    const state = kitState([record("user", "b"), record("project", "b", dirs.inner)]);
    const findings = checkVersions(dirs.main, { state, cacheFile: null, resolveSha: () => sha("b") });
    assert.deepEqual(findings.map((finding) => finding.level), ["ok"]);
  });
});

describe("kit doctor: what this machine runs for the project", () => {
  const dirs = layout("machine");

  it("warns on an enabled plugin with no install record for the project, unless --plugin-dir loads it", () => {
    assert.deepEqual(checkInstalled(dirs.main, kitState([record("user", "a")])).map((finding) => finding.level), ["ok"]);
    assert.deepEqual(checkInstalled(dirs.inner, kitState([record("project", "a", dirs.sibling)])).map((finding) => finding.level), ["ok"], "a project record of the same repository counts");
    const missing = checkInstalled(dirs.main, kitState([record("project", "a", dirs.other)]));
    assert.equal(missing.length, 1);
    assert.equal(missing[0].level, "warn");
    assert.match(missing[0].text, /^core@agent-kit is enabled in \.claude\/settings\.json but not installed on this machine.*`claude plugin install core@agent-kit --scope user`/);
    assert.deepEqual(checkInstalled(dirs.main, { marketplaces: {}, installed: {} }, new Set(["core"])).map((finding) => finding.level), ["ok"], "a --plugin-dir copy stands in");
    assert.deepEqual(checkInstalled(dirs.other, { marketplaces: {}, installed: {} }), [], "nothing enabled, nothing to say");
  });

  it("checks the versions of the plugins the project enables or declares, not every user plugin", () => {
    const state = {
      marketplaces: {
        "agent-kit": { source: { source: "github", repo: "owner/agent-kit", ref: "stable" } },
        "life-kit": { source: { source: "github", repo: "owner/life-kit" } },
      },
      installed: { "core@agent-kit": [record("user", "b")], "diary@life-kit": [record("user", "d")] },
    };
    const asked = [];
    const resolveSha = (remote) => {
      asked.push(remote.url);
      return sha("b");
    };
    const texts = checkVersions(dirs.main, { state, cacheFile: null, resolveSha }).map((finding) => `${finding.level} ${finding.text}`);
    assert.deepEqual(asked, ["https://github.com/owner/agent-kit.git"], "the unrelated marketplace is never read");
    assert.ok(texts.some((text) => /^ok core@agent-kit \(user\) is at stable/.test(text)), texts.join("\n"));
    assert.ok(texts.includes("ok not checked: diary@life-kit, which this project neither enables nor declares the marketplace of"), texts.join("\n"));
    asked.length = 0;
    checkVersions(dirs.other, { state, cacheFile: null, resolveSha });
    assert.equal(asked.length, 2, "a project whose settings name nothing checks every plugin");
  });

  it("names a worktree nested in a checkout's .claude/worktrees/ and what its .claude/ differs in", () => {
    assert.equal(outerCheckout(dirs.inner), dirs.main);
    assert.equal(outerCheckout(dirs.sibling), null);
    assert.deepEqual(checkNestedWorktree(dirs.sibling, dirs.sibling), []);
    const same = checkNestedWorktree(dirs.inner, dirs.inner);
    assert.deepEqual(same.map((finding) => finding.level), ["ok"]);

    writeFileSync(join(dirs.inner, ".claude", "settings.json"), '{"enabledPlugins":{"core@agent-kit":true,"extra@agent-kit":true}}\n');
    mkdirSync(join(dirs.inner, ".claude", "skills", "new-skill"), { recursive: true });
    const [finding] = checkNestedWorktree(dirs.inner, dirs.inner);
    assert.equal(finding.level, "warn");
    assert.match(finding.text, /sessions here read the outer checkout's \.claude\/ settings, skills and hooks, which differ from this branch's \(\.claude\/settings\.json; \.claude\/skills \+new-skill\)/);
    assert.doesNotMatch(finding.text, /This report reads/);

    const fromShell = checkNestedWorktree(dirs.main, join(dirs.inner, ".claude"));
    assert.match(fromShell[0].text, /This report reads .*my-app, the session's project, not the worktree\.$/, "the session's project is the outer checkout");
  });
});

describe("kit installs", () => {
  const dirs = layout("installs");
  const channels = { channel: () => ({ ref: "stable", registeredRef: "stable", latest: sha("b"), from: "remote", cachedAt: null }), save() {} };

  it("finds the stale copies, which one loads, and which ones it must leave", () => {
    const state = {
      ...kitState([record("project", "a", dirs.sibling), record("user", "b"), record("project", "b", dirs.inner), record("project", "a", join(dirs.main, ".claude", "worktrees", "gone"))]),
    };
    state.installed["sdlc@agent-kit"] = [record("project", "a", dirs.main)];
    state.installed["svelte@agent-kit"] = [record("user", "a"), record("project", "a", dirs.main)];
    const copies = surveyInstalls({ state, channels });
    const view = copies.map(({ id, projectPath, stale, loads, exists, blocked }) => ({ id, at: projectPath.slice(dirs.base.length + 1), stale, loads, exists, blocked: blocked ? blocked.split(";")[0] : null }));
    assert.deepEqual(view, [
      { id: "core@agent-kit", at: "my-app-sibling", stale: true, loads: true, exists: true, blocked: null },
      { id: "core@agent-kit", at: "my-app/.claude/worktrees/inner", stale: false, loads: false, exists: true, blocked: null },
      { id: "core@agent-kit", at: "my-app/.claude/worktrees/gone", stale: true, loads: false, exists: false, blocked: null },
      { id: "sdlc@agent-kit", at: "my-app", stale: true, loads: true, exists: true, blocked: "no user-scope copy to fall back to" },
      { id: "svelte@agent-kit", at: "my-app", stale: true, loads: false, exists: true, blocked: "the user copy (aaaaaaaaaaaa) lags stable (bbbbbbbbbbbb)" },
    ]);
  });

  it("uninstalls from the copy's folder and puts its settings back byte for byte", () => {
    const settings = join(dirs.main, ".claude", "settings.json");
    const before = readFileSync(settings);
    const calls = [];
    const result = uninstallCopy({ id: "core@agent-kit", scope: "project", projectPath: dirs.main }, (args, cwd) => {
      calls.push({ args, cwd });
      writeFileSync(settings, '{\n  "enabledPlugins": {}\n}\n');
      return { ok: true, output: "Successfully uninstalled plugin: core (scope: project)" };
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ args: ["plugin", "uninstall", "core@agent-kit", "--scope", "project"], cwd: dirs.main }]);
    assert.deepEqual(readFileSync(settings), before);
    assert.equal(git(dirs.main, "status", "--porcelain", ".claude/settings.json"), "");
  });

  it("recreates a removed folder for the call and removes it again", () => {
    const gone = join(dirs.main, ".claude", "worktrees", "gone", "deeper");
    let sawFolder = false;
    uninstallCopy({ id: "core@agent-kit", scope: "project", projectPath: gone }, (args, cwd) => {
      sawFolder = existsSync(cwd);
      return { ok: true, output: "ok" };
    });
    assert.equal(sawFolder, true);
    assert.equal(existsSync(join(dirs.main, ".claude", "worktrees", "gone")), false);
    assert.equal(existsSync(join(dirs.main, ".claude", "worktrees", "inner")), true);
  });

  it("lists by default and clears only the stale, unblocked copies with --clean", () => {
    const state = kitState([record("project", "a", dirs.sibling), record("user", "b"), record("project", "b", dirs.inner)]);
    state.installed["sdlc@agent-kit"] = [record("project", "a", dirs.main)];
    const lines = [];
    const calls = [];
    const run = (args, cwd) => {
      calls.push(`${args[2]} ${cwd.slice(dirs.base.length + 1)}`);
      return { ok: true, output: "uninstalled" };
    };
    assert.equal(runInstalls([], { print: (...l) => lines.push(...l), state, resolveSha: () => sha("b"), run }), 0);
    assert.deepEqual(calls, [], "a dry run uninstalls nothing");
    const report = lines.join("\n");
    assert.match(report, /1\. core@agent-kit: user copy b{12}, stable is b{12}\n {3}1\.1\. project .*my-app-sibling: a{12} \(loaded instead of the user copy\)/);
    assert.match(report, /sdlc@agent-kit: user copy none.*\n.*left: no user-scope copy/);
    assert.match(report, /1 other copies match the user copy and the channel; left alone/);
    assert.equal(runInstalls(["--clean"], { print: () => {}, state, resolveSha: () => sha("b"), run }), 0);
    assert.deepEqual(calls, ["core@agent-kit my-app-sibling"]);
  });

  it("says so when nothing is stale", () => {
    const lines = [];
    runInstalls(["--offline"], { print: (line) => lines.push(line), state: kitState([record("user", "b"), record("project", "b", dirs.inner)]) });
    assert.match(lines.join("\n"), /None is stale \(1 current\)/);
  });
});
