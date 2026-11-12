// GENERATED from shared/globs.mjs by scripts/vendor-shared.mjs. Edit shared/globs.mjs and run `npm run vendor`.
// Globs over repo-relative POSIX paths, as kit.json uses them (`lintOnEdit.match`,
// `preflight.<id>.match`). Node built-ins only.
/**
 * Glob → RegExp over repo-relative POSIX paths: `**` crosses folders, `*` and `?` do not, `{a,b}`
 * alternates. A pattern with no `/` matches the basename anywhere (as in .gitignore).
 * @param {string} glob
 */
export function globMatcher(glob) {
  const anywhere = !glob.includes("/");
  return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${globSource(glob, true)}$`);
}

/**
 * RegExp source of one glob. Each `{…}` part goes through the same `**`, `*` and `?` conversion
 * (`{*.ts,*.svelte}`); braces do not nest, so inside one a `{` is literal.
 * @param {string} glob @param {boolean} braces
 */
function globSource(glob, braces) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (braces && char === "{" && glob.indexOf("}", i) > i) {
      const end = glob.indexOf("}", i);
      source += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map((part) => globSource(part, false))
        .join("|")})`;
      i = end;
    } else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return source;
}

/** Whether a repo-relative path matches any of the globs (true for an empty list). */
export function matchesAny(path, globs) {
  return globs.length === 0 || globs.some((glob) => globMatcher(glob).test(path));
}
