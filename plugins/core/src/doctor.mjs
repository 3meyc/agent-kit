// `kit doctor`: checks one project's kit set-up and prints a numbered report.
//
// 1. kit.json against the schema shipped with this plugin.
// 2. The plugins the project needs are enabled, and the marketplaces they come from are declared
//    in the project's `extraKnownMarketplaces`: an overlay's dependencies on the base kit resolve
//    only when both are declared (docs/spikes.md S3a). Plugins this session loaded with
//    `--plugin-dir` are listed, and every enabled or loaded plugin's `dependencies` are checked.
//    A marketplace this machine registered, or the user's settings declare, at another ref than
//    the project declares is a warning: plugins install from the registered ref.
// 3. Copies of kit-owned files in the repo, which shadow or duplicate the kit, and tests of
//    kit-owned scripts, which go with them.
// 4. Installed kit plugins against the commit their channel's ref points at on the remote now
//    (S8), with the update commands. The remote is read every time; a cached SHA is used only
//    when the read fails, and is reported as such. The copy a session here loads is named (S11),
//    and so is every project-scope copy of this repository that differs from the user copy or the
//    channel, with `kit installs --clean` to clear it; stale copies elsewhere are counted.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_ROOT, enabledForProject, findKitCopies, pluginDependencies, pluginRoots, sessionPluginDirs } from "./kit-owned.mjs";
import { KIT_FILE } from "../lib/kit-config.mjs";
import { validate } from "./schema-check.mjs";
import { surveyInstalls, tilde } from "./installs.mjs";
import { checkUpdates, claudeDir, defaultCacheFile, readPluginState, repoRoot, samePath, sourceRef, updateCommands } from "./update-check.mjs";

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
 * Findings for enabled plugins and declared marketplaces.
 * @param {string} projectDir @param {Record<string, any> | null} config @param {string} [userDir]
 */
export function checkSettings(projectDir, config, userDir = claudeDir()) {
  const findings = [];
  const shared = readJson(join(projectDir, ".claude", "settings.json"));
  if (shared.error) return [{ level: "fail", text: `.claude/settings.json does not parse: ${shared.error}` }];
  const project = shared.value ?? {};
  const local = readJson(join(projectDir, ".claude", "settings.local.json")).value ?? {};
  const user = readJson(join(userDir, "settings.json")).value ?? {};
  const declared = new Set(Object.keys(project.extraKnownMarketplaces ?? {}));
  const enabledIn = (settings, id) => settings.enabledPlugins?.[id] === true;

  for (const { id, why } of neededPlugins(config)) {
    if (enabledIn(project, id)) findings.push({ level: "ok", text: `${id} enabled in .claude/settings.json` });
    else if (enabledIn(local, id) || enabledIn(user, id)) {
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

export function checkCopies(projectDir, plugins = pluginRoots(projectDir)) {
  const copies = findKitCopies(projectDir, enabledForProject(projectDir, plugins));
  if (copies.length === 0) return [{ level: "ok", text: "no copies of kit-owned files" }];
  return copies.map((copy) => ({
    level: "warn",
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
  const { checked } = checkUpdates({ root: projectDir, cacheFile: defaultCacheFile(), fresh: true, now, ...options });
  const findings = [];
  const where = (item) => (item.from === "cache" ? `the remote could not be read; a cached ${item.ref} from ${age(now - (item.cachedAt ?? now))} ago` : `${item.ref} on the remote`);
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
    else if (item.latest === item.installed && item.from === "remote") findings.push({ level: shadow ? "warn" : "ok", text: `${label} is at ${item.ref} ${item.installed.slice(0, 12)} (read from the remote)${shadow}${shadow ? "; `kit installs --clean` clears it once the user copy is current" : ""}` });
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

/** Run every check and print the report; exit code 1 when anything failed. */
export function runDoctor(projectDir, { offline = false, pluginDirs = [], print = console.log } = {}) {
  const { config, findings: kit } = checkKitJson(projectDir);
  const plugins = pluginRoots(projectDir, readPluginState(), sessionPluginDirs({ extra: pluginDirs, cwd: projectDir }));
  const sections = [
    ["kit.json", kit],
    ["Plugins and marketplaces", [...checkSettings(projectDir, config), ...checkLoadedPlugins(projectDir, plugins)]],
    ["Kit-owned files in the repo", checkCopies(projectDir, plugins)],
    ["Installed versions", offline ? [{ level: "ok", text: "skipped (--offline)" }] : checkVersions(projectDir)],
  ];
  let failed = false;
  sections.forEach(([title, findings], index) => {
    print(`${index + 1}. ${title}`);
    findings.forEach((finding, n) => {
      if (finding.level === "fail") failed = true;
      print(`   ${index + 1}.${n + 1}. ${MARK[finding.level]} ${finding.text}`);
    });
  });
  return failed ? 1 : 0;
}
