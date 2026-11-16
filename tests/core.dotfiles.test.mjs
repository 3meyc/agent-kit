// Tests for `kit dotfiles` (plugins/core/src/dotfiles.mjs): the manifest, the argument parser, the
// secret and machine-path scan, and init, apply and check against a home folder made in a temp dir.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { dotfilesDir, folderProblems, ignoreLines, mergeManifests, parseDotfilesArgs, pathState, readDotfilesManifest, runDotfiles, scanText } from "../plugins/core/src/dotfiles.mjs";

const scratch = mkdtempSync(join(tmpdir(), "agent-kit-dotfiles-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const manifest = readDotfilesManifest();

/** A home folder with settings, instructions, one own skill and the desktop app's synced skills. */
function makeHome(name) {
  const home = join(scratch, name);
  mkdirSync(join(home, ".claude", "skills", "mine"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills", "synced", "pdf"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), '{ "outputStyle": "Proactive" }\n');
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Mine\n");
  writeFileSync(join(home, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\n---\n");
  writeFileSync(join(home, ".claude", "skills", "synced", "pdf", "SKILL.md"), "app copy\n");
  return home;
}

function run(args, home) {
  const lines = [];
  const code = runDotfiles(args, { home, env: {}, print: (line) => lines.push(line) });
  return { code, out: lines.join("\n") };
}

describe("dotfiles.json", () => {
  it("keeps every portable path under one base name and never carries secrets or installs", () => {
    const names = manifest.portable.map((item) => item.path.split("/").at(-1));
    assert.equal(new Set(names).size, names.length);
    for (const item of manifest.portable) assert.ok(item.what, item.path);
    assert.deepEqual(ignoreLines(manifest), ["skills/synced/"]);
    const never = manifest.neverSync.map((item) => item.path);
    for (const path of ["~/.claude/.credentials.json", "~/.claude.json", "~/.claude/plugins"]) assert.ok(never.includes(path), path);
  });
});

describe("kit dotfiles arguments", () => {
  it("takes an action and its options, and refuses the rest", () => {
    assert.deepEqual(parseDotfilesArgs(["apply", "--dir", "~/dots", "--copy", "--dry-run"]), { action: "apply", dir: "~/dots", dryRun: true, copy: true });
    assert.equal(parseDotfilesArgs(["--help"]).help, true);
    assert.match(parseDotfilesArgs([]).error ?? "", /name an action/);
    assert.match(parseDotfilesArgs(["push"]).error ?? "", /unknown action/);
    assert.match(parseDotfilesArgs(["init", "--dir"]).error ?? "", /--dir needs/);
    assert.match(parseDotfilesArgs(["init", "--all"]).error ?? "", /unknown option/);
  });

  it("finds the folder in KIT_DOTFILES, else ~/.claude-dotfiles", () => {
    assert.equal(dotfilesDir({}, "/h"), join("/h", ".claude-dotfiles"));
    assert.equal(dotfilesDir({ KIT_DOTFILES: "/elsewhere" }, "/h"), "/elsewhere");
  });
});

describe("the secret and machine-path scan", () => {
  it("flags tokens, secret values and machine paths by line, and leaves prose about them alone", () => {
    const text = [
      '{ "env": { "GH_TOKEN": "ghp_abcdefghijklmnopqrstuvwxyz0123" },',
      '  "apiKey": "not-a-real-key-123",',
      '  "data": "/Users/someone/data",',
      "Compress output to save tokens; a CI secret is referenced by name only.",
    ].join("\n");
    assert.deepEqual(scanText(text), [
      { line: 1, kind: "token" },
      { line: 2, kind: "secret value" },
      { line: 3, kind: "machine path" },
    ]);
    assert.deepEqual(scanText("C:\\Users\\someone\\data"), [{ line: 1, kind: "machine path" }]);
  });
});

describe("kit dotfiles init, apply and check", () => {
  it("seeds the folder from this machine, leaving the app's synced skills out and ignored", () => {
    const home = makeHome("seed");
    const dir = join(home, ".claude-dotfiles");
    const dry = run(["init", "--dry-run"], home);
    assert.equal(dry.code, 0);
    assert.equal(existsSync(dir), false);
    const { code, out } = run(["init"], home);
    assert.equal(code, 0, out);
    assert.ok(existsSync(join(dir, "settings.json")));
    assert.ok(existsSync(join(dir, "skills", "mine", "SKILL.md")));
    assert.equal(existsSync(join(dir, "skills", "synced")), false);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "skills/synced/\n");
    assert.match(out, /leave ~\/\.claude\/skills\/synced/);
    assert.match(out, /gh repo create <you>\/claude-dotfiles --private/);
    assert.match(run(["init"], home).out, /already in the folder/);
    assert.equal(pathState(manifest.portable.find((item) => item.path === "~/.claude/skills"), dir, home), "copy");
    writeFileSync(join(home, ".claude", "skills", "mine", "SKILL.md"), "changed\n");
    assert.equal(pathState(manifest.portable.find((item) => item.path === "~/.claude/skills"), dir, home), "differs");
  });

  it("fails init and check on a token in the folder, and warns on a machine path", () => {
    const home = makeHome("secret");
    writeFileSync(join(home, ".claude", "settings.json"), '{ "env": { "DATA": "/home/someone/data", "T": "ghp_abcdefghijklmnopqrstuvwxyz0123" } }\n');
    const init = run(["init"], home);
    assert.equal(init.code, 1);
    assert.match(init.out, /FAIL {2}settings\.json:1: token/);
    assert.match(init.out, /warn {2}settings\.json:1: machine path/);
    assert.doesNotMatch(init.out, /ghp_/);
    assert.equal(run(["check"], home).code, 1);
  });

  it("links the folder onto another machine, keeping the files it replaces, then checks clean", () => {
    const first = makeHome("first");
    run(["init"], first);
    const second = makeHome("second");
    writeFileSync(join(second, ".claude", "CLAUDE.md"), "# Other machine\n");
    const dir = join(first, ".claude-dotfiles");
    const { code, out } = run(["apply", "--dir", dir], second);
    assert.equal(code, 0, out);
    const claudeMd = join(second, ".claude", "CLAUDE.md");
    if (lstatSync(claudeMd).isSymbolicLink()) assert.match(out, /link {2}~\/\.claude\/CLAUDE\.md/);
    assert.equal(readFileSync(claudeMd, "utf8"), "# Mine\n");
    assert.ok(readdirSync(join(second, ".claude")).some((name) => name.startsWith("CLAUDE.md.backup-")));
    assert.match(run(["apply", "--dir", dir], second).out, /already linked|plan|copy/);
    const checked = run(["check", "--dir", dir], second);
    assert.equal(checked.code, 0, checked.out);
    assert.equal(pathState(manifest.portable[1], dir, second) === "linked" || pathState(manifest.portable[1], dir, second) === "copy", true);
  });

  it("fails check when a never-sync file is in the folder, and apply when there is no folder", () => {
    const home = makeHome("never");
    run(["init"], home);
    writeFileSync(join(home, ".claude-dotfiles", ".credentials.json"), "{}\n");
    const checked = run(["check"], home);
    assert.equal(checked.code, 1);
    assert.match(checked.out, /FAIL {2}\.credentials\.json is in the folder/);
    assert.equal(run(["apply", "--dir", join(home, "missing")], home).code, 1);
  });
});

describe("kit dotfiles under an overlay kit", () => {
  it("merges the overlay's paths over the kit's: same path replaced in place, new ones last", () => {
    const merged = mergeManifests(manifest, {
      portable: [{ path: "~/.claude/CLAUDE.md", what: "overlay says" }, { path: "~/.config/overlay/list.txt", what: "overlay list" }],
      neverSync: [{ path: "~/.fallow", why: "caches" }],
    });
    assert.equal(merged.portable.length, manifest.portable.length + 1);
    assert.equal(merged.portable[1].what, "overlay says");
    assert.equal(merged.portable.at(-1).path, "~/.config/overlay/list.txt");
    assert.equal(merged.neverSync.at(-1).path, "~/.fallow");
    assert.deepEqual(mergeManifests(manifest, {}), { portable: manifest.portable, neverSync: manifest.neverSync });
  });

  it("uses the caller's folder and command names, and reports the folder's problems", () => {
    const home = makeHome("overlay");
    const dir = join(home, ".overlay-dotfiles");
    const lines = [];
    const names = { init: "overlay-tools bootstrap --init", apply: "overlay-tools bootstrap", repo: "overlay-dotfiles" };
    const code = runDotfiles(["init"], { home, env: {}, dir, names, print: (line) => lines.push(line) });
    assert.equal(code, 0);
    const out = lines.join("\n");
    assert.match(out, /^overlay-tools bootstrap --init · /);
    assert.match(out, /gh repo create <you>\/overlay-dotfiles --private/);
    assert.match(out, /Then, on this machine and each other one: overlay-tools bootstrap \(/);
    assert.ok(existsSync(join(dir, "settings.json")));
    writeFileSync(join(dir, ".claude.json"), "{}\n");
    const problems = folderProblems(manifest, dir);
    assert.deepEqual(problems.neverSync.map((item) => item.path), ["~/.claude.json"]);
    assert.deepEqual(problems.findings, []);
  });
});
