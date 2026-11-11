// GENERATED from shared/kit-repo.mjs by scripts/vendor-shared.mjs. Edit shared/kit-repo.mjs and run `npm run vendor`.
// Which GitHub repository a kit plugin comes from, so a gap found while using it can be opened as
// an issue there (docs/changing.md, Reporting a gap). The repository is the plugin's marketplace
// source: the one the project declares in `.claude/settings.json` `extraKnownMarketplaces` when it
// declares one, else the one this machine registered (`known_marketplaces.json`). Node built-ins
// only; never throws.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/** The label a kit gap carries in the kit's repository. */
export const KIT_GAP_LABEL = "kit-gap";

/** Claude Code's config folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
function configDir() {
  return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * `owner/repo` of a marketplace source, or null when it is not on GitHub. A `github` source names
 * it; a `git` or `url` source names it when its URL is a github.com one (HTTPS or SSH).
 * @param {any} source
 */
export function githubRepo(source) {
  if (!source || typeof source !== "object") return null;
  if (source.source === "github" && typeof source.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(source.repo)) {
    return source.repo.replace(/\.git$/, "");
  }
  if ((source.source === "git" || source.source === "url") && typeof source.url === "string") {
    const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(source.url);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

/**
 * The marketplace a path under Claude Code's plugin folders belongs to:
 * `<config>/plugins/cache/<marketplace>/<plugin>/…` or `<config>/plugins/marketplaces/<marketplace>/…`.
 * @param {string} path @param {string} dir
 */
export function marketplaceOfPath(path, dir) {
  const rel = relative(join(dir, "plugins"), resolve(path));
  const parts = rel.split(sep);
  if (parts[0] === "cache" && parts.length >= 3) return { marketplace: parts[1], plugin: parts[2] };
  if (parts[0] === "marketplaces" && parts.length >= 2) return { marketplace: parts[1], plugin: null };
  return null;
}

/**
 * The marketplaces a bare plugin name may come from: the project's `enabledPlugins`, then this
 * machine's installs, each `name@marketplace`.
 * @param {string} plugin @param {string | null} root @param {string} dir
 */
function marketplacesOf(plugin, root, dir) {
  const keys = [];
  const enabled = root ? readJson(join(root, ".claude", "settings.json"))?.enabledPlugins : null;
  if (enabled && typeof enabled === "object") keys.push(...Object.keys(enabled).filter((key) => enabled[key]));
  const installed = readJson(join(dir, "plugins", "installed_plugins.json"))?.plugins;
  if (installed && typeof installed === "object") keys.push(...Object.keys(installed));
  const found = new Set();
  for (const key of keys) {
    const at = key.lastIndexOf("@");
    if (at > 0 && key.slice(0, at) === plugin) found.add(key.slice(at + 1));
  }
  return [...found];
}

/**
 * The GitHub repository to open a kit gap in.
 * `target` is `plugin@marketplace`, a bare plugin name, or a path to a file in the plugin cache
 * (a kit-supplied recipe, skill or hook). Returns `{ repo, plugin, marketplace, from }`, `repo`
 * null with a `reason` when it cannot be told.
 * @param {string} target @param {{ root?: string | null, dir?: string }} [opts]
 */
export function kitRepo(target, { root = null, dir = configDir() } = {}) {
  const out = (fields) => ({ repo: null, plugin: null, marketplace: null, from: null, reason: null, ...fields });
  if (typeof target !== "string" || target.trim() === "") return out({ reason: "no plugin or path given" });
  const name = target.trim();
  let plugin = null;
  let marketplace = null;
  if (name.includes("/") || name.includes("\\")) {
    const hit = marketplaceOfPath(name, dir);
    if (!hit) return out({ reason: `${name} is not under ${join(dir, "plugins")}: a project file, not a kit file` });
    ({ plugin, marketplace } = hit);
  } else if (name.includes("@")) {
    const at = name.lastIndexOf("@");
    plugin = name.slice(0, at);
    marketplace = name.slice(at + 1);
  } else {
    plugin = name;
    const all = marketplacesOf(name, root, dir);
    if (all.length === 0) return out({ plugin, reason: `no enabled or installed plugin named ${name}; pass ${name}@<marketplace>` });
    if (all.length > 1) return out({ plugin, reason: `${name} comes from several marketplaces (${all.join(", ")}); pass ${name}@<marketplace>` });
    marketplace = all[0];
  }
  const declared = root ? readJson(join(root, ".claude", "settings.json"))?.extraKnownMarketplaces?.[marketplace]?.source : null;
  const known = readJson(join(dir, "plugins", "known_marketplaces.json"))?.[marketplace]?.source;
  const [source, from] = declared ? [declared, ".claude/settings.json"] : known ? [known, "known_marketplaces.json"] : [null, null];
  if (!source) return out({ plugin, marketplace, reason: `marketplace ${marketplace} is neither declared by the project nor registered on this machine` });
  const repo = githubRepo(source);
  if (!repo) return out({ plugin, marketplace, from, reason: `marketplace ${marketplace} is not a GitHub repository` });
  return out({ repo, plugin, marketplace, from });
}

/** One line for a person: the repo and where it came from, or why there is none. */
export function formatKitRepo(r) {
  const what = [r.plugin, r.marketplace].filter(Boolean).join("@");
  if (!r.repo) return `kit-repo: ${what ? `${what}: ` : ""}${r.reason}`;
  return `${r.repo} (${what}, from ${r.from}; label ${KIT_GAP_LABEL})`;
}
