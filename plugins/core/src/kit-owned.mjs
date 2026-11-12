// Which project files a kit plugin supplies, and which of them a project still keeps a copy of.
// Used by `kit doctor` (a copy shadows or duplicates the kit) and `kit adopt` (what to retire).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadedRecord, readPluginState } from "./update-check.mjs";

export const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The plugin's name: its manifest's, else the install id's, else the folder's. */
export function pluginName(root, id = null) {
  return readJson(join(root, ".claude-plugin", "plugin.json"))?.name ?? (id ? id.slice(0, id.lastIndexOf("@")) : null) ?? basename(root);
}

/** Whether a folder is a plugin: it has `.claude-plugin/plugin.json`. @param {string} dir */
function isPluginDir(dir) {
  return existsSync(join(dir, ".claude-plugin", "plugin.json"));
}

/**
 * The `--plugin-dir` values in one command line. `ps` joins arguments with spaces, so a value is
 * grown token by token until it names a plugin folder (a path with spaces); `cwd` resolves a
 * relative one. Pure apart from the existence check.
 * @param {string[]} tokens @param {string} cwd @param {(dir: string) => boolean} [isPlugin]
 */
export function pluginDirArgs(tokens, cwd, isPlugin = isPluginDir) {
  const dirs = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let value = null;
    if (tokens[i] === "--plugin-dir") {
      let candidate = "";
      for (let j = i + 1; j < tokens.length && !(j > i + 1 && tokens[j].startsWith("--")); j += 1) {
        candidate = candidate ? `${candidate} ${tokens[j]}` : tokens[j];
        if (isPlugin(resolve(cwd, candidate))) {
          value = candidate;
          i = j;
          break;
        }
      }
      if (value === null && tokens[i + 1]) value = tokens[i + 1];
    } else if (tokens[i].startsWith("--plugin-dir=")) value = tokens[i].slice("--plugin-dir=".length);
    if (value) dirs.push(resolve(cwd, value));
  }
  return dirs;
}

/**
 * This process's ancestors, nearest first, up to `max` levels, as `{ exe, command }`: a `kit` run
 * from a Claude Code session has the `claude` process somewhere above it. POSIX `ps` only; empty
 * on Windows or when `ps` is missing.
 * @returns {Array<{ exe: string, command: string }>}
 */
export function ancestorProcesses(max = 12, pid = process.ppid) {
  if (process.platform === "win32") return [];
  const ps = (field) => spawnSync("ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" });
  const found = [];
  for (let level = 0; level < max && pid > 1; level += 1) {
    const parent = ps("ppid");
    if (parent.status !== 0 || !parent.stdout.trim()) break;
    found.push({ exe: ps("comm").stdout.trim(), command: ps("command").stdout.trim() });
    pid = Number(parent.stdout.trim());
  }
  return found;
}

/** Whether a process is Claude Code: its executable is `claude`, or node running the CLI package. */
export function isClaudeProcess({ exe, command }) {
  return /(^|[\\/])claude(\.exe)?$/.test(exe) || /@anthropic-ai[\\/]claude-code[\\/]/.test(command);
}

/**
 * Plugin folders this session loaded with `--plugin-dir`, which no settings file names: from
 * `KIT_PLUGIN_DIRS` (paths joined by the OS path delimiter), from `extra` (`kit doctor
 * --plugin-dir <path>`), and from the command line of the `claude` process this runs under.
 * Only folders that hold a plugin are kept.
 * @param {{ env?: NodeJS.ProcessEnv, extra?: string[], processes?: Array<{ exe: string, command: string }>, cwd?: string }} [options]
 */
export function sessionPluginDirs({ env = process.env, extra = [], processes, cwd = process.cwd() } = {}) {
  const dirs = [...extra.map((dir) => resolve(cwd, dir))];
  for (const dir of (env.KIT_PLUGIN_DIRS ?? "").split(delimiter)) if (dir) dirs.push(resolve(cwd, dir));
  const claude = (processes ?? ancestorProcesses()).find(isClaudeProcess);
  if (claude) dirs.push(...pluginDirArgs(claude.command.split(/\s+/), cwd));
  return [...new Set(dirs)].filter(isPluginDir);
}

