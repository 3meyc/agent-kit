// `kit dev`: the `claude --plugin-dir …` command that loads a project's kit plugins from local kit
// checkouts (docs/changing.md, step 3). It reads the plugins the project enables, maps each one's
// marketplace to a checkout (`checkouts.json` in the agent-kit config folder, or `--checkout
// <marketplace>=<path>`), adds the dependencies those plugins name, and prints the command or,
// with `--run`, starts it. A plugin whose marketplace has no checkout stays on the installed copy.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { configDir } from "./inventory.mjs";
import { pluginDependencies } from "./kit-owned.mjs";
import { tilde } from "./installs.mjs";

export const CHECKOUTS_FILE = "checkouts.json";

function readJson(file) {
  if (!existsSync(file)) return { missing: true };
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const expandHome = (path, home = homedir()) => (path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path);

/** `name@marketplace` split at the last `@`; null without one. @param {string} id */
function splitPluginId(id) {
  const at = id.lastIndexOf("@");
  return at > 0 && at < id.length - 1 ? { plugin: id.slice(0, at), marketplace: id.slice(at + 1) } : null;
}

/**
 * `kit dev` arguments: `--checkout <marketplace>=<path>` (repeatable), `--config <file>`, `--run`,
 * and everything after `--` for `claude` itself. An unknown argument is an error.
 * @param {string[]} args
 */
export function parseDevArgs(args) {
  const errors = [];
  const checkouts = {};
  let config = null;
  let run = false;
  let passThrough = [];
  const takeValue = (flag, i) => {
    const arg = args[i];
    if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), next: i };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push(`${flag} needs a value`);
      return { value: null, next: i };
    }
    return { value, next: i + 1 };
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      passThrough = args.slice(i + 1);
      break;
    }
    if (arg === "--run") run = true;
    else if (arg === "--checkout" || arg.startsWith("--checkout=")) {
      const { value, next } = takeValue("--checkout", i);
      i = next;
      if (value === null) continue;
      const eq = value.indexOf("=");
      if (eq <= 0 || eq === value.length - 1) errors.push(`--checkout ${value}: write it as <marketplace>=<path>`);
      else checkouts[value.slice(0, eq)] = value.slice(eq + 1);
    } else if (arg === "--config" || arg.startsWith("--config=")) {
      const { value, next } = takeValue("--config", i);
      i = next;
      if (value !== null) config = value;
    } else errors.push(`unknown argument ${arg}`);
  }
  return { checkouts, config, run, passThrough, errors };
}

/**
 * The plugins the project enables: `.claude/settings.json` `enabledPlugins`, with
 * `settings.local.json` switching one on or off for this user, sorted by id.
 * @param {string} projectDir
 * @returns {{ ids: string[], marketplaces: Record<string, any>, errors: string[] }}
 */
export function enabledPlugins(projectDir) {
  const errors = [];
  const files = ["settings.json", "settings.local.json"].map((name) => {
    const file = readJson(join(projectDir, ".claude", name));
    if (file.error) errors.push(`.claude/${name} does not parse: ${file.error}`);
    return file.value ?? {};
  });
  const state = new Map();
  for (const settings of files) {
    for (const [id, on] of Object.entries(settings.enabledPlugins ?? {})) if (typeof on === "boolean") state.set(id, on);
  }
  const ids = [...state].filter(([, on]) => on).map(([id]) => id).sort();
  return { ids, marketplaces: files[0].extraKnownMarketplaces ?? {}, errors };
}

/**
 * The checkout of each marketplace: the config file, then `--checkout` values over it. Paths may
 * start with `~/`; a relative one resolves against `cwd` (a flag) or the config file's folder.
 * @param {{ file?: string, flags?: Record<string, string>, cwd?: string, home?: string }} [options]
 * @returns {{ checkouts: Record<string, { path: string, from: string }>, file: string, errors: string[] }}
 */
export function loadCheckouts({ file = join(configDir(), CHECKOUTS_FILE), flags = {}, cwd = process.cwd(), home = homedir() } = {}) {
  const errors = [];
  /** @type {Record<string, { path: string, from: string }>} */
  const checkouts = {};
  const read = readJson(file);
  if (read.error) errors.push(`${tilde(file)} does not parse: ${read.error}`);
  else if (read.value !== undefined) {
    if (read.value === null || typeof read.value !== "object" || Array.isArray(read.value)) errors.push(`${tilde(file)} must be an object of "<marketplace>": "<path>"`);
    else {
      for (const [name, path] of Object.entries(read.value)) {
        if (typeof path !== "string" || !path) errors.push(`${tilde(file)}: the checkout of ${name} must be a path`);
        else checkouts[name] = { path: resolve(join(file, ".."), expandHome(path, home)), from: tilde(file) };
      }
    }
  }
  for (const [name, path] of Object.entries(flags)) checkouts[name] = { path: resolve(cwd, expandHome(path, home)), from: "--checkout" };
  return { checkouts, file, errors };
}

