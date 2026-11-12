// `kit fleet --source github`: repos and kits read through a mocked GitHub API.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { blobId, loadFleetList, lockPins, measureFleetDrift, parseFleetArgs, parseRepoSpec, runFleet } from "../plugins/core/src/fleet.mjs";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-kit-fleet-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sha = (char) => char.repeat(40);
const BASE = "3meyc/agent-kit";
const OVERLAY = "my-org/my-overlay";

/** A GitHub-style tarball: every file under one top folder. */
function tarball(name, files) {
  const dir = join(scratch, "src", name);
  const top = join(dir, `${name.replace(/\W/g, "-")}-top`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(top, rel)), { recursive: true });
    writeFileSync(join(top, rel), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  execFileSync("tar", ["-czf", "out.tar.gz", `${name.replace(/\W/g, "-")}-top`], { cwd: dir });
  return readFileSync(join(dir, "out.tar.gz"));
}

const plugin = (name, extra = {}) => ({
  [`plugins/${name}/.claude-plugin/plugin.json`]: { name },
  ...extra,
});

const baseKit = tarball("base-kit", {
  ".claude-plugin/marketplace.json": { name: "agent-kit", plugins: [{ name: "core", source: "./plugins/core" }] },
  ...plugin("core", {
    "plugins/core/kit-owned.json": { files: [".claude/rules/agent-output-rules.md", "scripts/count-lines.mjs"] },
    "plugins/core/skills/check/SKILL.md": "---\nname: check\n---\nRun checks.\n",
  }),
});
const overlayKit = tarball("overlay-kit", {
  ".claude-plugin/marketplace.json": { name: "my-overlay", plugins: [{ name: "extra", source: "./plugins/extra" }] },
  ...plugin("extra", { "plugins/extra/kit-owned.json": { files: [".claude/rules/extra-rules.md"] } }),
});

const settings = (overlayRef = "stable") => ({
  extraKnownMarketplaces: {
    "agent-kit": { source: { source: "github", repo: BASE, ref: "stable" } },
    "my-overlay": { source: { source: "github", repo: OVERLAY, ref: overlayRef } },
  },
  enabledPlugins: { "core@agent-kit": true, "extra@my-overlay": true },
});

const shared = "export const shared = 1;\n";
const repoA = tarball("repo-a", {
  ".claude/settings.json": settings("v1"),
  "CLAUDE.md": "# app\n",
  ".claude/rules/agent-output-rules.md": "copied rule\n",
  "scripts/shared.mjs": shared,
  "scripts/count-lines.test.mjs": "import '../scripts/count-lines.mjs';\n",
  "package-lock.json": JSON.stringify({ packages: { "node_modules/agent-kit": { resolved: `git+ssh://git@github.com/${BASE}.git#${sha("1")}` } } }),
});
const repoB = tarball("repo-b", {
  ".claude/settings.json": settings(),
  "CLAUDE.md": "# api, different by design\n",
  "scripts/shared.mjs": `${shared}// changed\n`,
  "pnpm-lock.yaml": `  agent-kit@https://codeload.github.com/${BASE}/tar.gz/${sha("b")}:\n    resolution: {commit: ${sha("c")}, repo: https://github.com/${OVERLAY}.git, type: git}\n`,
});
const repoClean = tarball("repo-clean", {
  ".claude/settings.json": settings(),
  "scripts/shared.mjs": shared,
  "pnpm-lock.yaml": `version: https://codeload.github.com/${BASE}/tar.gz/${sha("b")}\n`,
});

/** A fetch that answers the GitHub API calls the fleet makes; 404 for anything else. */
function mockFetch({ repos = {}, seen = [] } = {}) {
  const commits = {
    [`${BASE}/stable`]: sha("b"),
    [`${OVERLAY}/stable`]: sha("c"),
    ...Object.fromEntries(Object.entries(repos).map(([repo, entry]) => [`${repo}/${entry.branch}`, entry.sha])),
  };
  const archives = { [`${BASE}/${sha("b")}`]: baseKit, [`${OVERLAY}/${sha("c")}`]: overlayKit, ...Object.fromEntries(Object.entries(repos).map(([repo, entry]) => [`${repo}/${entry.sha}`, entry.archive])) };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return async (url, init) => {
    seen.push({ url, auth: init?.headers?.Authorization });
    const path = new URL(url).pathname;
    let match = path.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/(.+)$/);
    if (match && commits[`${match[1]}/${decodeURIComponent(match[2])}`]) {
      return json({ sha: commits[`${match[1]}/${decodeURIComponent(match[2])}`], commit: { committer: { date: "2026-11-01T10:00:00Z" } } });
    }
    match = path.match(/^\/repos\/([^/]+\/[^/]+)\/tarball\/([0-9a-f]{40})$/);
    if (match && archives[`${match[1]}/${match[2]}`]) return new Response(archives[`${match[1]}/${match[2]}`]);
    match = path.match(/^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/);
    if (match) return json({ status: "ahead", ahead_by: 3 });
    match = path.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (match && repos[match[1]]) return json({ default_branch: repos[match[1]].branch });
    return json({ message: "Not Found" }, 404);
  };
}