/**
 * The plugin folders behind `kit doctor --plugin-root <path>` values: a path that holds a plugin,
 * else each plugin folder directly inside it (an overlay package's `plugins/`). A relative path
 * resolves against `cwd`. A path with no plugin in it is returned in `missing`, so a CI job with a
 * wrong path fails instead of checking less than it should.
 * @param {string[]} paths @param {string} [cwd]
 * @returns {{ roots: string[], missing: string[] }}
 */
export function ownershipRootDirs(paths, cwd = process.cwd()) {
  const roots = [];
  const missing = [];
  for (const path of paths) {
    const dir = resolve(cwd, path);
    if (isPluginDir(dir)) roots.push(dir);
    else {
      const inside = existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).map((name) => join(dir, name)).filter(isPluginDir) : [];
      if (inside.length === 0) missing.push(path);
      roots.push(...inside);
    }
  }
  return { roots: [...new Set(roots)], missing };
}

/**
 * Plugin folders to read ownership from: this plugin, the plugins this session loaded with
 * `--plugin-dir` (they override an installed copy of the same name), the folders passed with
 * `--plugin-root` (an overlay's plugins in CI, where nothing is installed), every plugin installed
 * for the project (overlays may ship a `kit-owned.json` too), and, when this plugin runs from a kit
 * checkout or the kit's npm package, its sibling plugins. `source` says which; `id` is
 * `name@marketplace` for an install.
 * @param {string | null} projectDir @param {string[]} [extraRoots] `--plugin-root` plugin folders
 * @returns {Array<{ root: string, name: string, source: "self" | "session" | "root" | "installed" | "sibling", id?: string }>}
 */
export function pluginRoots(projectDir, state = readPluginState(), sessionDirs = sessionPluginDirs({ cwd: projectDir ?? process.cwd() }), extraRoots = []) {
  /** @type {Map<string, { root: string, name: string, source: any, id?: string }>} */
  const byName = new Map();
  const add = (root, source, id) => {
    const name = pluginName(root, id);
    if (!byName.has(name)) byName.set(name, { root, name, source, ...(id ? { id } : {}) });
  };
  add(CORE_ROOT, "self");
  for (const dir of sessionDirs) add(dir, "session");
  for (const dir of extraRoots) add(dir, "root");
  const keys = new Map();
  for (const [id, entries] of Object.entries(state.installed)) {
    if (!Array.isArray(entries)) continue;
    // The copy a session here loads (docs/spikes.md S11), not every copy on the machine.
    const entry = loadedRecord(entries, projectDir, keys);
    if (entry && typeof entry.installPath === "string" && existsSync(entry.installPath)) add(entry.installPath, "installed", id);
  }
  const pluginsDir = dirname(CORE_ROOT);
  if (existsSync(join(pluginsDir, "..", ".claude-plugin", "marketplace.json"))) {
    for (const name of readdirSync(pluginsDir)) {
      const root = join(pluginsDir, name);
      if (isPluginDir(root)) add(root, "sibling");
    }
  }
  return [...byName.values()];
}

/**
 * The marketplace whose source this project is, as a kit repo has it (the base kit, or an overlay
 * kit's own repo): the `name` in its `.claude-plugin/marketplace.json` and the plugins listed there
 * with a relative source folder that holds a plugin, by name. Null for a project that only uses kits.
 * @param {string} projectDir @returns {{ name: string, plugins: Map<string, string> } | null}
 */
export function ownMarketplace(projectDir) {
  const manifest = readJson(join(projectDir, ".claude-plugin", "marketplace.json"));
  if (typeof manifest?.name !== "string" || !Array.isArray(manifest.plugins)) return null;
  const plugins = new Map();
  for (const entry of manifest.plugins) {
    const source = entry?.source;
    if (typeof entry?.name === "string" && typeof source === "string" && source.startsWith("./") && isPluginDir(join(projectDir, source))) {
      plugins.set(entry.name, source.slice(2));
    }
  }
  return { name: manifest.name, plugins };
}

/** A plugin's `dependencies` as `{ name, marketplace }`; a bare name has `marketplace: null`. */
export function pluginDependencies(root) {
  const list = readJson(join(root, ".claude-plugin", "plugin.json"))?.dependencies;
  if (!Array.isArray(list)) return [];
  return list
    .map((dep) => {
      if (typeof dep === "string") {
        const at = dep.lastIndexOf("@");
        return at > 0 ? { name: dep.slice(0, at), marketplace: dep.slice(at + 1) } : { name: dep, marketplace: null };
      }
      return dep && typeof dep.name === "string" ? { name: dep.name, marketplace: typeof dep.marketplace === "string" ? dep.marketplace : null } : null;
    })
    .filter(Boolean);
}

