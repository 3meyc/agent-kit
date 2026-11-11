// `kit doctor`: checks one project's kit set-up and prints a numbered report.
//
// 1. kit.json against the schema shipped with this plugin.
// 2. The plugins the project needs are enabled, and the marketplaces they come from are declared
//    in the project's `extraKnownMarketplaces`: an overlay's dependencies on the base kit resolve
//    only when both are declared (docs/spikes.md S3a). Plugins this session loaded with
//    `--plugin-dir` are listed, and every enabled or loaded plugin's `dependencies` are checked.
//    A marketplace this machine registered, or the user's settings declare, at another ref than
//    the project declares is a warning: plugins install from the registered ref. A kit repo's own
//    marketplace and plugins (its `.claude-plugin/marketplace.json`) need no declaration there.
// 3. Copies of kit-owned files in the repo, which shadow or duplicate the kit, and tests of
//    kit-owned scripts, which go with them.
// 4. Installed kit plugins against the commit their channel's ref points at on the remote now
//    (S8), with the update commands. The remote is read every time; a cached SHA is used only
//    when the read fails, and is reported as such. The copy a session here loads is named (S11),
//    and so is every project-scope copy of this repository that differs from the user copy or the
//    channel, with `kit installs --clean` to clear it; stale copies elsewhere are counted. Only the
//    plugins the project enables, or that come from a marketplace it declares, are checked.
// Section 2 also names an enabled plugin this machine has not installed (not in strict mode), and
// a worktree nested in another checkout's `.claude/worktrees/` whose `.claude/` differs from that
// checkout's, since sessions there read the outer one.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CORE_ROOT, enabledForProject, findKitCopies, ownMarketplace, pluginDependencies, pluginRoots, sessionPluginDirs } from "./kit-owned.mjs";
import { KIT_FILE } from "../lib/kit-config.mjs";
import { validate } from "./schema-check.mjs";
import { surveyInstalls, tilde } from "./installs.mjs";
import { checkUpdates, claudeDir, defaultCacheFile, readPluginState, recordApplies, repoRoot, samePath, sourceRef, splitId, updateCommands } from "./update-check.mjs";

export const BASE_MARKETPLACE = "agent-kit";

