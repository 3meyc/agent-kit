// Compares each installed kit-style plugin with the commit its marketplace ref points at now.
//
// docs/spikes.md S8: auto-update cannot be relied on (the desktop app disables it, headless runs
// never update), so the kit tells the user when an installed plugin lags its channel. A
// "kit-style" plugin carries no `version`, so Claude Code records the commit SHA as its version
// (S3c); a plugin with its own version is skipped, since its marketplace HEAD moves for reasons
// unrelated to it. Node built-ins only.
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
  const ref = typeof source.ref === "string" && source.ref ? source.ref : "HEAD";
  if (source.source === "github" && typeof source.repo === "string") {
    return { url: `https://github.com/${source.repo}.git`, ref };
  }
  if ((source.source === "git" || source.source === "url") && typeof source.url === "string" && !source.url.endsWith(".json")) {
    return { url: source.url, ref };
  }
  return null;
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
 * Plugins installed for `root` whose commit differs from their marketplace ref's commit now.
 * @param {{ root?: string | null, cacheFile?: string | null, timeoutMs?: number, state?: ReturnType<typeof readPluginState>, resolveSha?: (remote: {url: string, ref: string}) => string | null, now?: number }} [options]
 * @returns {{ lagging: Array<{ plugin: string, marketplace: string, scope: string, installed: string, latest: string, ref: string }>, checked: Array<{ plugin: string, marketplace: string, scope: string, installed: string, latest: string | null, ref: string }> }}
 */
export function checkUpdates({
  root = null,
  cacheFile = null,
  timeoutMs = 4000,
  state = readPluginState(),
  resolveSha,
  now = Date.now(),
} = {}) {
  const cache = cacheFile ? (readJson(cacheFile) ?? {}) : {};
  let cacheDirty = false;
  const shaFor = (name, remote) => {
    const key = `${name} ${remote.url} ${remote.ref}`;
    const hit = cache[key];
    // A failed lookup (offline, private repo without access) is remembered briefly, so a machine
    // without network does not pay the timeout at every session start.
    if (hit && now - hit.at < (hit.sha ? CACHE_TTL_MS : MISS_TTL_MS)) return hit.sha;
    const sha = resolveSha ? resolveSha(remote) : lsRemote(remote, timeoutMs);
    cache[key] = { sha: sha ?? null, at: now };
    cacheDirty = true;
    return sha;
  };

  const checked = [];
  for (const [id, entries] of Object.entries(state.installed)) {
    const at = id.lastIndexOf("@");
    if (at <= 0 || !Array.isArray(entries)) continue;
    const plugin = id.slice(0, at);
    const marketplace = id.slice(at + 1);
    const remote = marketplaceRemote(state.marketplaces[marketplace]?.source);
    if (!remote) continue;
    for (const entry of entries) {
      if (!appliesTo(entry, root) || !isCommitVersioned(entry)) continue;
      const latest = shaFor(marketplace, remote);
      checked.push({ plugin, marketplace, scope: entry.scope, installed: entry.gitCommitSha, latest, ref: remote.ref });
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
  const lagging = checked.filter((item) => item.latest !== null && item.latest !== item.installed);
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

/** Where the SessionStart check caches remote SHAs: the plugin's data folder when set. */
export function defaultCacheFile() {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (data) return join(data, "update-check.json");
  const fallback = join(claudeDir(), "plugins", "data", "agent-kit-core");
  return existsSync(dirname(fallback)) ? join(fallback, "update-check.json") : null;
}