function listNames(dir, filter) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => filter(join(dir, name), name));
}

/**
 * Everything one plugin supplies, as project paths: `files` from its kit-owned.json, its agents,
 * its skills (as a project skill folder or a legacy command file) and the hook scripts it replaces.
 * @param {{ root: string, name: string }} plugin
 */
export function ownedBy(plugin) {
  const manifest = readJson(join(plugin.root, "kit-owned.json")) ?? {};
  const files = (manifest.files ?? []).map((path) => ({ path, note: manifest.partial?.[path] ?? null }));
  for (const name of listNames(join(plugin.root, "agents"), (_, n) => n.endsWith(".md"))) {
    files.push({ path: `.claude/agents/${name}`, note: `same name as agent ${plugin.name}:${name.slice(0, -3)}` });
  }
  for (const name of listNames(join(plugin.root, "skills"), (path) => statSync(path).isDirectory())) {
    files.push({ path: `.claude/skills/${name}`, note: `same name as skill ${plugin.name}:${name}` });
    files.push({ path: `.claude/commands/${name}.md`, note: `same name as skill ${plugin.name}:${name}` });
  }
  return { plugin: plugin.name, files, hookScripts: manifest.hookScripts ?? [] };
}

/** Hook commands declared in the project's shared and local settings. */
function projectHookCommands(projectDir) {
  const commands = [];
  for (const file of [".claude/settings.json", ".claude/settings.local.json"]) {
    const hooks = readJson(join(projectDir, file))?.hooks ?? {};
    for (const [event, groups] of Object.entries(hooks)) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of group?.hooks ?? []) {
          if (typeof hook?.command === "string") commands.push({ file, event, command: hook.command });
        }
      }
    }
  }
  return commands;
}

const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_TEST_BYTES = 512 * 1024;

/** A repo-relative path without its script extension. @param {string} path */
function stem(path) {
  return path.replace(SCRIPT_FILE, "");
}

/** Test files of the project, repo-relative: git's tracked and untracked-but-not-ignored files. */
export function projectTestFiles(projectDir) {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) return [];
  return [...new Set(listed.stdout.split("\0"))].filter((path) => TEST_FILE.test(path) && existsSync(join(projectDir, path)));
}

/** Relative module specifiers in a source text (`import`, `export … from`, `import()`, `require()`). */
export function relativeImports(text) {
  const found = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of text.matchAll(pattern)) found.push(match[1]);
  return found;
}

/**
 * Tests that belong to kit-owned scripts, so a project deletes them with the script: a test beside
 * the script with the same name (`ledger-brief.test.ts` next to `ledger-brief.mjs`), or a test
 * anywhere that imports it. The script itself may already be gone: a test left behind still
 * imports a deleted module. Pure apart from reading the test files.
 * @param {string[]} owned repo-relative kit-owned paths
 * @param {string[]} tests repo-relative test files
 * @param {(path: string) => string} read
 * @returns {Array<{ test: string, of: string }>}
 */
export function testsOfOwned(owned, tests, read) {
  const scripts = owned.filter((path) => SCRIPT_FILE.test(path) && !TEST_FILE.test(path));
  if (scripts.length === 0) return [];
  const byStem = new Map(scripts.map((path) => [stem(path), path]));
  const found = [];
  for (const test of tests) {
    const beside = byStem.get(test.replace(TEST_FILE, ""));
    if (beside) {
      found.push({ test, of: beside });
      continue;
    }
    let text = "";
    try {
      text = read(test);
    } catch {
      continue;
    }
    for (const specifier of relativeImports(text)) {
      const target = byStem.get(stem(posix.normalize(posix.join(posix.dirname(test), specifier))));
      if (target) {
        found.push({ test, of: target });
        break;
      }
    }
  }
  return found;
}

/**
 * Whether a kit-owned entry is present in the project. A plain path is a file or folder. A path
 * `<file>#<key.path>` names one key inside a JSON file (`.mcp.json#mcpServers.svelte`), so a
 * plugin can claim the entries it supplies while the project keeps its own in the same file.
 * Keys are dot-separated; a key with a dot in its name cannot be named.
 * @param {string} projectDir @param {string} path
 */
