// Tests for `kit tools` (plugins/core/src/tools.mjs): the pure planning, matching and clean-up
// helpers, the session-start note and its cache, and the command's paths that install nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  cachedToolsNote,
  compareVersions,
  findOnPath,
  leftoverFiles,
  parseChecksums,
  parseToolsArgs,
  planTools,
  readTools,
  releaseAsset,
  runTools,
  shadowedVerdict,
  staleCopies,
  toolsCacheFile,
  toolsNote,
  uninstallCommand,
  uninstallHint,
  withHookWarningOff,
} from "../plugins/core/src/tools.mjs";

const scratch = mkdtempSync(join(tmpdir(), "agent-kit-tools-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const tools = readTools();

describe("tools.json", () => {
  it("pins every tool and gives it a way in on the three desktop OSes", () => {
    for (const [name, spec] of Object.entries(tools)) {
      assert.match(spec.pin, /^\d+\.\d+\.\d+$/, name);
      assert.ok(spec.why, name);
      for (const target of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]) {
        assert.ok(releaseAsset(spec, ...target.split("-")) || spec.install, `${name} on ${target}`);
      }
      if (spec.install) assert.ok(spec.package, `${name} names its package, for the clean-up`);
    }
  });
});

describe("rtk hook warning setting", () => {
  it("adds a [hooks] table to an empty or table-less config", () => {
    assert.equal(withHookWarningOff(""), "[hooks]\nsuppress_hook_warning = true\n");
    assert.equal(
      withHookWarningOff("[tracking]\nenabled = true"),
      "[tracking]\nenabled = true\n\n[hooks]\nsuppress_hook_warning = true\n",
    );
  });

  it("sets the key inside an existing [hooks] table, and only there", () => {
    assert.equal(
      withHookWarningOff("[hooks]\nother = 1\n\n[tracking]\nsuppress_hook_warning = false\n"),
      "[hooks]\nsuppress_hook_warning = true\nother = 1\n\n[tracking]\nsuppress_hook_warning = false\n",
    );
    assert.equal(
      withHookWarningOff("[tracking]\nenabled = true\n[hooks]\nsuppress_hook_warning = false # was noisy\n"),
      "[tracking]\nenabled = true\n[hooks]\nsuppress_hook_warning = true\n",
    );
  });

  it("leaves a config that already says so alone, and keeps CRLF line ends", () => {
    assert.equal(withHookWarningOff("[hooks]\nsuppress_hook_warning = true\n"), null);
    assert.equal(withHookWarningOff("[ hooks ]\n  suppress_hook_warning=true  # set by hand\n"), null);
    assert.equal(withHookWarningOff("[hooks]\r\nx = 1\r\n"), "[hooks]\r\nsuppress_hook_warning = true\r\nx = 1\r\n");
  });
});

describe("kit tools helpers", () => {
  const rtk = tools.rtk;
  const fallow = { pin: "3.36.0", command: ["fallow", "--version"], why: "", package: "fallow" };

  it("compares dotted versions numerically", () => {
    assert.equal(compareVersions("1.6", "1.6.0"), 0);
    assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  });

  it("builds the release URL and binary name per OS, and none without an asset", () => {
    const win = releaseAsset(rtk, "win32", "x64");
    assert.equal(win?.url, "https://github.com/rtk-ai/rtk/releases/download/v1.1.0/rtk-x86_64-pc-windows-msvc.zip");
    assert.equal(win?.checksumsUrl, "https://github.com/rtk-ai/rtk/releases/download/v1.1.0/checksums.txt");
    assert.equal(win?.binary, "rtk.exe");
    assert.equal(releaseAsset(rtk, "darwin", "arm64")?.binary, "rtk");
    assert.equal(releaseAsset(rtk, "win32", "arm64"), null);
    assert.equal(releaseAsset(fallow, "linux", "x64"), null);
  });

  it("reads a checksums file by asset name", () => {
    const sum = "a".repeat(64);
    assert.equal(parseChecksums(`${sum}  rtk.zip\n${"b".repeat(64)} *other.tar.gz\n`).get("rtk.zip"), sum);
  });

  it("lists PATH copies in shell order, PATHEXT first on Windows", () => {
    const files = new Set(["C:\\a\\fallow.CMD", "C:\\a\\fallow", "C:\\b\\fallow.EXE"]);
    const found = findOnPath("fallow", { platform: "win32", pathValue: "C:\\a;C:\\A;C:\\b", pathExt: ".EXE;.CMD", exists: (f) => files.has(f) });
    assert.deepEqual(found, ["C:\\a\\fallow.CMD", "C:\\b\\fallow.EXE"]);
    assert.deepEqual(findOnPath("rtk", { platform: "linux", pathValue: "/x:/y", exists: (f) => f === "/y/rtk" }), ["/y/rtk"]);
  });

  it("names the package command that removes a copy, and none for a plain file", () => {
    assert.deepEqual(uninstallCommand("C:/Users/me/AppData/Local/pnpm/fallow.CMD", "fallow", fallow), { command: "pnpm remove -g fallow", fromHome: true });
    assert.equal(uninstallCommand("/usr/local/lib/node_modules/.bin/fallow", "fallow", fallow)?.command, "npm uninstall -g fallow");
    assert.equal(uninstallCommand("/opt/homebrew/bin/rtk", "rtk", rtk)?.command, "brew uninstall rtk");
    assert.equal(uninstallCommand("/home/me/.local/bin/rtk", "rtk", rtk), null);
    assert.equal(uninstallHint("/home/me/.local/bin/rtk", "rtk", rtk), "delete /home/me/.local/bin/rtk");
    assert.equal(uninstallHint("/x/pnpm/fallow", "fallow", fallow), "pnpm remove -g fallow (run it from your home folder)");
  });

  it("finds stale copies only once a pinned copy is on PATH, and a shadowing one", () => {
    const old = { path: "/pnpm/fallow", version: "3.10.0" };
    const good = { path: "/npm/fallow", version: "3.36.0" };
    assert.deepEqual(staleCopies(fallow, [old, good]), [old]);
    assert.deepEqual(staleCopies(fallow, [old]), []);
    assert.match(shadowedVerdict("fallow", fallow, [old, good])?.message ?? "", /comes first on PATH and hides/);
    assert.equal(shadowedVerdict("fallow", fallow, [good, old]), null);
  });

  it("finds what a swap or a hand backup left beside a binary, and nothing else", () => {
    const names = ["rtk.exe", "rtk.exe.old", "rtk.exe.1700000000000.old", "rtk-0.50.0.exe.bak", "RTK.EXE.0.43.0.BAK", "rtkx.old", "other.old"];
    assert.deepEqual(leftoverFiles(names, "rtk"), ["rtk.exe.old", "rtk.exe.1700000000000.old", "rtk-0.50.0.exe.bak", "RTK.EXE.0.43.0.BAK"]);
  });

  it("plans keep, release, install and manual steps from the probes", () => {
    const set = { rtk, fallow, other: { pin: "1.0.0", command: ["other"], why: "", manual: "get other {pin}" } };
    const probe = (command) => (command[0] === "fallow" ? { found: true, version: "3.36.0" } : { found: false, version: null });
    const steps = planTools(set, probe, "darwin", "arm64");
    assert.deepEqual(steps.map((s) => [s.name, s.action, s.now, s.pin]), [["rtk", "release", "missing", "1.1.0"], ["fallow", "keep", "3.36.0", "3.36.0"], ["other", "manual", "missing", "1.0.0"]]);
    assert.match(steps[2].detail, /get other 1\.0\.0/);
  });

  it("parses its options and refuses unknown ones", () => {
    assert.deepEqual(parseToolsArgs(["--yes", "--only", "rtk, codegraph", "--index"]), { yes: true, check: false, dryRun: false, index: true, only: ["rtk", "codegraph"] });
    assert.equal(parseToolsArgs(["--no-index"]).index, false);
    assert.match(parseToolsArgs(["--only"]).error ?? "", /--only needs/);
    assert.match(parseToolsArgs(["--all"]).error ?? "", /unknown option/);
    assert.equal(parseToolsArgs(["--yes", "-h"]).help, true);
  });

  it("prints its usage for --help and installs nothing", async () => {
    const lines = [];
    const code = await runTools(["--help"], { tools: {}, print: (line) => lines.push(line) });
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /^Usage: kit tools/);
  });
});

