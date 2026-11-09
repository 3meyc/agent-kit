// Helpers for the `lint-edited-file` hook: which edited files `kit.json` `lintOnEdit.match` selects,
// and the shell command for one file. The kit.json reader itself is `lib/kit-config.mjs`.
export { globMatcher, matchesAny } from "../lib/globs.mjs";

/** POSIX-shell single quoting for one argument. */
export function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command with `{file}` replaced by the quoted path, or the quoted path appended when absent. */
export function withFile(command, file) {
  const quoted = process.platform === "win32" ? `"${file}"` : shellQuote(file);
  return command.includes("{file}") ? command.replaceAll("{file}", quoted) : `${command} ${quoted}`;
}
