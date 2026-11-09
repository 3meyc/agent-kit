// Reads a project's kit.json for the core plugin's hooks, skills and bin commands. Node built-ins
// only. Every reader is forgiving: a missing or broken kit.json means "no settings", never a
// crash, because a hook that throws must not block the tool call it runs beside.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KIT_FILE = "kit.json";

/**
 * The parsed kit.json at `root`, or null when there is none. A file that does not parse is
 * reported once on stderr (the hooks' only channel that never reaches the model as context) and
 * read as absent.
 * @param {string} root
 * @returns {Record<string, any> | null}
 */
export function readKitConfig(root) {
  const file = join(root, KIT_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.error(`agent-kit: ${KIT_FILE} does not parse (${error instanceof Error ? error.message : error})`);
    return null;
  }
}

/**
 * Whether the project switched a kit hook off through `hooks.off` (docs/spikes.md S5b: a plugin
 * cannot be switched off hook by hook, so each hook asks).
 * @param {Record<string, any> | null} config @param {string} id
 */
export function hookOff(config, id) {
  const off = config?.hooks?.off;
  return Array.isArray(off) && off.includes(id);
}

/** `commands.<name>` as a non-empty string, or null. */
export function kitCommand(config, name) {
  const value = config?.commands?.[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The per-file lint command for the `lint-edited-file` hook: `lintOnEdit.command`, with the file
 * matched against `lintOnEdit.match` (globs; none means every file). Proposed kit.json field,
 * not yet in schema v1 (see README).
 * @returns {{ command: string, match: string[] } | null}
 */
export function lintOnEdit(config) {
  const entry = config?.lintOnEdit;
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.command !== "string" || entry.command.trim() === "") return null;
  const match = Array.isArray(entry.match) ? entry.match.filter((item) => typeof item === "string") : [];
  return { command: entry.command, match };
}

/**
 * Glob → RegExp over repo-relative POSIX paths: `**` crosses folders, `*` and `?` do not, `{a,b}`
 * alternates. A pattern with no `/` matches the basename anywhere (as in .gitignore).
 * @param {string} glob
 */
export function globMatcher(glob) {
  const anywhere = !glob.includes("/");
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{" && glob.indexOf("}", i) > i) {
      const end = glob.indexOf("}", i);
      source += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&"))
        .join("|")})`;
      i = end;
    } else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${source}$`);
}

/** Whether a repo-relative path matches any of the globs (true for an empty list). */
export function matchesAny(path, globs) {
  return globs.length === 0 || globs.some((glob) => globMatcher(glob).test(path));
}

/** POSIX-shell single quoting for one argument. */
export function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command with `{file}` replaced by the quoted path, or the quoted path appended when absent. */
export function withFile(command, file) {
  const quoted = process.platform === "win32" ? `"${file}"` : shellQuote(file);
  return command.includes("{file}") ? command.replaceAll("{file}", quoted) : `${command} ${quoted}`;
}
