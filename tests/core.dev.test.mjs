// `kit dev`: scratch projects and fake kit checkouts (a base kit and one overlay), planned and run
// with a stubbed `claude`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { checkoutState, devPlan, loadCheckouts, parseDevArgs, runDev, shellWord } from "../plugins/core/src/dev-plugins.mjs";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-kit-dev-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const hooks = join(scratch, "no-hooks");
mkdirSync(hooks);
const REPO = join(dirname(new URL(import.meta.url).pathname), "..");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

/** A kit checkout: a git repo on main with one commit, its marketplace and plugins `{ name: deps }`. */
function kitCheckout(dir, marketplace, plugins) {
  const files = {
    ".claude-plugin/marketplace.json": { name: marketplace, plugins: Object.keys(plugins).map((name) => ({ name, source: `./plugins/${name}` })) },
  };
  for (const [name, deps] of Object.entries(plugins)) {
    files[`plugins/${name}/.claude-plugin/plugin.json`] = { name, ...(deps.length ? { dependencies: deps } : {}) };
  }
  write(dir, files);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", hooks);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function project(name, enabled, local = null) {
  const dir = join(scratch, name);
  const files = {
    ".claude/settings.json": {
      extraKnownMarketplaces: { "agent-kit": { source: { source: "github", repo: "owner/agent-kit", ref: "stable" } } },
      enabledPlugins: Object.fromEntries(enabled.map((id) => [id, true])),
    },
  };
  if (local) files[".claude/settings.local.json"] = { enabledPlugins: local };
  write(dir, files);
  return dir;
}

const base = kitCheckout(join(scratch, "agent-kit"), "agent-kit", { core: [], sdlc: ["core"], session: ["core"] });
const overlay = kitCheckout(join(scratch, "my overlay"), "my-overlay", { review: ["core@agent-kit"], extra: [] });
const configFile = join(scratch, "config", "checkouts.json");
write(dirname(configFile), { "checkouts.json": { "agent-kit": base, "my-overlay": "../my overlay" } });
const clean = () => ({ repo: true, branch: "main", base: "main", dirty: 0 });

function capture() {
  const lines = [];
  return { lines, print: (line) => lines.push(line), text: () => lines.join("\n") };
}

