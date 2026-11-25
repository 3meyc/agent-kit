// Helpers for the `lint-edited-file` hook: which edited files `kit.json` `lintOnEdit.match` selects,
// and the shell command for one file. The kit.json reader itself is `lib/kit-config.mjs`.
export { globMatcher, matchesAny } from "../lib/globs.mjs";

/** POSIX-shell single quoting for one argument. */
export function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * cmd.exe double quoting for one argument (a Windows file name cannot hold `"`). Bare only when it
 * holds none of the characters cmd or a `.cmd` shim treats specially (`%`, `=`, `,`, `;`, space…).
 */
export function cmdQuote(value) {
  return /^[A-Za-z0-9_./:\\@+-]+$/.test(value) ? value : `"${value}"`;
}

/**
 * The command with `{file}` replaced by the quoted path, or the quoted path appended when absent.
 * Quoted for the shell `spawnSync(..., { shell: true })` runs it in: cmd.exe on Windows, sh elsewhere.
 */
export function withFile(command, file, platform = process.platform) {
  const quoted = platform === "win32" ? cmdQuote(file) : shellQuote(file);
  return command.includes("{file}") ? command.replaceAll("{file}", quoted) : `${command} ${quoted}`;
}
