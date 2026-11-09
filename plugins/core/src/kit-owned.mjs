// Which project files a kit plugin supplies, and which of them a project still keeps a copy of.
// Used by `kit doctor` (a copy shadows or duplicates the kit) and `kit adopt` (what to retire).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPluginState } from "./update-check.mjs";

export const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pluginName(root) {
  return readJson(join(root, ".claude-plugin", "plugin.json"))?.name ?? basename(root);
}

/**
 * Plugin folders to read ownership from: this plugin, every plugin installed for the project
 * (overlays may ship a `kit-owned.json` too), and, when this plugin runs from a kit checkout
 * (`--plugin-dir`), its sibling plugins.
 * @param {string | null} projectDir
 */
export function pluginRoots(projectDir, state = readPluginState()) {
  const roots = new Map([[CORE_ROOT, pluginName(CORE_ROOT)]]);
  for (const entries of Object.values(state.installed)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const scoped = entry.scope === "user" || entry.scope === "managed" || entry.projectPath === projectDir;
      if (scoped && typeof entry.installPath === "string" && existsSync(entry.installPath)) {
        const name = pluginName(entry.installPath);
        if (![...roots.values()].includes(name)) roots.set(entry.installPath, name);
      }
    }
  }
  const pluginsDir = dirname(CORE_ROOT);
  if (existsSync(join(pluginsDir, "..", ".claude-plugin", "marketplace.json"))) {
    for (const name of readdirSync(pluginsDir)) {
      const root = join(pluginsDir, name);
      if (existsSync(join(root, ".claude-plugin", "plugin.json")) && ![...roots.values()].includes(pluginName(root))) {
        roots.set(root, pluginName(root));
      }
    }
  }
  return [...roots].map(([root, name]) => ({ root, name }));
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

/**
 * Kit-owned files and hook entries the project still has.
 * @param {string} projectDir @param {Array<{ root: string, name: string }>} [plugins]
 * @returns {Array<{ path: string, plugin: string, note: string | null }>}
 */
export function findKitCopies(projectDir, plugins = pluginRoots(projectDir)) {
  const found = [];
  const hooks = projectHookCommands(projectDir);
  for (const plugin of plugins) {
    const owned = ownedBy(plugin);
    for (const { path, note } of owned.files) {
      if (existsSync(join(projectDir, path))) found.push({ path, plugin: owned.plugin, note });
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