describe("kit dev", () => {
  it("parses its arguments and rejects the rest", () => {
    const parsed = parseDevArgs(["--checkout", "a=/x", "--checkout=b=~/y", "--run", "--config", "c.json", "--", "--model", "m"]);
    assert.deepEqual(parsed.checkouts, { a: "/x", b: "~/y" });
    assert.equal(parsed.config, "c.json");
    assert.equal(parsed.run, true);
    assert.deepEqual(parsed.passThrough, ["--model", "m"]);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parseDevArgs(["--checkout", "nopath", "--bogus", "--config"]).errors, [
      "--checkout nopath: write it as <marketplace>=<path>",
      "unknown argument --bogus",
      "--config needs a value",
    ]);
  });

  it("reads checkouts from the config file, relative to it, with --checkout over it", () => {
    const loaded = loadCheckouts({ file: configFile, flags: { "agent-kit": "~/kits/agent-kit" }, home: "/home/me" });
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.checkouts["my-overlay"].path, overlay);
    assert.equal(loaded.checkouts["agent-kit"].path, "/home/me/kits/agent-kit");
    assert.equal(loaded.checkouts["agent-kit"].from, "--checkout");
    assert.deepEqual(loadCheckouts({ file: join(scratch, "none.json") }).checkouts, {});
    write(scratch, { "bad.json": "[1]" });
    assert.match(loadCheckouts({ file: join(scratch, "bad.json") }).errors[0], /must be an object/);
  });

  it("loads every enabled plugin of the base kit and one overlay from their checkouts", () => {
    const dir = project("app-both", ["core@agent-kit", "sdlc@agent-kit", "review@my-overlay", "other@third-party"]);
    const { checkouts } = loadCheckouts({ file: configFile });
    const plan = devPlan(dir, { checkouts, state: clean });
    assert.deepEqual(plan.loaded.map((item) => item.id), ["core@agent-kit", "review@my-overlay", "sdlc@agent-kit"]);
    assert.deepEqual(plan.installed, [{ id: "other@third-party", why: "no checkout of third-party" }]);
    assert.deepEqual(plan.warnings, ["other@third-party has no local checkout and stays on the installed copy"]);
    assert.deepEqual(plan.command, [
      "claude",
      "--plugin-dir", join(base, "plugins", "core"),
      "--plugin-dir", join(overlay, "plugins", "review"),
      "--plugin-dir", join(base, "plugins", "sdlc"),
    ]);
  });

  it("adds a dependency that is not enabled, from its marketplace's checkout", () => {
    const dir = project("app-overlay-only", ["review@my-overlay"]);
    const plan = devPlan(dir, { checkouts: loadCheckouts({ file: configFile }).checkouts, state: clean });
    assert.deepEqual(plan.loaded.map((item) => [item.id, item.why]), [
      ["review@my-overlay", "enabled"],
      ["core@agent-kit", "dependency of review@my-overlay"],
    ]);
    const noBase = devPlan(dir, { checkouts: { "my-overlay": { path: overlay, from: "test" } }, state: clean });
    assert.deepEqual(noBase.warnings, ["core@agent-kit (dependency of review@my-overlay) is not enabled and has no checkout to load it from"]);
  });

  it("drops a plugin settings.local.json switches off, and warns on missing and unusable checkouts", () => {
    const dir = project("app-local", ["core@agent-kit", "sdlc@agent-kit", "gone@my-overlay"], { "sdlc@agent-kit": false });
    const plan = devPlan(dir, { checkouts: { "agent-kit": { path: base, from: "test" }, "my-overlay": { path: join(scratch, "nowhere"), from: "test" } }, state: clean });
    assert.deepEqual(plan.enabled, ["core@agent-kit", "gone@my-overlay"]);
    assert.deepEqual(plan.installed, [{ id: "gone@my-overlay", why: "checkout my-overlay unusable" }]);
    assert.match(plan.warnings[0], /checkout my-overlay .*nowhere.* does not exist/);
    assert.equal(plan.warnings[1], "gone@my-overlay has no local checkout and stays on the installed copy");
  });

  it("warns when a checkout is dirty, off main or detached", () => {
    write(overlay, { "plugins/review/notes.md": "wip\n" });
    git(overlay, "checkout", "-q", "-b", "feat/review");
    try {
      const real = checkoutState(overlay);
      assert.deepEqual(real, { repo: true, branch: "feat/review", base: "main", dirty: 1 });
      const dir = project("app-dirty", ["core@agent-kit", "review@my-overlay"]);
      const plan = devPlan(dir, { checkouts: loadCheckouts({ file: configFile }).checkouts });
      assert.deepEqual(plan.warnings.filter((line) => line.includes("my-overlay")), [
        `checkout my-overlay (${overlay}) has 1 uncommitted file`,
        `checkout my-overlay (${overlay}) is on branch feat/review, not main`,
      ]);
      assert.ok(!plan.warnings.some((line) => line.includes("checkout agent-kit")));
      const detached = devPlan(dir, { checkouts: loadCheckouts({ file: configFile }).checkouts, state: () => ({ repo: true, branch: null, base: "main", dirty: 0 }) });
      assert.ok(detached.warnings.includes(`checkout agent-kit (${base}) is on a detached HEAD, not main`));
    } finally {
      git(overlay, "checkout", "-q", "main");
      rmSync(join(overlay, "plugins/review/notes.md"));
    }
    assert.deepEqual(checkoutState(join(scratch, "config")), { repo: false, branch: null, base: "main", dirty: 0 });
  });

  it("prints the numbered report with a quoted command and the kit doctor check", () => {
    const dir = project("app-print", ["core@agent-kit", "review@my-overlay"]);
    const out = capture();
    assert.equal(runDev(dir, ["--config", configFile], { print: out.print, state: clean }), 0);
    const text = out.text();
    assert.match(text, /^1\. Plugins$/m);
    assert.match(text, /^ {3}1\.2\. review@my-overlay: .*my overlay\/plugins\/review$/m);
    assert.match(text, /^2\. Warnings\n {3}none$/m);
    assert.ok(text.includes(`claude --plugin-dir ${join(base, "plugins", "core")} --plugin-dir '${join(overlay, "plugins", "review")}'`));
    assert.match(text, /kit doctor.*\n.*loaded for this session with --plugin-dir/);
    assert.equal(shellWord("it's"), `'it'\\''s'`);
  });

  it("starts claude with --run and the arguments after --, in the project folder", () => {
    const dir = project("app-run", ["core@agent-kit"]);
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
      return { status: 3 };
    };
    const out = capture();
    assert.equal(runDev(dir, ["--config", configFile, "--run", "--", "--model", "x"], { print: out.print, state: clean, spawn }), 3);
    assert.deepEqual(calls, [{ command: "claude", args: ["--plugin-dir", join(base, "plugins", "core"), "--model", "x"], cwd: dir, stdio: "inherit" }]);
    const none = project("app-none", ["other@third-party"]);
    assert.equal(runDev(none, ["--config", configFile, "--run"], { print: () => {}, state: clean, spawn }), 1);
    assert.equal(calls.length, 1);
    assert.equal(runDev(none, ["--nope"], { print: () => {} }), 2);
  });

  it("runs as `kit dev` and `agent-kit dev` from the project folder", () => {
    const dir = project("app-cli", ["core@agent-kit"]);
    const xdg = join(scratch, "xdg");
    write(xdg, { "agent-kit/checkouts.json": { "agent-kit": base } });
    const env = { ...process.env, XDG_CONFIG_HOME: xdg };
    delete env.CLAUDE_PROJECT_DIR;
    for (const script of [join(REPO, "plugins", "core", "src", "kit-cli.mjs"), join(REPO, "bin", "agent-kit.mjs")]) {
      const result = spawnSync(process.execPath, [script, "dev"], { cwd: dir, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`claude --plugin-dir ${join(base, "plugins", "core")}`), result.stdout);
    }
  });
});
