// Compares each installed kit-style plugin with the commit its marketplace ref points at now.
//
// docs/spikes.md S8: auto-update cannot be relied on (the desktop app disables it, headless runs
// never update), so the kit tells the user when an installed plugin lags its channel. A
// "kit-style" plugin carries no `version`, so Claude Code records the commit SHA as its version
// (S3c); a plugin with its own version is skipped, since its marketplace HEAD moves for reasons
// unrelated to it. The channel is the ref the project declares in `.claude/settings.json`
// `extraKnownMarketplaces` when it declares one, else the ref this machine registered the
// marketplace at; a plugin whose catalog entry names a git repository of its own follows that
// repository's ref instead (`pluginRemote`). Which install record a session loads, when one plugin is installed at several
// scopes, follows S11 (`loadedRecord`). Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

/**
 * The plugin's entry in its marketplace's local catalog
 * (`<installLocation>/.claude-plugin/marketplace.json`), or null when the catalog is not on disk.
 * @param {ReturnType<typeof readPluginState>} state @param {string} marketplace @param {string} plugin
 */
export function catalogEntry(state, marketplace, plugin) {
  const location = state.marketplaces[marketplace]?.installLocation;
  if (typeof location !== "string") return null;
  const plugins = readJson(join(location, ".claude-plugin", "marketplace.json"))?.plugins;
  return Array.isArray(plugins) ? (plugins.find((entry) => entry?.name === plugin) ?? null) : null;
}

/**
 * Where a plugin's commits come from when its catalog entry names a git repository of its own
 * (`github` or `url` source) rather than a path inside the marketplace: the clone URL, the ref
 * the entry names (`HEAD` when none), and the commit it pins with `sha`, if any. Null otherwise,
 * so the plugin follows its marketplace's ref.
 * @param {any} source
 */