const listFile = (name, body) => {
  const file = join(scratch, `${name}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
};

async function run(args, fetchImpl, env = { GH_TOKEN: "test-token" }) {
  let out = "";
  const code = await runFleet(args, { env, fetchImpl, print: (text) => (out += text), now: new Date("2026-11-12T00:00:00Z") });
  return { code, out };
}

describe("fleet list", () => {
  it("reads repos as an object or array, adds --repo and --kit, and always keeps the base kit", () => {
    const file = listFile("list-object", { repos: { app: "my-org/my-app", api: { repo: "my-org/my-api", branch: "dev" } }, kits: [{ repo: OVERLAY }], ignoreDrift: ["scripts/x.mjs"] });
    const list = loadFleetList({ list: file, repos: ["web=my-org/my-web#main", "my-org/solo"], kits: [`${BASE}#next`] });
    assert.deepEqual(list.repos, [
      { name: "app", repo: "my-org/my-app", branch: null },
      { name: "api", repo: "my-org/my-api", branch: "dev" },
      { name: "web", repo: "my-org/my-web", branch: "main" },
      { name: "solo", repo: "my-org/solo", branch: null },
    ]);
    assert.deepEqual(list.kits, [
      { repo: BASE, ref: "next" },
      { repo: OVERLAY, ref: "stable" },
    ]);
    assert.deepEqual(list.ignoreDrift, ["scripts/x.mjs"]);
    const array = loadFleetList({ list: listFile("list-array", { repos: ["my-org/a#dev", { name: "bee", repo: "my-org/b" }] }) });
    assert.deepEqual(array.repos.map((repo) => `${repo.name}:${repo.branch}`), ["a:dev", "bee:null"]);
  });

  it("refuses a missing list, an empty list, a bad entry and a name listed twice", () => {
    assert.match(loadFleetList({ list: join(scratch, "nope.json") }).error, /no repo list/);
    assert.match(loadFleetList({ list: listFile("empty", { repos: {} }) }).error, /no repos to check/);
    assert.match(loadFleetList({ list: listFile("bad", { repos: { app: "not a repo" } }) }).error, /repo app/);
    assert.match(loadFleetList({ list: null, repos: ["x=my-org/a", "x=my-org/b"] }).error, /listed twice/);
    assert.deepEqual(parseRepoSpec("my-org/my-app.git#feat/a-b"), { repo: "my-org/my-app", ref: "feat/a-b" });
  });

  it("parses the arguments and rejects other sources and unknown flags", () => {
    const options = parseFleetArgs(["--source", "github", "--repo", "a/b", "--kit=c/d#stable", "--json"]);
    assert.deepEqual([options.repos, options.kits, options.json, options.errors], [["a/b"], ["c/d#stable"], true, []]);
    assert.match(parseFleetArgs(["--source", "local"]).errors[0], /not supported/);
    assert.match(parseFleetArgs(["--bogus"]).errors[0], /unknown argument/);
    assert.match(parseFleetArgs(["--list"]).errors[0], /needs a value/);
  });
});

