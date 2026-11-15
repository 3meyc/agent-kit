/**
 * Whether the user or the project already runs a hook command themselves, in their own settings.
 *
 * The `rtk-rewrite` and `codegraph-prompt` hooks wrap a machine tool's own Claude Code hook
 * (`rtk hook claude`, `codegraph prompt-hook`), which those tools' installers write into
 * `~/.claude/settings.json`. When such an entry is still there the kit hook stands aside, so the
 * tool never runs twice on one call.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The settings files whose hooks Claude Code merges for a session in `root`: the user's, the
 * project's and the project's local one.
 * @param {string | null} root @param {string} [home]
 */
export function settingsFiles(root, home = homedir()) {
  const files = [join(home, ".claude", "settings.json")];
  if (root) files.push(join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json"));
  return files;
}

/**
 * Every hook `command` in one parsed settings object.
 * @param {unknown} settings
 * @returns {string[]}
 */
export function hookCommands(settings) {
  const events = /** @type {{ hooks?: unknown }} */ (settings)?.hooks;
  if (!events || typeof events !== "object") return [];
  const commands = [];
  for (const groups of Object.values(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof hook?.command === "string") commands.push(hook.command);
      }
    }
  }
  return commands;
}

/**
 * Whether any of `files` holds a hook command matching `pattern`. A missing or unreadable file
 * counts as holding none.
 * @param {RegExp} pattern @param {string[]} files @param {(path: string) => string} [read]
 */
export function ownHookPresent(pattern, files, read = (path) => readFileSync(path, "utf8")) {
  for (const file of files) {
    let settings;
    try {
      settings = JSON.parse(read(file));
    } catch {
      continue;
    }
    if (hookCommands(settings).some((command) => pattern.test(command))) return true;
  }
  return false;
}
