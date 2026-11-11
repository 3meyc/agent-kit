import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KIT_GAP_LABEL, formatKitRepo, githubRepo, kitRepo, marketplaceOfPath } from "../shared/kit-repo.mjs";
import { main as sdlcKit } from "../plugins/sdlc/scripts/sdlc-kit.mjs";
import { main as sessionKitRepo } from "../plugins/session/scripts/kit-repo.mjs";

/** A Claude config folder and a project, with the given marketplaces, installs and settings. */
function fixture({ known = {}, installed = {}, settings = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kit-repo-"));
  const dir = join(base, "claude");
  const root = join(base, "project");
  mkdirSync(join(dir, "plugins"), { recursive: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(dir, "plugins", "known_marketplaces.json"), JSON.stringify(known));
  writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: installed }));
  if (settings) writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings));
  return { base, dir, root, done: () => rmSync(base, { recursive: true, force: true }) };
}

const KNOWN = {
  "base-kit": { source: { source: "github", repo: "owner/base-kit", ref: "stable" } },
  "overlay-kit": { source: { source: "git", url: "git@github.com:org/overlay-kit.git" } },
  "local-kit": { source: { source: "directory", path: "/somewhere" } },
};

test("githubRepo reads github, HTTPS and SSH sources and refuses the rest", () => {
  assert.equal(githubRepo({ source: "github", repo: "owner/kit" }), "owner/kit");
  assert.equal(githubRepo({ source: "git", url: "https://github.com/owner/kit.git" }), "owner/kit");
  assert.equal(githubRepo({ source: "url", url: "https://token@github.com/owner/kit" }), "owner/kit");
  assert.equal(githubRepo({ source: "git", url: "ssh://git@github.com/owner/kit.git" }), "owner/kit");
  assert.equal(githubRepo({ source: "git", url: "git@github.com:owner/kit.git" }), "owner/kit");
  assert.equal(githubRepo({ source: "git", url: "https://gitlab.com/owner/kit.git" }), null);
  assert.equal(githubRepo({ source: "directory", path: "/x" }), null);
  assert.equal(githubRepo({ source: "github", repo: "not a repo" }), null);
  assert.equal(githubRepo(null), null);
});

test("marketplaceOfPath tells the cache and marketplace folders from a project file", () => {
  const dir = "/home/me/.claude";
  assert.deepEqual(marketplaceOfPath(`${dir}/plugins/cache/base-kit/sdlc/abc123/references/workflow.md`, dir), {
    marketplace: "base-kit",
    plugin: "sdlc",
  });
  assert.deepEqual(marketplaceOfPath(`${dir}/plugins/marketplaces/base-kit/plugins/sdlc/x.md`, dir), {
    marketplace: "base-kit",
    plugin: null,
  });
  assert.equal(marketplaceOfPath("/work/my-app/docs/recipes/x.md", dir), null);
});

test("kitRepo resolves plugin@marketplace, a bare installed name and a cache path", () => {
  const f = fixture({ known: KNOWN, installed: { "sdlc@base-kit": [{}], "recipes@overlay-kit": [{}] } });
  try {
    assert.equal(kitRepo("sdlc@base-kit", f).repo, "owner/base-kit");
    const bare = kitRepo("recipes", f);
    assert.equal(bare.repo, "org/overlay-kit");
    assert.equal(bare.marketplace, "overlay-kit");
    assert.equal(bare.from, "known_marketplaces.json");
    const path = kitRepo(join(f.dir, "plugins", "cache", "overlay-kit", "recipes", "v1", "docs", "deploy.md"), f);
    assert.deepEqual([path.repo, path.plugin], ["org/overlay-kit", "recipes"]);
  } finally {
    f.done();
  }
});

test("kitRepo prefers the project's declared marketplace source over the machine's", () => {
  const f = fixture({
    known: KNOWN,
    settings: {
      extraKnownMarketplaces: { "base-kit": { source: { source: "github", repo: "fork/base-kit" } } },
      enabledPlugins: { "sdlc@base-kit": true, "off@base-kit": false },
    },
  });
  try {
    const r = kitRepo("sdlc", f);
    assert.deepEqual([r.repo, r.from], ["fork/base-kit", ".claude/settings.json"]);
    assert.equal(kitRepo("off", f).repo, null, "a plugin the project switched off is not resolved by bare name");
  } finally {
    f.done();
  }
});

test("kitRepo says why when there is no repository", () => {
  const f = fixture({ known: KNOWN, installed: { "dup@base-kit": [{}], "dup@overlay-kit": [{}], "x@local-kit": [{}] } });
  try {
    assert.match(kitRepo("", f).reason, /no plugin or path/);
    assert.match(kitRepo("missing", f).reason, /no enabled or installed plugin named missing/);
    assert.match(kitRepo("dup", f).reason, /several marketplaces \(base-kit, overlay-kit\)/);
    assert.match(kitRepo("x", f).reason, /not a GitHub repository/);
    assert.match(kitRepo("y@unknown", f).reason, /neither declared by the project nor registered/);
    assert.match(kitRepo(join(f.root, "docs", "recipes", "a.md"), f).reason, /a project file, not a kit file/);
  } finally {
    f.done();
  }
});

test("formatKitRepo names the repo, its origin and the label, or the reason", () => {
  assert.equal(
    formatKitRepo({ repo: "owner/kit", plugin: "sdlc", marketplace: "base-kit", from: "known_marketplaces.json" }),
    `owner/kit (sdlc@base-kit, from known_marketplaces.json; label ${KIT_GAP_LABEL})`,
  );
  assert.equal(formatKitRepo({ repo: null, plugin: "sdlc", marketplace: null, reason: "why" }), "kit-repo: sdlc: why");
});

test("sdlc-kit kit-repo and the session kit-repo command print it and exit 1 without one", () => {
  const f = fixture({ known: KNOWN, installed: { "sdlc@base-kit": [{}] } });
  try {
    const lines = [];
    const out = (line) => lines.push(line);
    assert.equal(sdlcKit(["kit-repo", "sdlc"], { root: f.root, out, configDir: f.dir }), 0);
    assert.match(lines.at(-1), /^owner\/base-kit \(sdlc@base-kit/);
    assert.equal(sdlcKit(["kit-repo", "nope", "--json"], { root: f.root, out, configDir: f.dir }), 1);
    assert.equal(JSON.parse(lines.at(-1)).repo, null);
    assert.equal(sessionKitRepo(["sdlc@base-kit", "--json"], { root: f.root, dir: f.dir, out }), 0);
    assert.equal(JSON.parse(lines.at(-1)).repo, "owner/base-kit");
    assert.equal(sessionKitRepo([], { root: f.root, dir: f.dir, out }), 1);
  } finally {
    f.done();
  }
});