export function ownedPresent(projectDir, path) {
  const hash = path.indexOf("#");
  if (hash === -1) return existsSync(join(projectDir, path));
  let node = readJson(join(projectDir, path.slice(0, hash)));
  for (const key of path.slice(hash + 1).split(".")) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return true;
}

/** A kit-owned entry as doctor prints it: `.mcp.json (mcpServers.svelte)` for a JSON key. @param {string} path */
function ownedLabel(path) {
  const hash = path.indexOf("#");
  return hash === -1 ? path : `${path.slice(0, hash)} (${path.slice(hash + 1)})`;
}

/**
 * The plugins whose files a project can be said to copy: this plugin and `--plugin-dir` ones
 * always; an installed, sibling or `--plugin-root` plugin only when the project enables it,
 * directly or as a dependency of one it enables. A project that enables no plugin yet (before
 * `/kit-adopt`) keeps them all, so adoption lists everything the kit could supply. `local: false`
 * reads only the shared `.claude/settings.json`, as a CI checkout has it.
 * @param {string} projectDir @param {Array<{ root: string, name: string, source?: string }>} plugins
 * @param {{ local?: boolean }} [options]
 */
export function enabledForProject(projectDir, plugins, { local = true } = {}) {
  const enabled = new Set();
  for (const file of local ? ["settings.json", "settings.local.json"] : ["settings.json"]) {
    const entries = readJson(join(projectDir, ".claude", file))?.enabledPlugins ?? {};
    for (const [id, on] of Object.entries(entries)) {
      const name = id.split("@")[0];
      if (on === true) enabled.add(name);
      else if (on === false) enabled.delete(name);
    }
  }
  if (enabled.size === 0) return plugins;
  const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  for (const name of [...enabled]) {
    for (let queue = [name]; queue.length > 0; ) {
      const plugin = byName.get(queue.pop());
      for (const dep of plugin ? pluginDependencies(plugin.root) : []) {
        if (!enabled.has(dep.name)) {
          enabled.add(dep.name);
          queue.push(dep.name);
        }
      }
    }
  }
  return plugins.filter((plugin) => plugin.source === "self" || plugin.source === "session" || enabled.has(plugin.name));
}

/** A kit text counts as copied when the project file holds this share of its lines, and at least `MIN_COPIED_LINES`. */
const COPIED_SHARE = 0.5;
const MIN_COPIED_LINES = 5;
const MIN_LINE_CHARS = 25;

/**
 * The distinct lines of a Markdown text that say something: front matter dropped, list markers,
 * heading marks and table pipes stripped, whitespace folded, lower-cased; lines shorter than
 * `MIN_LINE_CHARS` left out, so blank lines, fences and short labels never make a match.
 * @param {string} text
 */