export function pluginRemote(source) {
  if (!source || typeof source !== "object") return null;
  let url = null;
  if (source.source === "github" && typeof source.repo === "string") url = `https://github.com/${source.repo}.git`;
  else if (source.source === "url" && typeof source.url === "string" && !source.url.endsWith(".json")) url = source.url;
  if (!url) return null;
  return { url, ref: sourceRef(source), pinned: typeof source.sha === "string" && source.sha ? source.sha : null };
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

/** `path` with symlinks resolved when it exists (`/tmp` is `/private/tmp` on macOS), else as given. */
export function realPath(path) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** Whether two folders are the same one, by real path. */
export function samePath(a, b) {
  return typeof a === "string" && typeof b === "string" && realPath(a) === realPath(b);
}

/**
 * The main checkout of the git repository `path` belongs to: a linked worktree resolves to the
 * checkout that owns it. A path that no longer exists counts from its nearest existing folder, so a
 * removed worktree under the main checkout still belongs to it. Null outside git.
 * @param {string} path
 */
export function repoRoot(path) {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  dir = realPath(dir);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        if (statSync(dotGit).isDirectory()) return dir;
        const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (!gitdir) return dir;
        const worktreeGitDir = resolve(dir, gitdir);
        const commondirFile = join(worktreeGitDir, "commondir");
        const common = existsSync(commondirFile) ? resolve(worktreeGitDir, readFileSync(commondirFile, "utf8").trim()) : dirname(dirname(worktreeGitDir));
        return realPath(basename(common) === ".git" ? dirname(common) : common);
      } catch {
        return dir;
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** What Claude Code matches project-scope records by: the repository, else the folder itself. */
function projectKey(path) {
  return repoRoot(path) ?? realPath(path);
}

/**
 * Whether an install record can be the copy a session in `root` loads (docs/spikes.md S11): a
 * user or managed record always; a project or local record when its folder is in the same git
 * repository as `root` (any worktree of it), or is `root` itself outside git. Local scope is
 * assumed to match like project scope (unverified).
 * @param {Record<string, any>} entry @param {string | null} root @param {Map<string, string>} [keys]
 */
export function recordApplies(entry, root, keys = new Map()) {
  if (entry.scope === "user" || entry.scope === "managed") return true;
  if (typeof entry.projectPath !== "string" || !root) return false;
  const key = (path) => {
    if (!keys.has(path)) keys.set(path, projectKey(path));
    return keys.get(path);
  };
  return key(entry.projectPath) === key(root);
}

/**
 * The install record a session in `root` loads: the first record in `installed_plugins.json`
 * order that applies (S11). New records are appended, so a project-scope record written before
 * the user one, or a user one reinstalled later, decides which copy runs.
 * @param {Array<Record<string, any>>} entries @param {string | null} root
 */
export function loadedRecord(entries, root, keys = new Map()) {
  return entries.find((entry) => recordApplies(entry, root, keys)) ?? null;
}

/** A plugin without its own version: Claude Code stores the commit SHA prefix as the version. */
export function isCommitVersioned(entry) {
  return (
    typeof entry.gitCommitSha === "string" &&
    typeof entry.version === "string" &&
    entry.gitCommitSha.startsWith(entry.version)
  );
}

/**
 * The commit each marketplace's channel points at now, looked up once per marketplace.
 *
 * The channel is the project's declared ref (`declared`) when the project declares the
 * marketplace, else the ref the marketplace is registered at on this machine; `registeredRef` keeps
 * the latter, so a caller can say when the two differ (plugins install from the registered one).
 * Remote SHAs are cached in `cacheFile`: for six hours, a failed lookup for thirty minutes. With
 * `fresh`, the cache is not trusted: every remote is read again, and only when that read fails does
 * a cached SHA stand in, with `from: "cache"` and its age in `cachedAt`. Call `save()` once done.
 * @param {{ cacheFile?: string | null, timeoutMs?: number, state: ReturnType<typeof readPluginState>, declared?: Record<string, any>, fresh?: boolean, resolveSha?: (remote: {url: string, ref: string}) => string | null, now?: number }} options
 */
export function channelResolver({ cacheFile = null, timeoutMs = 4000, state, declared = {}, fresh = false, resolveSha, now = Date.now() }) {
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
  return {
    /**
     * The channel of `plugin` from `marketplace`: the plugin's own repository and ref when its
     * catalog entry names one (`pluginRemote`; a pinned `sha` is the answer, with `from: "pinned"`),
     * else the marketplace's ref.
     * @param {string} marketplace @param {string} [plugin]
     * @returns {{ ref: string, registeredRef: string, latest: string | null, from: "remote" | "cache" | "none" | "pinned", cachedAt: number | null, source: string | null } | null}
     */
    channel(marketplace, plugin) {
      const own = plugin ? pluginRemote(catalogEntry(state, marketplace, plugin)?.source) : null;
      if (own?.pinned) return { ref: own.ref, registeredRef: own.ref, latest: own.pinned, from: "pinned", cachedAt: null, source: own.url };
      if (own) {
        const { sha, from, cachedAt } = shaFor(`${marketplace}/${plugin}`, own);
        return { ref: own.ref, registeredRef: own.ref, latest: sha, from, cachedAt, source: own.url };
      }
      const registered = state.marketplaces[marketplace]?.source;
      const remote = marketplaceRemote(declared[marketplace]) ?? marketplaceRemote(registered);
      if (!remote) return null;
      const { sha, from, cachedAt } = shaFor(marketplace, remote);
      return { ref: remote.ref, registeredRef: registered ? sourceRef(registered) : remote.ref, latest: sha, from, cachedAt, source: null };
    },
    save() {
      if (!cacheFile || !cacheDirty) return;
      try {
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(cache));
        cacheDirty = false;
      } catch {
        // A cache that cannot be written only costs another ls-remote next time.
      }
    },
  };
}

/** `name@marketplace` split, or null for an id without a marketplace. */
export function splitId(id) {
  const at = id.lastIndexOf("@");
  return at > 0 ? { plugin: id.slice(0, at), marketplace: id.slice(at + 1) } : null;
}

/**
 * Kit-style plugins installed for `root`, each against its channel's commit now (see
 * `channelResolver`). One item per install record that a session in `root` could load: the user
 * record, and each project or local record of the same repository. `loaded` marks the copy a
 * session there actually runs (`loadedRecord`, S11); `own` marks a record for `root` itself;
 * `userInstalled` is the user-scope copy's commit, or null when there is none. `include` keeps only
 * the plugins it accepts, before any remote is read.
 * @param {{ root?: string | null, cacheFile?: string | null, timeoutMs?: number, state?: ReturnType<typeof readPluginState>, declared?: Record<string, any>, fresh?: boolean, resolveSha?: (remote: {url: string, ref: string}) => string | null, now?: number, include?: (plugin: string, marketplace: string) => boolean }} [options]
 * @returns {{ lagging: Array<UpdateItem & { latest: string }>, checked: UpdateItem[] }}
 * @typedef {{ plugin: string, marketplace: string, scope: string, projectPath: string | null, installed: string, latest: string | null, ref: string, registeredRef: string, from: "remote" | "cache" | "none" | "pinned", cachedAt: number | null, source: string | null, loaded: boolean, own: boolean, userInstalled: string | null }} UpdateItem
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
  include,
} = {}) {
  const channels = channelResolver({ cacheFile, timeoutMs, state, declared, fresh, resolveSha, now });
  const keys = new Map();
  const checked = [];
  for (const [id, entries] of Object.entries(state.installed)) {
    const name = splitId(id);
    if (!name || !Array.isArray(entries)) continue;
    if (include && !include(name.plugin, name.marketplace)) continue;
    const records = entries.filter((entry) => isCommitVersioned(entry) && recordApplies(entry, root, keys));
    if (records.length === 0) continue;
    const channel = channels.channel(name.marketplace, name.plugin);
    if (!channel) continue;
    const loaded = loadedRecord(entries, root, keys);
    const user = entries.find((entry) => entry.scope === "user");
    for (const entry of records) {
      checked.push({
        ...name,
        scope: entry.scope,
        projectPath: typeof entry.projectPath === "string" ? entry.projectPath : null,
        installed: entry.gitCommitSha,
        ...channel,
        loaded: entry === loaded,
        own: entry.scope !== "user" && entry.scope !== "managed" && samePath(entry.projectPath, root),
        userInstalled: typeof user?.gitCommitSha === "string" ? user.gitCommitSha : null,
      });
    }
  }
  channels.save();
  const lagging = /** @type {Array<UpdateItem & { latest: string }>} */ (
    checked.filter((item) => item.latest !== null && item.latest !== item.installed)
  );
  return { lagging, checked };
}

/**
 * The commands that bring one lagging plugin up to its ref (S8). The kit is installed at user
 * scope only, so the update always names `--scope user` (without it, `claude plugin update` picks
 * a project-scope copy, S11); a project or local copy is cleared with `kit installs --clean`.
 * @param {Pick<UpdateItem, "plugin" | "marketplace" | "scope"> & { userInstalled?: string | null }} item
 */
export function updateCommands(item) {
  const id = `${item.plugin}@${item.marketplace}`;
  const commands = [
    `claude plugin marketplace update ${item.marketplace}`,
    item.userInstalled === null ? `claude plugin install ${id} --scope user` : `claude plugin update ${id} --scope user`,
  ];
  if (item.scope === "project" || item.scope === "local") commands.push("kit installs --clean");
  return commands;
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