describe("kit tools session note", () => {
  const steps = [
    { name: "rtk", action: "release", now: "missing", pin: "1.1.0", detail: "" },
    { name: "fallow", action: "install", now: "3.10.0", pin: "3.36.0", detail: "" },
    { name: "codegraph", action: "keep", now: "1.6.2", pin: "1.6.2", detail: "" },
  ];

  it("names each tool off its pin and offers the skill, and says nothing when all are at it", () => {
    const note = toolsNote(steps);
    assert.match(note, /rtk \(missing\), fallow \(3\.10\.0, pin 3\.36\.0\)/);
    assert.match(note, /\/core:kit-tools/);
    assert.doesNotMatch(note, /codegraph/);
    assert.equal(toolsNote([steps[2]]), "");
  });

  it("probes at most once a day, and again when a pin moves", () => {
    const cacheFile = join(scratch, "data", "tools-check.json");
    let probes = 0;
    const probe = () => (probes++, { found: false, version: null });
    const set = { fallow: { pin: "3.36.0", command: ["fallow"], why: "", install: "npm i -g fallow@{pin}", package: "fallow" } };
    const first = cachedToolsNote({ cacheFile, tools: set, probe, now: 1_000 });
    assert.match(first, /fallow \(missing\)/);
    assert.equal(cachedToolsNote({ cacheFile, tools: set, probe, now: 2_000 }), first);
    assert.equal(probes, 1);
    cachedToolsNote({ cacheFile, tools: set, probe, now: 1_000 + 25 * 60 * 60 * 1000 });
    assert.equal(probes, 2);
    cachedToolsNote({ cacheFile, tools: { fallow: { ...set.fallow, pin: "3.37.0" } }, probe, now: 1_000 + 25 * 60 * 60 * 1000 });
    assert.equal(probes, 3);
    assert.equal(toolsCacheFile(null), null);
    assert.equal(toolsCacheFile(join("d", "update-check.json")), join("d", "tools-check.json"));
  });
});