export function textLines(text) {
  const body = String(text).replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
  const lines = new Set();
  for (const raw of body.split("\n")) {
    const line = raw
      .replace(/^\s*(?:#+|[-*+]|\d+(?:\.\d+)*\.|>)\s*/, "")
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (line.length >= MIN_LINE_CHARS) lines.add(line);
  }
  return lines;
}

/** The texts a plugin puts in front of the model: `rules/*.md` and `skills/<name>/SKILL.md`. @param {{ root: string }} plugin */
function kitTexts(plugin) {
  const texts = [];
  for (const name of listNames(join(plugin.root, "rules"), (_, n) => n.endsWith(".md"))) texts.push(`rules/${name}`);
  for (const name of listNames(join(plugin.root, "skills"), (path) => statSync(path).isDirectory())) {
    if (existsSync(join(plugin.root, "skills", name, "SKILL.md"))) texts.push(`skills/${name}/SKILL.md`);
  }
  return texts.map((source) => ({ source, lines: textLines(readFileSync(join(plugin.root, source), "utf8")) }));
}

/** Project files an agent reads as instructions: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/**`, skills and commands. */
function instructionFiles(projectDir) {
  const found = ["CLAUDE.md", "AGENTS.md"].filter((path) => existsSync(join(projectDir, path)));
  const walk = (rel) => {
    for (const name of listNames(join(projectDir, rel), () => true)) {
      const path = `${rel}/${name}`;
      if (statSync(join(projectDir, path)).isDirectory()) walk(path);
      else if (name.endsWith(".md")) found.push(path);
    }
  };
  walk(".claude/rules");
  walk(".claude/commands");
  for (const name of listNames(join(projectDir, ".claude", "skills"), (path) => statSync(path).isDirectory())) {
    if (existsSync(join(projectDir, ".claude", "skills", name, "SKILL.md"))) found.push(`.claude/skills/${name}/SKILL.md`);
  }
  return found;
}

/**
 * Project files that carry a plugin's rule or skill text under a name the kit does not list: at
 * least half of the kit text's lines (and `MIN_COPIED_LINES`) appear in the project file. A copy
 * under the kit's own name is caught by `ownedBy`; this catches the renamed one.
 * @param {string} projectDir @param {{ root: string, name: string }} plugin
 * @param {(path: string) => string} read
 * @returns {Array<{ path: string, note: string }>}
 */
export function textCopies(projectDir, plugin, read = (path) => readFileSync(join(projectDir, path), "utf8")) {
  const texts = kitTexts(plugin).filter((text) => text.lines.size >= MIN_COPIED_LINES);
  if (texts.length === 0) return [];
  const found = [];
  for (const path of instructionFiles(projectDir)) {
    let lines;
    try {
      if (statSync(join(projectDir, path)).size > MAX_TEST_BYTES) continue;
      lines = textLines(read(path));
    } catch {
      continue;
    }
    for (const text of texts) {
      let shared = 0;
      for (const line of text.lines) if (lines.has(line)) shared += 1;
      if (shared >= MIN_COPIED_LINES && shared >= text.lines.size * COPIED_SHARE) {
        found.push({ path, note: `holds ${shared} of the ${text.lines.size} lines of ${plugin.name}'s ${text.source}; the plugin supplies that text, so remove the copy and keep only project-specific lines` });
        break;
      }
    }
  }
  return found;
}

/**
 * Kit-owned files and hook entries the project still has, and tests of kit-owned scripts. In the
 * repo a plugin comes from (`ownMarketplace`), the tests are not looked for: that repo tests the
 * plugin's own source under its plugin folder, and its tests name the project paths a plugin owns
 * as fixture data, which reads like an import of a deleted script.
 * `tests` replaces the git listing of test files, for a tree that is not a git checkout (`kit fleet`
 * reads a downloaded archive).
 * @param {string} projectDir @param {Array<{ root: string, name: string }>} [plugins]
 * @param {{ tests?: string[] }} [options]
 * @returns {Array<{ path: string, plugin: string, note: string | null }>}
 */
export function findKitCopies(projectDir, plugins = enabledForProject(projectDir, pluginRoots(projectDir)), { tests = projectTestFiles(projectDir) } = {}) {
  const found = [];
  const hooks = projectHookCommands(projectDir);
  const ownPlugins = ownMarketplace(projectDir)?.plugins ?? new Map();
  const read = (path) => {
    const file = join(projectDir, path);
    return statSync(file).size > MAX_TEST_BYTES ? "" : readFileSync(file, "utf8");
  };
  const seen = new Set();
  for (const plugin of plugins) {
    const owned = ownedBy(plugin);
    for (const { path, note } of owned.files) {
      if (ownedPresent(projectDir, path) && !seen.has(path)) {
        seen.add(path);
        found.push({ path: ownedLabel(path), plugin: owned.plugin, note });
      }
    }
    for (const { test, of } of ownPlugins.has(owned.plugin) ? [] : testsOfOwned(owned.files.map((file) => file.path), tests, read)) {
      if (seen.has(test)) continue;
      seen.add(test);
      const gone = existsSync(join(projectDir, of)) ? "" : ", which is already gone";
      found.push({ path: test, plugin: owned.plugin, note: `tests kit-owned ${of}${gone}; delete it with the script` });
    }
    for (const copy of ownPlugins.has(owned.plugin) ? [] : textCopies(projectDir, plugin)) {
      if (seen.has(copy.path) || owned.files.some((file) => copy.path.startsWith(file.path))) continue;
      seen.add(copy.path);
      found.push({ path: copy.path, plugin: owned.plugin, note: copy.note });
    }
    for (const script of owned.hookScripts) {
      for (const hook of hooks) {
        if (hook.command.includes(script)) {
          found.push({ path: `${hook.file} (${hook.event} hook: ${script})`, plugin: owned.plugin, note: "the kit runs this hook itself" });
        }
      }
    }
  }
  return found;
}
