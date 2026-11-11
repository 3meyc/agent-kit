// `kit doctor --strict` and `agent-kit doctor`: repo state only, so a CI job without Claude Code
// or installed plugins gets the same answer as a developer's machine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../plugins/core/src/doctor.mjs";
import { parseDoctorArgs } from "../plugins/core/src/kit-cli.mjs";
import { ownershipRootDirs } from "../plugins/core/src/kit-owned.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-kit-strict-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

function tempDir(name, files = {}) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const home = tempDir("home", { "settings.json": {} });

/** A project that adopted the kit: kit.json, the base marketplace and core in the shared settings. */
function adopted(name, files = {}, settings = {}) {
  return tempDir(name, {
    "kit.json": { project: "my-app" },
    ".claude/settings.json": {
      extraKnownMarketplaces: { "agent-kit": { source: { source: "github", repo: "owner/agent-kit", ref: "stable" } }, ...settings.marketplaces },
      enabledPlugins: { "core@agent-kit": true, ...settings.plugins },
    },
    ...files,
  });
}

/** An overlay plugin folder with its own kit-owned.json. */
const overlayPlugins = tempDir("overlay-kit", {
  "plugins/overlay/.claude-plugin/plugin.json": { name: "overlay", dependencies: ["core@agent-kit"] },
  "plugins/overlay/kit-owned.json": { files: [".claude/rules/overlay-rules.md"] },
  "plugins/overlay/skills/overlay-review/SKILL.md": "---\nname: overlay-review\n---\n",
});
const overlay = join(overlayPlugins, "plugins", "overlay");
const withOverlay = { marketplaces: { ov: { source: { source: "github", repo: "owner/ov", ref: "stable" } } }, plugins: { "overlay@ov": true } };

/** runDoctor on this machine's state replaced by an empty one, as in CI. */
function doctor(project, options = {}) {
  const lines = [];
  const code = runDoctor(project, { offline: true, state: { marketplaces: {}, installed: {} }, sessionDirs: [], userDir: home, print: (line) => lines.push(line), ...options });
  return { code, out: lines.join("\n") };
}

describe("kit doctor --strict", () => {
  it("passes an adopted project with no copies", () => {
    const { code, out } = doctor(adopted("strict-clean"), { strict: true });
    assert.equal(code, 0, out);
    assert.match(out, /Strict: passed\./);
  });

  it("fails on a copy of a kit-owned file, which the plain report only warns about", () => {
    const project = adopted("strict-copy", { ".claude/rules/agent-output-rules.md": "x", ".claude/agents/check-runner.md": "x" });
    const strict = doctor(project, { strict: true });
    assert.equal(strict.code, 1);
    assert.match(strict.out, /FAIL \.claude\/rules\/agent-output-rules\.md — supplied by core/);
    assert.match(strict.out, /FAIL \.claude\/agents\/check-runner\.md — supplied by core/);
    assert.match(strict.out, /Strict: 2 finding\(s\) failed\./);
    const plain = doctor(project);
    assert.equal(plain.code, 0, plain.out);
    assert.match(plain.out, /WARN \.claude\/rules\/agent-output-rules\.md/);
  });

  it("fails on kit.json against the schema and on an enabled plugin's undeclared marketplace", () => {
    const badKit = adopted("strict-bad-kit", { "kit.json": { project: "my-app", lintOnEdit: { match: ["*.ts"] } } });
    assert.equal(doctor(badKit, { strict: true }).code, 1);
    const project = tempDir("strict-no-marketplace", {
      "kit.json": { project: "my-app" },
      ".claude/settings.json": { extraKnownMarketplaces: { "agent-kit": { source: {} } }, enabledPlugins: { "core@agent-kit": true, "overlay@ov": true } },
    });
    const { code, out } = doctor(project, { strict: true });
    assert.equal(code, 1);
    assert.match(out, /FAIL marketplace ov is not declared/);
  });

  it("reads only the shared settings: a local opt-out or opt-in does not change the result", () => {
    const project = adopted("strict-local", { ".claude/rules/overlay-rules.md": "x" }, withOverlay);
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "overlay@ov": false } }));
    assert.doesNotMatch(doctor(project, { pluginRoots: [overlay] }).out, /overlay-rules/, "the plain report honours the local opt-out");
    const strict = doctor(project, { strict: true, pluginRoots: [overlay] });
    assert.equal(strict.code, 1, "strict mode does not");
    assert.match(strict.out, /FAIL \.claude\/rules\/overlay-rules\.md/);

    const localOnly = tempDir("strict-local-core", {
      "kit.json": { project: "my-app" },
      ".claude/settings.json": { extraKnownMarketplaces: { "agent-kit": { source: {} } } },
      ".claude/settings.local.json": { enabledPlugins: { "core@agent-kit": true } },
    });
    assert.equal(doctor(localOnly).code, 0, "enabled only for you is a warning");
    const { code, out } = doctor(localOnly, { strict: true });
    assert.equal(code, 1);
    assert.match(out, /FAIL core@agent-kit \(always\) is not enabled/);
  });

  it("never fails on this machine's plugins: a --plugin-dir plugin's missing dependency stays a warning", () => {
    const loose = tempDir("strict-session-plugin", { ".claude-plugin/plugin.json": { name: "loose", dependencies: ["absent@nowhere"] } });
    const { code, out } = doctor(adopted("strict-session"), { strict: true, sessionDirs: [loose] });
    assert.equal(code, 0, out);
    assert.match(out, /WARN loose needs absent@nowhere/);
  });

  it("reads an overlay's kit-owned files from --plugin-root", () => {
    const project = adopted("strict-overlay", { ".claude/rules/overlay-rules.md": "x", ".claude/skills/overlay-review/SKILL.md": "x" }, withOverlay);
    assert.equal(doctor(project, { strict: true }).code, 0, "without the root, nothing says the overlay owns them");
    const { code, out } = doctor(project, { strict: true, pluginRoots: [overlay] });
    assert.equal(code, 1);
    assert.match(out, /FAIL \.claude\/rules\/overlay-rules\.md — supplied by overlay/);
    assert.match(out, /FAIL \.claude\/skills\/overlay-review — supplied by overlay/);
    const notEnabled = adopted("strict-overlay-off", { ".claude/rules/overlay-rules.md": "x" });
    assert.equal(doctor(notEnabled, { strict: true, pluginRoots: [overlay] }).code, 0, "an overlay the project does not enable owns nothing there");
  });
});