function readJson(file) {
  if (!existsSync(file)) return { missing: true };
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function loadSchema() {
  return JSON.parse(readFileSync(join(CORE_ROOT, "schema", "kit.schema.json"), "utf8"));
}

/** Findings for kit.json: `{ level: "ok" | "warn" | "fail", text }`. */
export function checkKitJson(projectDir, schema = loadSchema()) {
  const file = readJson(join(projectDir, KIT_FILE));
  if (file.missing) return { config: null, findings: [{ level: "fail", text: `no ${KIT_FILE} at the repo root; \`/kit-adopt\` writes a starter` }] };
  if (file.error) return { config: null, findings: [{ level: "fail", text: `${KIT_FILE} does not parse: ${file.error}` }] };
  const findings = [];
  for (const error of validate(file.value, schema)) {
    findings.push({ level: "fail", text: `${KIT_FILE} ${error.path}: ${error.message}` });
  }
  if (findings.every((finding) => finding.level !== "fail")) findings.unshift({ level: "ok", text: `${KIT_FILE} matches the schema` });
  return { config: file.value, findings };
}

/** The plugins this project needs from the base kit, with the reason. */
export function neededPlugins(config) {
  const needed = [{ id: `core@${BASE_MARKETPLACE}`, why: "always" }];
  if (config?.ledger === true) needed.push({ id: `session@${BASE_MARKETPLACE}`, why: "kit.json ledger: true" });
  return needed;
}

/**
 * Findings for enabled plugins and declared marketplaces. `repoOnly` (strict mode) judges the
 * needed plugins by the shared `.claude/settings.json` alone, as a CI checkout has it: a plugin
 * enabled only in `settings.local.json` or the user's settings then fails.
 * @param {string} projectDir @param {Record<string, any> | null} config @param {string} [userDir]
 * @param {{ repoOnly?: boolean }} [options]
 */
export function checkSettings(projectDir, config, userDir = claudeDir(), { repoOnly = false } = {}) {
  const findings = [];
  const shared = readJson(join(projectDir, ".claude", "settings.json"));
  if (shared.error) return [{ level: "fail", text: `.claude/settings.json does not parse: ${shared.error}` }];
  const project = shared.value ?? {};
  const local = repoOnly ? {} : (readJson(join(projectDir, ".claude", "settings.local.json")).value ?? {});
  const user = readJson(join(userDir, "settings.json")).value ?? {};
  const declared = new Set(Object.keys(project.extraKnownMarketplaces ?? {}));
  const enabledIn = (settings, id) => settings.enabledPlugins?.[id] === true;
  // The repo a marketplace comes from runs its plugins from the working tree (`--plugin-dir`,
  // docs/changing.md), so it neither declares that marketplace nor enables those plugins.
  const own = ownMarketplace(projectDir);
  const ownPlugin = (id) => {
    const name = splitId(id);
    return name && own?.name === name.marketplace && own.plugins.has(name.plugin) ? own.plugins.get(name.plugin) : null;
  };

  for (const { id, why } of neededPlugins(config)) {
    if (enabledIn(project, id)) findings.push({ level: "ok", text: `${id} enabled in .claude/settings.json` });
    else if (ownPlugin(id)) findings.push({ level: "ok", text: `${id} is this repo's own plugin (${ownPlugin(id)}), tried from the working tree with --plugin-dir; .claude/settings.json need not enable it` });
    else if (!repoOnly && (enabledIn(local, id) || enabledIn(user, id))) {
      findings.push({ level: "warn", text: `${id} (${why}) is enabled only for you (${enabledIn(local, id) ? "settings.local.json" : "user settings"}); add it to .claude/settings.json so the project gets it` });
    } else findings.push({ level: "fail", text: `${id} (${why}) is not enabled; add it to enabledPlugins in .claude/settings.json` });
    if (local.enabledPlugins?.[id] === false) {
      findings.push({ level: "warn", text: `${id} is switched off in settings.local.json` });
    }
  }

  const marketplaces = new Set(
    Object.entries(project.enabledPlugins ?? {})
      .filter(([, on]) => on === true)
      .map(([id]) => id.slice(id.lastIndexOf("@") + 1))
      .filter(Boolean),
  );
  marketplaces.add(BASE_MARKETPLACE);
  const overlays = [...marketplaces].filter((name) => name !== BASE_MARKETPLACE);
  for (const name of [...marketplaces].sort()) {
    if (declared.has(name)) findings.push({ level: "ok", text: `marketplace ${name} declared in extraKnownMarketplaces` });
    else if (own?.name === name) findings.push({ level: "ok", text: `marketplace ${name} is this repo's own (.claude-plugin/marketplace.json), so it is not declared here` });
    else {
      const why = name === BASE_MARKETPLACE && overlays.length > 0 ? `; overlay dependencies (${overlays.join(", ")}) resolve only with it (S3a)` : "";
      findings.push({ level: "fail", text: `marketplace ${name} is not declared in .claude/settings.json extraKnownMarketplaces${why}` });
    }
  }
  findings.push(...checkMarketplaceRefs(project.extraKnownMarketplaces ?? {}, user.extraKnownMarketplaces ?? {}, readPluginState(userDir).marketplaces));
  return findings;
}

const refLabel = (source) => (typeof source?.ref === "string" && source.ref ? `ref ${source.ref}` : "no ref (HEAD)");

/** `owner/repo#ref` for a GitHub source, the argument `claude plugin marketplace add` takes. */
function addArgument(source, ref) {
  return source?.source === "github" && typeof source.repo === "string" ? `${source.repo}#${ref}` : null;
}

/**
 * Warnings for each marketplace the project declares at a ref that this machine's registration
 * (`known_marketplaces.json`) or the user's own `extraKnownMarketplaces` does not match. Plugins
 * install from the registered ref, and `claude plugin marketplace add <repo>#<ref>` is refused
 * while the user's own declaration of that marketplace names another source.
 * @param {Record<string, any>} project @param {Record<string, any>} user @param {Record<string, any>} registered
 */
export function checkMarketplaceRefs(project, user, registered) {
  const findings = [];
  for (const [name, entry] of Object.entries(project).sort(([a], [b]) => a.localeCompare(b))) {
    const source = entry?.source;
    if (typeof source?.ref !== "string" || !source.ref) continue;
    const want = source.ref;
    const add = addArgument(source, want);
    const addHint = add ? `\`claude plugin marketplace add ${add}\`` : `re-add the marketplace at ${want}`;
    const userSource = user[name]?.source;
    const userStale = userSource && sourceRef(userSource) !== want;
    if (userStale) {
      findings.push({
        level: "warn",
        text: `marketplace ${name}: your user settings.json declares it with ${refLabel(userSource)}, the project with ref ${want}; add "ref": "${want}" to that entry, then run ${addHint} (docs/using.md § 3)`,
      });
    }
    const machine = registered[name]?.source;
    if (machine && sourceRef(machine) !== want) {
      findings.push({
        level: "warn",
        text: `marketplace ${name} is registered on this machine with ${refLabel(machine)}, the project declares ref ${want}; plugins install from the registered ref. ${userStale ? "After the user settings fix, run" : "Run"} ${addHint}, then \`claude plugin update\` each plugin at each scope (docs/using.md § 3)`,
      });
    }
  }
  return findings;
}

/**
 * Findings for plugins this session loaded with `--plugin-dir`, and for the `dependencies` of every
 * plugin that is enabled in some settings file or loaded that way. A dependency is met by an
 * enabled plugin of that name (and marketplace, when the entry or the depending install names one)
 * or by a loaded one.
 * @param {string} projectDir @param {Array<{ root: string, name: string, source: string, id?: string }>} plugins
 * @param {string} [userDir]
 */
export function checkLoadedPlugins(projectDir, plugins, userDir = claudeDir()) {
  const findings = [];
  const settings = [
    readJson(join(projectDir, ".claude", "settings.json")).value ?? {},
    readJson(join(projectDir, ".claude", "settings.local.json")).value ?? {},
    readJson(join(userDir, "settings.json")).value ?? {},
  ];
  const enabled = new Set();
  for (const file of settings) {
    for (const [id, on] of Object.entries(file.enabledPlugins ?? {})) if (on === true) enabled.add(id);
  }
  const loaded = plugins.filter((plugin) => plugin.source === "session");
  for (const plugin of loaded) findings.push({ level: "ok", text: `${plugin.name} loaded for this session with --plugin-dir (${plugin.root})` });
  // The core plugin running this check is loaded too, however it got here.
  const loadedNames = new Set(plugins.filter((plugin) => plugin.source === "session" || plugin.source === "self").map((plugin) => plugin.name));
  const active = plugins.filter((plugin) => plugin.source === "session" || (plugin.id && enabled.has(plugin.id)));
  for (const plugin of active) {
    const ownMarketplace = plugin.id ? plugin.id.slice(plugin.id.lastIndexOf("@") + 1) : null;
    for (const dep of pluginDependencies(plugin.root)) {
      const marketplace = dep.marketplace ?? ownMarketplace;
      const met =
        loadedNames.has(dep.name) ||
        [...enabled].some((id) => id.slice(0, id.lastIndexOf("@")) === dep.name && (!marketplace || id.endsWith(`@${marketplace}`)));
      const want = marketplace ? `${dep.name}@${marketplace}` : dep.name;
      if (!met) findings.push({ level: "warn", text: `${plugin.name} needs ${want}, which is neither enabled nor loaded with --plugin-dir` });
    }
  }
  return findings;
}

/**
 * The plugins the project's `.claude/settings.json` and `settings.local.json` enable, by id, with
 * the file that enables each; a local `false` takes one back.
 * @param {string} projectDir @returns {Map<string, string>}
 */
function projectEnabled(projectDir) {
  const enabled = new Map();
  for (const file of ["settings.json", "settings.local.json"]) {
    for (const [id, on] of Object.entries(readJson(join(projectDir, ".claude", file)).value?.enabledPlugins ?? {})) {
      if (on === true) enabled.set(id, `.claude/${file}`);
      else if (on === false) enabled.delete(id);
    }
  }
  return enabled;
}

/**
 * Whether the project cares about an installed plugin: one its settings enable, or one from a
 * marketplace it declares. A project whose settings name neither cares about every plugin.
 * @param {string} projectDir @returns {(plugin: string, marketplace: string) => boolean}
 */
export function projectPluginFilter(projectDir) {
  const enabled = projectEnabled(projectDir);
  const declared = new Set(Object.keys(readJson(join(projectDir, ".claude", "settings.json")).value?.extraKnownMarketplaces ?? {}));
  if (enabled.size === 0 && declared.size === 0) return () => true;
  return (plugin, marketplace) => enabled.has(`${plugin}@${marketplace}`) || declared.has(marketplace);
}

/**
 * One warning per plugin the project enables that this machine has not installed for it (no user
 * record, no project record of this repository) and no `--plugin-dir` loads: sessions here then
 * run without it, which an enabled-only check misses.
 * @param {string} projectDir @param {ReturnType<typeof readPluginState>} state @param {Set<string>} loadedNames
 */
export function checkInstalled(projectDir, state, loadedNames = new Set()) {
  const enabled = projectEnabled(projectDir);
  const keys = new Map();
  const findings = [];
  for (const [id, where] of [...enabled].sort(([a], [b]) => a.localeCompare(b))) {
    const name = splitId(id);
    if (!name || loadedNames.has(name.plugin)) continue;
    const entries = state.installed[id];
    if (Array.isArray(entries) && entries.some((entry) => recordApplies(entry, projectDir, keys))) continue;
    findings.push({
      level: "warn",
      text: `${id} is enabled in ${where} but not installed on this machine, so sessions here run without it; install it at user scope: \`claude plugin install ${id} --scope user\` (docs/using.md § 1)`,
    });
  }
  if (enabled.size > 0 && findings.length === 0) findings.push({ level: "ok", text: `every enabled plugin (${enabled.size}) is installed on this machine or loaded with --plugin-dir` });
  return findings;
}

/** The checkout a worktree at `<checkout>/.claude/worktrees/<name>` sits in, or null. @param {string} dir */
export function outerCheckout(dir) {
  const match = /^(.*)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/.exec(resolve(dir));
  return match && existsSync(join(match[1], ".git")) ? match[1] : null;
}

/** JSON with sorted keys, so two files that differ only in key order compare equal. @param {unknown} value */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(/** @type {any} */ (value)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What differs between two checkouts' `.claude/`: the shared settings, and the entries of its skill, agent, command and rule folders. */
function claudeDirDiffs(outer, inner) {
  const diffs = [];
  const settings = (dir) => {
    const file = readJson(join(dir, ".claude", "settings.json"));
    return file.value === undefined ? (file.missing ? "missing" : "unreadable") : canonical(file.value);
  };
  if (settings(outer) !== settings(inner)) diffs.push(".claude/settings.json");
  for (const folder of ["skills", "agents", "commands", "rules"]) {
    const names = (dir) => {
      try {
        return new Set(readdirSync(join(dir, ".claude", folder)));
      } catch {
        return new Set();
      }
    };
    const [a, b] = [names(outer), names(inner)];
    const changed = [...[...b].filter((name) => !a.has(name)).map((name) => `+${name}`), ...[...a].filter((name) => !b.has(name)).map((name) => `-${name}`)];
    if (changed.length > 0) diffs.push(`.claude/${folder} ${changed.sort().join(" ")}`);
  }
  return diffs;
}

/** The git top level of `cwd`, or null outside git. @param {string} cwd */
function gitTopLevel(cwd) {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return top.status === 0 && top.stdout.trim() ? resolve(top.stdout.trim()) : null;
}

/**
 * A finding for a worktree nested in another checkout's `.claude/worktrees/` (the desktop app's
 * default), found from the project or from the shell's own checkout, which differ when the session's
 * project is the outer checkout. Sessions in such a worktree read the outer checkout's `.claude/`
 * settings, skills and hooks (seen with the desktop app, which passes the main checkout as the
 * project's config root), so a branch that changes its `.claude/` is not what runs there.
 * @param {string} projectDir @param {string} [cwd]
 */
export function checkNestedWorktree(projectDir, cwd = process.cwd()) {
  const top = gitTopLevel(cwd);
  const inner = [top, projectDir].find((dir) => dir && outerCheckout(dir));
  if (!inner) return [];
  const outer = /** @type {string} */ (outerCheckout(inner));
  const reading = samePath(projectDir, outer) ? ` This report reads ${tilde(outer)}, the session's project, not the worktree.` : "";
  const diffs = claudeDirDiffs(outer, inner);
  if (diffs.length === 0) return [{ level: "ok", text: `worktree inside ${tilde(outer)}/.claude/worktrees/; its .claude/ matches the outer checkout's, which sessions here read${reading}` }];
  return [{
    level: "warn",
    text: `worktree inside ${tilde(outer)}/.claude/worktrees/: sessions here read the outer checkout's .claude/ settings, skills and hooks, which differ from this branch's (${diffs.join("; ")}). Plugins, hooks or skills this branch changes do not apply here; start the session in a clone or a worktree outside the checkout, or land the branch first.${reading}`,
  }];
}

/**
 * One finding per copy of a kit-owned file: a warning, or a failure in strict mode, which also
 * reads only the shared settings for which plugins the project enables.
 * @param {string} projectDir @param {{ strict?: boolean }} [options]
 */
export function checkCopies(projectDir, plugins = pluginRoots(projectDir), { strict = false } = {}) {
  const copies = findKitCopies(projectDir, enabledForProject(projectDir, plugins, { local: !strict }));
  if (copies.length === 0) return [{ level: "ok", text: "no copies of kit-owned files" }];
  return copies.map((copy) => ({
    level: strict ? "fail" : "warn",
    text: `${copy.path} — supplied by ${copy.plugin}${copy.note ? ` (${copy.note})` : ""}`,
  }));
}

function age(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** How a finding names one install record. */
function copyLabel(item) {
  const id = `${item.plugin}@${item.marketplace}`;
  if (item.scope === "user" || item.scope === "managed") return `${id} (${item.scope})`;
  return `${id} (${item.scope}-scope copy for ${item.own ? "this folder" : tilde(item.projectPath)})`;
}

/**
 * Findings for installed kit plugins against their channel. The remote is read now (`fresh`); a
 * cached SHA stands in only when that read fails, and the finding says so. The copy a session in
 * `projectDir` loads and the user copy are checked against the channel; the other project-scope
 * copies of this repository are reported when they differ from the user copy or the channel.
 */
export function checkVersions(projectDir, options = {}) {
  const now = options.now ?? Date.now();
  const wanted = projectPluginFilter(projectDir);
  /** @type {Set<string>} */
  const skipped = new Set();
  const include = (plugin, marketplace) => wanted(plugin, marketplace) || (skipped.add(`${plugin}@${marketplace}`), false);
  const { checked } = checkUpdates({ root: projectDir, cacheFile: defaultCacheFile(), fresh: true, now, include, ...options });
  const findings = [];
  const of = (item) => (item.source ? ` of the plugin's own source ${item.source}` : "");
  const where = (item) => {
    if (item.from === "pinned") return "the commit its catalog entry pins";
    if (item.from === "cache") return `the remote could not be read; a cached ${item.ref}${of(item)} from ${age(now - (item.cachedAt ?? now))} ago`;
    return `${item.ref}${of(item)} on the remote`;
  };
  for (const item of checked) {
    const label = copyLabel(item);
    if (!item.loaded && item.scope !== "user") {
      const behindUser = item.userInstalled !== null && item.installed !== item.userInstalled;
      const behindRef = item.latest !== null && item.installed !== item.latest;
      if (!behindUser && !behindRef) continue;
      const against = [behindUser ? `the user copy ${item.userInstalled.slice(0, 12)}` : null, behindRef ? `${item.ref} ${item.latest.slice(0, 12)}` : null].filter(Boolean).join(" and ");
      findings.push({
        level: "warn",
        text: `${label}: ${item.installed.slice(0, 12)} differs from ${against}. Sessions here don't load it, but \`claude plugin update\` without \`--scope user\` may update it instead of the user copy; clear it with \`kit installs --clean\` (docs/using.md § 3)`,
      });
      continue;
    }
    const shadow = item.loaded && item.scope !== "user" ? `; sessions here load this copy instead of the user copy${item.userInstalled ? ` (${item.userInstalled.slice(0, 12)})` : ""}, because its install record comes first (S11)` : "";
    if (item.latest === null) findings.push({ level: "warn", text: `${label}: could not read ${item.ref} from the remote, and nothing is cached; the installed version is unchecked${shadow}` });
    else if (item.latest === item.installed && (item.from === "remote" || item.from === "pinned")) findings.push({ level: shadow ? "warn" : "ok", text: `${label} is at ${item.from === "pinned" ? "the commit its catalog entry pins" : item.ref} ${item.installed.slice(0, 12)} (${item.from === "pinned" ? "pinned" : "read from the remote"}${item.source ? `, plugin source ${item.source}` : ""})${shadow}${shadow ? "; `kit installs --clean` clears it once the user copy is current" : ""}` });
    else if (item.latest === item.installed) findings.push({ level: "warn", text: `${label}: ${where(item)} matches the installed ${item.installed.slice(0, 12)}; not proof that it is current${shadow}` });
    else {
      const refFirst = item.registeredRef !== item.ref ? ` This machine registered ${item.marketplace} at ${item.registeredRef}, so fix the marketplace ref first (section 2).` : "";
      findings.push({
        level: "warn",
        text: `${label}: installed ${item.installed.slice(0, 12)}, ${where(item)} is ${item.latest.slice(0, 12)}${shadow}; run \`${updateCommands(item).join("` then `")}\`, then start a new session.${refFirst}`,
      });
    }
  }
  if (checked.length === 0) findings.push({ level: "ok", text: "no kit plugins installed from a git marketplace (a --plugin-dir copy is not checked)" });
  if (skipped.size > 0) findings.push({ level: "ok", text: `not checked: ${[...skipped].sort().join(", ")}, which this project neither enables nor declares the marketplace of` });
  const repo = repoRoot(projectDir);
  const elsewhere = surveyInstalls({ state: options.state ?? readPluginState() }).filter(
    (copy) => copy.stale && !(repo ? copy.repo === repo : samePath(copy.projectPath, projectDir)),
  );
  if (elsewhere.length > 0) {
    const folders = new Set(elsewhere.map((copy) => copy.projectPath)).size;
    findings.push({ level: "warn", text: `${elsewhere.length} project-scope copies of kit plugins in ${folders} other folder(s) differ from their user copy; \`kit installs\` lists them, \`kit installs --clean\` clears them` });
  }
  return findings;
}

const MARK = { ok: "ok  ", warn: "WARN", fail: "FAIL" };

/** Machine-state findings never fail strict mode: a failure among them is printed as a warning. */
const machineOnly = (findings) => findings.map((finding) => (finding.level === "fail" ? { ...finding, level: "warn" } : finding));

/**
 * Run every check and print the report; exit code 1 when anything failed.
 *
 * `strict` judges the repo, not this machine, so CI gets the same answer: a copy of a kit-owned
 * file fails, the needed plugins and the plugins whose files count are read from the shared
 * `.claude/settings.json` alone, and the findings about this session's plugins and installed
 * versions never fail. `pluginRoots` are extra plugin folders to read ownership from (an overlay's
 * plugins in CI, where nothing is installed); `state`, `sessionDirs` and `userDir` are for tests.
 * @param {string} projectDir
 * @param {{ offline?: boolean, strict?: boolean, pluginDirs?: string[], pluginRoots?: string[], print?: (line: string) => void, state?: ReturnType<typeof readPluginState>, sessionDirs?: string[], userDir?: string, cwd?: string }} [options]
 */
export function runDoctor(projectDir, options = {}) {
  const { offline = false, strict = false, pluginDirs = [], print = console.log, userDir = claudeDir() } = options;
  const state = options.state ?? readPluginState(userDir);
  const sessionDirs = options.sessionDirs ?? sessionPluginDirs({ extra: pluginDirs, cwd: projectDir });
  const { config, findings: kit } = checkKitJson(projectDir);
  const plugins = pluginRoots(projectDir, state, sessionDirs, options.pluginRoots ?? []);
  const loaded = checkLoadedPlugins(projectDir, plugins, userDir);
  const loadedNames = new Set(plugins.filter((plugin) => plugin.source === "session").map((plugin) => plugin.name));
  // CI installs nothing, so strict mode leaves the installed check out rather than warn on every plugin.
  const nested = checkNestedWorktree(projectDir, options.cwd ?? projectDir);
  const machine = strict ? machineOnly([...loaded, ...nested]) : [...loaded, ...checkInstalled(projectDir, state, loadedNames), ...nested];
  const versions = offline ? [{ level: "ok", text: "skipped (--offline)" }] : checkVersions(projectDir, { state });
  const sections = [
    ["kit.json", kit],
    ["Plugins and marketplaces", [...checkSettings(projectDir, config, userDir, { repoOnly: strict }), ...machine]],
    ["Kit-owned files in the repo", checkCopies(projectDir, plugins, { strict })],
    ["Installed versions", strict ? machineOnly(versions) : versions],
  ];
  if (strict) print("Strict mode: repo state only. Copies of kit-owned files fail; installed versions and install scopes never do.");
  let failed = 0;
  sections.forEach(([title, findings], index) => {
    print(`${index + 1}. ${title}`);
    findings.forEach((finding, n) => {
      if (finding.level === "fail") failed += 1;
      print(`   ${index + 1}.${n + 1}. ${MARK[finding.level]} ${finding.text}`);
    });
  });
  if (strict) print(failed === 0 ? "Strict: passed." : `Strict: ${failed} finding(s) failed.`);
  return failed > 0 ? 1 : 0;
}