describe("fleet pieces", () => {
  it("finds kit pins in npm, pnpm and yarn lockfiles", () => {
    assert.deepEqual(lockPins(`"resolved": "git+ssh://git@github.com/${BASE}.git#${sha("1")}"`, BASE), [sha("1")]);
    assert.deepEqual(lockPins(`version: https://codeload.github.com/${BASE}/tar.gz/${sha("2")}`, BASE), [sha("2")]);
    assert.deepEqual(lockPins(`resolution: {commit: ${sha("3")}, repo: https://github.com/${OVERLAY}.git, type: git}`, OVERLAY), [sha("3")]);
    assert.deepEqual(lockPins(`"agent-kit@github:${BASE}#${sha("4")}"`, BASE), [sha("4")]);
    assert.deepEqual(lockPins(`github.com/${OVERLAY}.git#${sha("5")}`, BASE), []);
  });

  it("computes git blob ids", () => {
    // `git hash-object` of an empty file and of "hello\n".
    assert.equal(blobId(Buffer.from("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    assert.equal(blobId(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("measures drift per group, leaving out per-project files and ignored paths", () => {
    const rows = measureFleetDrift(
      [
        { name: "a", files: { "CLAUDE.md": "1", ".claude/skills/x/SKILL.md": "1", ".claude/skills/x/ref.md": "2", "scripts/y.mjs": "1", "scripts/z.mjs": "1" } },
        { name: "b", files: { "CLAUDE.md": "2", ".claude/skills/x/SKILL.md": "1", ".claude/skills/x/ref.md": "3", "scripts/y.mjs": "1", "scripts/z.mjs": "9" } },
        { name: "c", files: { "scripts/only.mjs": "1" } },
      ],
      ["scripts/z.mjs"],
    );
    assert.deepEqual(rows.map((row) => `${row.group}:${row.status}`), ["scripts/y.mjs:same", "skill:x:drift(2)"]);
  });
});

describe("kit fleet --source github", () => {
  it("reports copies, an off-channel marketplace, pins behind stable and drift, and exits 1", async () => {
    const seen = [];
    const fetchImpl = mockFetch({
      seen,
      repos: { "my-org/repo-a": { branch: "main", sha: sha("a"), archive: repoA }, "my-org/repo-b": { branch: "dev", sha: sha("d"), archive: repoB } },
    });
    const file = listFile("fleet", { repos: { app: "my-org/repo-a", api: { repo: "my-org/repo-b", branch: "dev" } }, kits: [OVERLAY] });
    const out = join(scratch, "out");
    const { code, out: text } = await run(["--source", "github", "--list", file, "--out", out], fetchImpl);
    assert.equal(code, 1);
    assert.ok(seen.every((call) => call.auth === "Bearer test-token"));
    const report = JSON.parse(readFileSync(join(out, "fleet.json"), "utf8"));
    assert.deepEqual(report.kits.map((kit) => [kit.name, kit.sha, kit.plugins.map((p) => p.name)]), [
      ["agent-kit", sha("b"), ["core"]],
      ["my-overlay", sha("c"), ["extra"]],
    ]);
    const app = report.repos.find((repo) => repo.name === "app");
    assert.equal(app.branch, "main");
    assert.deepEqual(app.copies.map((copy) => copy.path).sort(), [".claude/rules/agent-output-rules.md", "scripts/count-lines.test.mjs"]);
    assert.deepEqual(app.pins, [{ kit: "agent-kit", file: "package-lock.json", sha: sha("1"), state: "behind", behind: 3 }]);
    const api = report.repos.find((repo) => repo.name === "api");
    assert.deepEqual(api.pins.map((pin) => `${pin.kit}:${pin.state}`), ["agent-kit:current", "my-overlay:current"]);
    const kinds = report.findings.map((finding) => `${finding.kind}:${finding.repo}`);
    assert.deepEqual(kinds, ["copy:app", "copy:app", "marketplace:app", "pin:app", "drift:app, api"]);
    assert.match(report.findings[2].text, /my-overlay declared at ref v1, not stable/);
    assert.match(report.findings[3].text, /3 commits behind stable/);
    assert.equal(readFileSync(join(out, "fleet.md"), "utf8"), text);
    assert.match(text, /\| F1 \| copy \| app \|/);
    assert.match(text, /\| D1 \| scripts\/shared\.mjs \| drift\(2\) \|/);
    assert.doesNotMatch(text, /CLAUDE\.md/);
  });

  it("exits 0 with no findings for repos on the channel with the same shared files", async () => {
    const fetchImpl = mockFetch({ repos: { "my-org/one": { branch: "main", sha: sha("e"), archive: repoClean }, "my-org/two": { branch: "main", sha: sha("f"), archive: repoClean } } });
    const { code, out } = await run(["--source", "github", "--repo", "my-org/one", "--repo", "my-org/two", "--kit", OVERLAY, "--json"], fetchImpl);
    const report = JSON.parse(out);
    assert.equal(code, 0);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.drift, [{ group: "scripts/shared.mjs", status: "same", by: report.drift[0].by }]);
  });

  it("reports a repo the token cannot read as a finding", async () => {
    const fetchImpl = mockFetch({ repos: { "my-org/one": { branch: "main", sha: sha("e"), archive: repoClean } } });
    const { code, out } = await run(["--repo", "my-org/one", "--repo", "my-org/hidden"], fetchImpl);
    assert.equal(code, 1);
    assert.match(out, /\| F1 \| unreadable \| hidden \| my-org\/hidden: GET \/repos\/my-org\/hidden: not found, or the token cannot read it \|/);
  });

  it("reads each owner's repos with that owner's token from KIT_FLEET_TOKENS", async () => {
    const seen = [];
    const fetchImpl = mockFetch({ seen, repos: { "my-org/one": { branch: "main", sha: sha("e"), archive: repoClean }, "Other-Org/two": { branch: "main", sha: sha("f"), archive: repoClean } } });
    const { code } = await run(["--repo", "my-org/one", "--repo", "Other-Org/two"], fetchImpl, { KIT_FLEET_TOKEN: "default", KIT_FLEET_TOKENS: "other-org=other\nunused=x" });
    assert.equal(code, 0);
    const auth = (part) => new Set(seen.filter((call) => call.url.includes(part)).map((call) => call.auth));
    assert.deepEqual([...auth("/Other-Org/two")], ["Bearer other"]);
    assert.deepEqual([...auth("/my-org/one")], ["Bearer default"]);
    assert.deepEqual([...auth(`/${BASE}/`)], ["Bearer default"]);
  });

  it("names the owner it has no token for", async () => {
    const fetchImpl = mockFetch({ repos: { "my-org/one": { branch: "main", sha: sha("e"), archive: repoClean } } });
    const { code, out } = await run(["--repo", "my-org/one"], fetchImpl, { KIT_FLEET_TOKENS: "my-org=t" });
    assert.equal(code, 1);
    assert.match(out, /no token for 3meyc/);
  });

  it("exits 2 without a token or a list", async () => {
    assert.equal((await run(["--repo", "my-org/one"], mockFetch(), {})).code, 2);
    assert.equal((await run([], mockFetch())).code, 2);
  });
});
