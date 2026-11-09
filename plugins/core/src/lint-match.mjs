// Helpers for the `lint-edited-file` hook: which edited files `kit.json` `lintOnEdit.match` selects,
// and the shell command for one file. The kit.json reader itself is `lib/kit-config.mjs`.
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
