// Compares each installed kit-style plugin with the commit its marketplace ref points at now.
//
// docs/spikes.md S8: auto-update cannot be relied on (the desktop app disables it, headless runs
// never update), so the kit tells the user when an installed plugin lags its channel. A
// "kit-style" plugin carries no `version`, so Claude Code records the commit SHA as its version
// (S3c); a plugin with its own version is skipped, since its marketplace HEAD moves for reasons
// unrelated to it. The channel is the ref the project declares in `.claude/settings.json`
// `extraKnownMarketplaces` when it declares one, else the ref this machine registered the
// marketplace at. Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 30 * 60 * 1000;

/** Claude Code's config folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** `known_marketplaces.json` and `installed_plugins.json`, or empty records when absent. */
export function readPluginState(dir = claudeDir()) {
  return {
    marketplaces: readJson(join(dir, "plugins", "known_marketplaces.json")) ?? {},
    installed: readJson(join(dir, "plugins", "installed_plugins.json"))?.plugins ?? {},
  };
}

/** Clone URL and ref of a marketplace source, or null when it is not a git source. */
export function marketplaceRemote(source) {
  if (!source || typeof source !== "object") return null;
  const ref = sourceRef(source);
  if (source.source === "github" && typeof source.repo === "string") {
    return { url: `https://github.com/${source.repo}.git`, ref };
  }
  if ((source.source === "git" || source.source === "url") && typeof source.url === "string" && !source.url.endsWith(".json")) {
    return { url: source.url, ref };
  }
  return null;
}

/**
 * The marketplace sources this project declares in `.claude/settings.json`
 * `extraKnownMarketplaces`, by name; empty when the file is absent or does not parse.
 * @param {string | null} root
 * @returns {Record<string, any>}
 */
export function declaredMarketplaces(root) {
  if (!root) return {};
  const declared = readJson(join(root, ".claude", "settings.json"))?.extraKnownMarketplaces;
  if (!declared || typeof declared !== "object") return {};
  return Object.fromEntries(Object.entries(declared).map(([name, entry]) => [name, entry?.source]));
}

/** The ref a marketplace source names, or `HEAD` when it names none (Claude Code's default). */
export function sourceRef(source) {
  return typeof source?.ref === "string" && source.ref ? source.ref : "HEAD";
}

/**
 * The commit `ref` names in `git ls-remote` output: a peeled tag first, then the tag, then a
 * branch, then the exact ref.
 * @param {string} output @param {string} ref
 */