describe("doctor arguments", () => {
  it("parses the flags and repeatable roots, and rejects unknown or incomplete ones", () => {
    const parsed = parseDoctorArgs(["--strict", "--offline", "--plugin-root", "a", "--plugin-root=b", "--plugin-dir", "c"]);
    assert.deepEqual(parsed, { strict: true, offline: true, pluginDirs: ["c"], pluginRoots: ["a", "b"], errors: [] });
    assert.deepEqual(parseDoctorArgs(["--strct"]).errors, ["unknown argument --strct"]);
    assert.deepEqual(parseDoctorArgs(["--plugin-root"]).errors, ["--plugin-root needs a path"]);
    assert.deepEqual(parseDoctorArgs(["--plugin-root", "--strict"]).errors, ["--plugin-root needs a path"]);
  });

  it("takes a plugin folder or a folder of plugin folders, and names a root with no plugin", () => {
    assert.deepEqual(ownershipRootDirs([overlay]), { roots: [overlay], missing: [] });
    assert.deepEqual(ownershipRootDirs(["plugins"], overlayPlugins), { roots: [overlay], missing: [] });
    assert.deepEqual(ownershipRootDirs(["nowhere", home], scratch), { roots: [], missing: ["nowhere", home] });
  });
});

describe("agent-kit doctor (the npm bin, as CI runs it)", () => {
  /** A git checkout with no Claude config: an empty CLAUDE_CONFIG_DIR stands in for the CI runner. */
  function ci(project, args) {
    spawnSync("git", ["init", "-q"], { cwd: project });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: tempDir("ci-config"), KIT_PLUGIN_DIRS: "" };
    delete env.CLAUDE_PROJECT_DIR;
    return spawnSync(process.execPath, [join(repo, "bin", "agent-kit.mjs"), "doctor", ...args], { cwd: project, encoding: "utf8", env });
  }

  it("exits 0 on a clean repo, 1 on a copy, and 2 on a usage error", () => {
    const clean = ci(adopted("bin-clean"), ["--strict", "--offline"]);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    const copy = ci(adopted("bin-copy", { "scripts/count-lines.mjs": "x" }), ["--strict", "--offline"]);
    assert.equal(copy.status, 1, copy.stdout + copy.stderr);
    assert.match(copy.stdout, /FAIL scripts\/count-lines\.mjs — supplied by core/);
    const typo = ci(adopted("bin-typo"), ["--strict", "--ofline"]);
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /unknown argument --ofline/);
  });

  it("reads the package's sibling plugins and an overlay's --plugin-root, resolved from the working directory", () => {
    const sibling = ci(adopted("bin-sibling", { ".claude/rules/svelte-5-runes-mode-rules.md": "x" }, { plugins: { "svelte@agent-kit": true } }), ["--strict", "--offline"]);
    assert.equal(sibling.status, 1, sibling.stdout + sibling.stderr);
    assert.match(sibling.stdout, /supplied by svelte/);
    const project = adopted("bin-overlay", { ".claude/rules/overlay-rules.md": "x" }, withOverlay);
    cpSync(overlayPlugins, join(project, "node_modules", "overlay-tools"), { recursive: true });
    const result = ci(project, ["--strict", "--offline", "--plugin-root", "node_modules/overlay-tools/plugins/overlay"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL \.claude\/rules\/overlay-rules\.md — supplied by overlay/);
    const missing = ci(project, ["--strict", "--offline", "--plugin-root", "node_modules/absent"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--plugin-root node_modules\/absent holds no plugin/);
  });
});