/**
 * The plugin folders a kit checkout holds, by name: each `.claude-plugin/marketplace.json` entry
 * with a relative source folder that holds a plugin. Null when the checkout has no marketplace file.
 * @param {string} checkout
 * @returns {{ name: string | null, plugins: Map<string, string> } | null}
 */
export function checkoutPlugins(checkout) {
  const manifest = readJson(join(checkout, ".claude-plugin", "marketplace.json")).value;
  if (!manifest || !Array.isArray(manifest.plugins)) return null;
  const plugins = new Map();
  for (const entry of manifest.plugins) {
    const source = entry?.source;
    if (typeof entry?.name !== "string" || typeof source !== "string" || !source.startsWith("./")) continue;
    const root = resolve(checkout, source);
    if (existsSync(join(root, ".claude-plugin", "plugin.json"))) plugins.set(entry.name, root);
  }
  return { name: typeof manifest.name === "string" ? manifest.name : null, plugins };
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

/**
 * A checkout's git state: branch (null when detached), the branch it should be on (its kit.json
 * `baseBranch`, else `main`), and how many files are uncommitted or untracked. `repo: false` when
 * it is not a git checkout.
 * @param {string} checkout
 */
export function checkoutState(checkout) {
  const top = git(checkout, "rev-parse", "--show-toplevel");
  if (top === null) return { repo: false, branch: null, base: "main", dirty: 0 };
  const branch = git(checkout, "symbolic-ref", "--quiet", "--short", "HEAD")?.trim() || null;
  const base = readJson(join(checkout, "kit.json")).value?.baseBranch;
  const status = git(checkout, "status", "--porcelain") ?? "";
  return { repo: true, branch, base: typeof base === "string" && base ? base : "main", dirty: status.split("\n").filter(Boolean).length };
}

/** One shell word: as is when plain, else single-quoted. @param {string} word */
export function shellWord(word) {
  return /^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The plan behind `kit dev`: which enabled plugins (and dependencies) load from a checkout, which
 * stay installed, and the warnings. Pure apart from reading files and `git`.
 * @param {string} projectDir
 * @param {{ checkouts: Record<string, { path: string, from: string }>, state?: (checkout: string) => ReturnType<typeof checkoutState> }} options
 */
export function devPlan(projectDir, { checkouts, state = checkoutState }) {
  const enabled = enabledPlugins(projectDir);
  /** @type {Array<{ id: string, root: string, marketplace: string, why: string }>} */
  const loaded = [];
  /** @type {Array<{ id: string, why: string }>} */
  const installed = [];
  const warnings = [...enabled.errors];
  /** @type {Map<string, { name: string, path: string, from: string, plugins: Map<string, string> | null, problem: string | null }>} */
  const used = new Map();

  const openCheckout = (marketplace) => {
    if (used.has(marketplace)) return used.get(marketplace);
    const config = checkouts[marketplace];
    if (!config) return null;
    let problem = null;
    let plugins = null;
    if (!existsSync(config.path)) problem = `checkout ${marketplace} (${tilde(config.path)}, from ${config.from}) does not exist`;
    else {
      const listed = checkoutPlugins(config.path);
      if (!listed) problem = `checkout ${marketplace} (${tilde(config.path)}) has no .claude-plugin/marketplace.json`;
      else {
        plugins = listed.plugins;
        if (listed.name && listed.name !== marketplace) warnings.push(`checkout ${marketplace} (${tilde(config.path)}) is the marketplace ${listed.name}; check ${config.from}`);
      }
    }
    const entry = { name: marketplace, path: config.path, from: config.from, plugins, problem };
    used.set(marketplace, entry);
    if (problem) warnings.push(problem);
    return entry;
  };

  const seen = new Set();
  const queue = enabled.ids.map((id) => ({ id, why: "enabled" }));
  while (queue.length > 0) {
    const { id, why } = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const name = splitPluginId(id);
    if (!name) {
      warnings.push(`${id} names no marketplace (plugin@marketplace); it is left as it is`);
      continue;
    }
    const checkout = openCheckout(name.marketplace);
    const root = checkout?.plugins?.get(name.plugin);
    if (!root) {
      if (why !== "enabled") {
        if (!enabled.ids.includes(id)) warnings.push(`${id} (${why}) is not enabled and has no checkout to load it from`);
        continue;
      }
      installed.push({ id, why: !checkout ? `no checkout of ${name.marketplace}` : checkout.problem ? `checkout ${name.marketplace} unusable` : `not in checkout ${name.marketplace}` });
      continue;
    }
    loaded.push({ id, root, marketplace: name.marketplace, why });
    for (const dep of pluginDependencies(root)) {
      queue.push({ id: `${dep.name}@${dep.marketplace ?? name.marketplace}`, why: `dependency of ${id}` });
    }
  }

  for (const id of installed.map((item) => item.id)) warnings.push(`${id} has no local checkout and stays on the installed copy`);
  const usedCheckouts = [...used.values()].filter((checkout) => checkout.plugins && loaded.some((item) => item.marketplace === checkout.name));
  for (const checkout of usedCheckouts) {
    const git = state(checkout.path);
    const where = `checkout ${checkout.name} (${tilde(checkout.path)})`;
    if (!git.repo) {
      warnings.push(`${where} is not a git checkout`);
      continue;
    }
    if (git.dirty > 0) warnings.push(`${where} has ${git.dirty} uncommitted file${git.dirty === 1 ? "" : "s"}`);
    if (git.branch === null) warnings.push(`${where} is on a detached HEAD, not ${git.base}`);
    else if (git.branch !== git.base) warnings.push(`${where} is on branch ${git.branch}, not ${git.base}`);
  }
  const command = ["claude", ...loaded.flatMap((item) => ["--plugin-dir", item.root])];
  return { enabled: enabled.ids, loaded, installed, checkouts: usedCheckouts, warnings, command };
}

/**
 * `kit dev [--checkout <marketplace>=<path>]... [--config <file>] [--run] [-- <claude args>]`.
 * Exit 2 on a usage error; with `--run`, 1 when nothing loads from a checkout, else `claude`'s code.
 * @param {string} projectDir @param {string[]} args
 * @param {{ print?: (line: string) => void, cwd?: string, home?: string, state?: (checkout: string) => any, spawn?: typeof spawnSync }} [options]
 */
export function runDev(projectDir, args, { print = console.log, cwd = process.cwd(), home = homedir(), state, spawn = spawnSync } = {}) {
  const parsed = parseDevArgs(args);
  const loadedCheckouts = loadCheckouts({ file: parsed.config ? resolve(cwd, expandHome(parsed.config, home)) : undefined, flags: parsed.checkouts, cwd, home });
  const errors = [...parsed.errors, ...loadedCheckouts.errors];
  if (errors.length > 0) {
    for (const error of errors) console.error(`kit dev: ${error}`);
    return 2;
  }
  const plan = devPlan(projectDir, { checkouts: loadedCheckouts.checkouts, ...(state ? { state } : {}) });
  const command = [...plan.command, ...parsed.passThrough];

  print(`kit dev: kit plugins for ${tilde(projectDir)} from local checkouts`);
  print("");
  print("1. Plugins");
  if (plan.enabled.length === 0) print("   1.1. .claude/settings.json enables no plugins");
  const rows = [
    ...plan.loaded.map((item) => `${item.id}: ${tilde(item.root)}${item.why === "enabled" ? "" : ` (${item.why})`}`),
    ...plan.installed.map((item) => `${item.id}: installed copy (${item.why})`),
  ];
  rows.forEach((row, index) => print(`   1.${index + 1}. ${row}`));
  if (Object.keys(loadedCheckouts.checkouts).length === 0) {
    print(`   No checkouts configured: add ${tilde(loadedCheckouts.file)} as { "<marketplace>": "<path>" }, or pass --checkout <marketplace>=<path>.`);
  }
  print("");
  print("2. Warnings");
  if (plan.warnings.length === 0) print("   none");
  plan.warnings.forEach((warning, index) => print(`   2.${index + 1}. ${warning}`));
  print("");
  print("3. Command (run it in a terminal, from the project folder)");
  if (plan.loaded.length === 0) print("   nothing to load from a checkout; plain `claude` runs the installed copies");
  else print(`   ${command.map(shellWord).join(" ")}`);
  print("");
  print("4. Check");
  print("   In that session, `/core:kit-doctor` (or `kit doctor`) should list each plugin above as");
  print('   "loaded for this session with --plugin-dir"; one it does not list runs from the installed copy.');

  if (!parsed.run) return 0;
  if (plan.loaded.length === 0) {
    console.error("kit dev: --run has nothing to load from a checkout; start `claude` as usual.");
    return 1;
  }
  print("");
  print(`Starting: ${command.map(shellWord).join(" ")}`);
  const result = spawn(command[0], command.slice(1), { cwd: projectDir, stdio: "inherit" });
  if (result.error) {
    console.error(`kit dev: could not start claude: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