describe("kit tools command", () => {
  const lines = [];
  const print = (line) => lines.push(line);
  const absent = { ghost: { pin: "9.9.9", command: ["agent-kit-no-such-tool-xyz", "--version"], why: "test", install: "echo never-run {pin}", package: "ghost" } };

  it("only reports with --check, and refuses an unknown tool or option", async () => {
    lines.length = 0;
    assert.equal(await runTools(["--check"], { tools: absent, print }), 0);
    assert.deepEqual(lines, ["kit tools: ghost missing -> 9.9.9", "kit tools: run `kit tools` to install the pinned versions"]);
    assert.equal(await runTools(["--only", "nope"], { tools: absent, print }), 1);
    assert.equal(await runTools(["--bogus"], { tools: absent, print }), 1);
  });

  it("prints the plan and the command to run when there is no terminal to ask on", async () => {
    lines.length = 0;
    assert.equal(await runTools(["--only", "ghost"], { tools: absent, print, interactive: false, root: null }), 0);
    assert.match(lines.join("\n"), /install ghost — missing -> 9\.9\.9: echo never-run 9\.9\.9/);
    assert.match(lines.at(-1) ?? "", /No terminal to ask on: run `kit tools --yes` \(or `--only ghost --yes`\)/);
  });

  it("skips a tool the user declines", async () => {
    lines.length = 0;
    const asked = [];
    const ask = async (question) => (asked.push(question), false);
    assert.equal(await runTools(["--only", "ghost", "--no-index"], { tools: absent, print, interactive: true, ask, root: null }), 0);
    assert.deepEqual(asked, ["Install ghost 9.9.9? (test)"]);
    assert.ok(lines.includes("  skip    ghost"));
  });
});

describe("kit tools unpacking", () => {
  it("uses the system bsdtar on Windows, where Git Bash's GNU tar misreads C:\ paths", async () => {
    const { tarCommand } = await import("../plugins/core/src/tools.mjs");
    assert.equal(tarCommand("win32", { SystemRoot: "C:\Windows" }, () => true), join("C:\Windows", "System32", "tar.exe"));
    assert.equal(tarCommand("win32", { SystemRoot: "C:\Windows" }, () => false), "tar");
    assert.equal(tarCommand("darwin", {}, () => true), "tar");
  });
});