export function pickRemoteSha(output, ref) {
  const refs = new Map();
  for (const line of output.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name) refs.set(name, sha);
  }
  for (const name of [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`, ref]) {
    if (refs.has(name)) return refs.get(name);
  }
  return null;
}

function lsRemote(remote, timeoutMs) {
  const result = spawnSync("git", ["ls-remote", remote.url, remote.ref, `${remote.ref}^{}`], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.status === 0 ? pickRemoteSha(result.stdout, remote.ref) : null;
}

/**
 * Whether an install record applies to this project: user scope always; project and local scope
 * only for their own project.
 */
function appliesTo(entry, root) {
  if (entry.scope === "user" || entry.scope === "managed") return true;
  return typeof entry.projectPath === "string" && root !== null && resolve(entry.projectPath) === resolve(root);
}

/** A plugin without its own version: Claude Code stores the commit SHA prefix as the version. */
function isCommitVersioned(entry) {
  return (
    typeof entry.gitCommitSha === "string" &&
    typeof entry.version === "string" &&
    entry.gitCommitSha.startsWith(entry.version)
  );
}

/**
 * Plugins installed for `root` whose commit differs from their channel's commit now.
 *
 * The channel is the project's declared ref (`declared`, by default read from `root`) when the
 * project declares the marketplace, else the ref the marketplace is registered at on this machine;
 * `registeredRef` keeps the latter, so a caller can say when the two differ (plugins install from
 * the registered one). Remote SHAs are cached in `cacheFile`: for six hours, a failed lookup for
 * thirty minutes. With `fresh`, the cache is not trusted: every remote is read again, and only
 * when that read fails does a cached SHA stand in, with `from: "cache"` and its age in `cachedAt`.
 * @param {{ root?: string | null, cacheFile?: string | null, timeoutMs?: number, state?: ReturnType<typeof readPluginState>, declared?: Record<string, any>, fresh?: boolean, resolveSha?: (remote: {url: string, ref: string}) => string | null, now?: number }} [options]
 * @returns {{ lagging: Array<UpdateItem & { latest: string }>, checked: UpdateItem[] }}
 * @typedef {{ plugin: string, marketplace: string, scope: string, installed: string, latest: string | null, ref: string, registeredRef: string, from: "remote" | "cache" | "none", cachedAt: number | null }} UpdateItem
 */
export function checkUpdates({
  root = null,
  cacheFile = null,
  timeoutMs = 4000,
  state = readPluginState(),
  declared = declaredMarketplaces(root),
  fresh = false,
  resolveSha,
  now = Date.now(),
} = {}) {
  const cache = cacheFile ? (readJson(cacheFile) ?? {}) : {};
  let cacheDirty = false;
  const looked = new Map();
  const shaFor = (name, remote) => {
    const key = `${name} ${remote.url} ${remote.ref}`;
    if (looked.has(key)) return looked.get(key);
    const hit = cache[key];
    let result;
    // A failed lookup (offline, private repo without access) is remembered briefly, so a machine
    // without network does not pay the timeout at every session start.
    if (!fresh && hit && now - hit.at < (hit.sha ? CACHE_TTL_MS : MISS_TTL_MS)) {
      result = { sha: hit.sha, from: hit.sha ? "cache" : "none", cachedAt: hit.at };
    } else {
      const sha = resolveSha ? resolveSha(remote) : lsRemote(remote, timeoutMs);
      // A fresh read that fails keeps the last good SHA, so it can still be shown as the cache's.
      if (sha || !fresh || !hit?.sha) {
        cache[key] = { sha: sha ?? null, at: now };
        cacheDirty = true;
      }
      if (sha) result = { sha, from: "remote", cachedAt: null };
      else if (fresh && hit?.sha) result = { sha: hit.sha, from: "cache", cachedAt: hit.at };
      else result = { sha: null, from: "none", cachedAt: null };
    }
    looked.set(key, result);
    return result;
  };

  const checked = [];
  for (const [id, entries] of Object.entries(state.installed)) {
    const at = id.lastIndexOf("@");
    if (at <= 0 || !Array.isArray(entries)) continue;
    const plugin = id.slice(0, at);
    const marketplace = id.slice(at + 1);
    const registered = state.marketplaces[marketplace]?.source;
    const remote = marketplaceRemote(declared[marketplace]) ?? marketplaceRemote(registered);
    if (!remote) continue;
    const registeredRef = registered ? sourceRef(registered) : remote.ref;
    for (const entry of entries) {
      if (!appliesTo(entry, root) || !isCommitVersioned(entry)) continue;
      const { sha: latest, from, cachedAt } = shaFor(marketplace, remote);
      checked.push({ plugin, marketplace, scope: entry.scope, installed: entry.gitCommitSha, latest, ref: remote.ref, registeredRef, from, cachedAt });
    }
  }
  if (cacheFile && cacheDirty) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(cache));
    } catch {
      // A cache that cannot be written only costs another ls-remote next time.
    }
  }
  const lagging = /** @type {Array<UpdateItem & { latest: string }>} */ (
    checked.filter((item) => item.latest !== null && item.latest !== item.installed)
  );
  return { lagging, checked };
}

/** The two commands that bring one lagging plugin up to its ref (S8). */
export function updateCommands(item) {
  const scope = item.scope && item.scope !== "user" ? ` --scope ${item.scope}` : "";
  return [
    `claude plugin marketplace update ${item.marketplace}`,
    `claude plugin update ${item.plugin}@${item.marketplace}${scope}`,
  ];
}

/**
 * Where remote SHAs are cached: the plugin's data folder when set (hooks), else the folder Claude
 * Code gives `core@agent-kit`, `plugins/data/core-agent-kit` (observed: `<plugin>-<marketplace>`),
 * so `kit doctor` run from a shell shares the hook's cache.
 */
export function defaultCacheFile() {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (data) return join(data, "update-check.json");
  const fallback = join(claudeDir(), "plugins", "data", "core-agent-kit");
  return existsSync(dirname(fallback)) ? join(fallback, "update-check.json") : null;
}
