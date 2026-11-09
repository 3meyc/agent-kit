// GENERATED from shared/shell-edits.mjs by scripts/vendor-shared.mjs. Edit shared/shell-edits.mjs and run `npm run vendor`.
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/**
 * Write targets of a shell command, for the shell hooks (`shell-deletions`), the CodeGraph sync
 * (`stripHeredocs`) and the session ledger's Stop hooks.
 *
 * An Edit/Write tool call names its file; a Bash or PowerShell call does not. This module reads
 * a command the way a reviewer would and reports three things:
 *
 * - `files`   — paths the command names for certain: redirect targets, `tee`, `sed -i`, `perl -pi`,
 *               `prettier --write a.ts` (also `$F` set to a path list), `mv`/`cp`/`rm`, `pnpm add` (manifest + lockfile),
 *               PowerShell `Set-Content`/`Out-File`/…, and string-literal paths inside
 *               `writeFileSync("…")` / `open("…", "w")` calls in inline scripts, or through a name
 *               the script assigned a literal (`p = "…"`, then `open(p, "w")`).
 * - `globs`   — patterns and directories the command writes into but which cannot be expanded
 *               without the file system (`prettier --write "src/…/*.ts"`, `eslint . --fix`).
 * - `opaque`  — the command runs something that may write anywhere: a script (`node x.mjs`,
 *               `pnpm run …`, `./tool.sh`), an installer, a tree-changing git operation, or a
 *               write whose target this parser cannot resolve (`sed -i … "$f"` in a loop,
 *               `sed -i … $(git grep -l …)`, `… | xargs sed -i …`).
 * - `removed` — paths and patterns a command deletes or moves away (`rm`, `git rm`, `mv` and
 *               `git mv` sources, `Remove-Item`, `rmSync("…")`). A deleted file has no mtime, so
 *               the run-window test cannot see it; this list is what attributes the deletion.
 *
 * The caller decides what to do with globs and opaque runs. The ledger attributes a dirty file to
 * a glob or an opaque command only when the file's mtime falls inside that command's run window,
 * so a neighbour session's edit in a shared working tree is not claimed. Paths are returned
 * absolute, resolved against the command's cwd (following a leading `cd dir &&`); the caller maps
 * them to the repo. Pure function, no file-system access; no shell is executed.
 *
 * Deliberately heuristic: a `$VAR` set earlier in the same command is expanded, other `$VAR`,
 * `$(…)` and `%X%` operands are unresolvable, quoting follows POSIX sh (or PowerShell when
 * `powershell: true`), and a redirect inside a here-doc body is text, not shell — bodies are cut
 * before tokenizing.
 */

/** Words that wrap another command and carry no write of their own. */
const WRAPPERS = new Set(["rtk", "sudo", "time", "nohup", "env", "command", "exec", "builtin", "pnpx", "bunx"]);

/** Shell keywords that may precede a command in a loop or a condition (`do sed -i …`, `then rm …`). */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);

/** Stands in for the operands `xargs` reads from stdin: unresolvable, so a writer fed by it is opaque. */
const XARGS_OPERAND = "$XARGS";

/** Package-manager subcommands that rewrite the manifest and the lockfile. */
const DEPENDENCY_SUBCOMMANDS = {
  pnpm: {
    sub: new Set([
      "add",
      "remove",
      "rm",
      "un",
      "uninstall",
      "install",
      "i",
      "update",
      "up",
      "upgrade",
      "dedupe",
      "link",
      "unlink",
      "import",
      "prune",
      "patch-commit",
    ]),
    lock: "pnpm-lock.yaml",
  },
  npm: {
    sub: new Set([
      "add",
      "install",
      "i",
      "in",
      "ins",
      "isntall",
      "uninstall",
      "unlink",
      "remove",
      "rm",
      "r",
      "un",
      "update",
      "up",
      "upgrade",
      "ci",
      "dedupe",
      "ddp",
      "prune",
      "link",
      "ln",
    ]),
    lock: "package-lock.json",
  },
  yarn: {
    sub: new Set(["add", "remove", "install", "up", "upgrade", "dedupe", "import", "link", "unlink"]),
    lock: "yarn.lock",
  },
  bun: { sub: new Set(["add", "remove", "rm", "install", "i", "update", "link", "unlink"]), lock: "bun.lock" },
};

/** Package-manager verbs whose argument is another command; the inner command is classified instead. */
const PM_EXEC_VERBS = new Set(["exec", "dlx", "x"]);

/** Package-manager subcommands that only read. */
const PM_READ_ONLY = new Set([
  "list",
  "ls",
  "ll",
  "la",
  "why",
  "outdated",
  "audit",
  "licenses",
  "root",
  "bin",
  "view",
  "info",
  "search",
  "help",
  "config",
  "env",
  "store",
]);

/** Interpreters, task runners and archive tools: they may write anywhere their input says. */
const OPAQUE_COMMANDS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "py",
  "bash",
  "sh",
  "zsh",
  "dash",
  "pwsh",
  "powershell",
  "cmd",
  "make",
  "patch",
  "unzip",
  "tar",
  "codegraph",
]);

/** git subcommands that change the working tree beyond the paths they name. */
const GIT_TREE_CHANGING = new Set([
  "apply",
  "am",
  "stash",
  "revert",
  "checkout",
  "switch",
  "restore",
  "reset",
  "clean",
]);

/**
 * git subcommands that bring in commits others made. What they write is that history, not this
 * session's edit, so they get no run window; a conflict the session then resolves is credited to
 * the resolving call. Each maps to the options that make the call opaque after all: a squash or
 * `cherry-pick -n` leaves the result for the session to commit as its own, `--autostash` rewrites
 * the session's dirty files, and `rebase --exec` runs a command of its own.
 */
const GIT_INTEGRATING = new Map([
  ["merge", /^--(squash|autostash)$/],
  ["pull", /^--(squash|autostash)$/],
  ["rebase", /^(-x|--exec(=.*)?|--autostash)$/],
  // `-n` bundled with cherry-pick's other value-less switches (`-nx`); `-S<key>` may hold an `n`.
  ["cherry-pick", /^(-[esx]*n[esx]*|--no-commit)$/],
]);

/** `git -c rebase.autoStash=true …`: autostash turned on for one call. Set in a config file, it goes unseen. */
const AUTOSTASH_CONFIG = /^(merge|rebase)\.autostash=(true|yes|on|1)$/i;

/** PowerShell parameters that take no value, so the next word is positional. */
const PS_SWITCHES = new Set([
  "force",
  "recurse",
  "whatif",
  "nonewline",
  "append",
  "noclobber",
  "passthru",
  "verbose",
  "debug",
  "container",
  "asbytestream",
  "raw",
  "stream",
]);

/** PowerShell cmdlets and their aliases that write or remove files. */
const PS_CMDLETS = new Map([
  ["out-file", "out-file"],
  ["tee-object", "out-file"],
  ["tee", "out-file"],
  ["set-content", "set-content"],
  ["sc", "set-content"],
  ["add-content", "set-content"],
  ["ac", "set-content"],
  ["new-item", "new-item"],
  ["ni", "new-item"],
  ["remove-item", "remove-item"],
  ["ri", "remove-item"],
  ["del", "remove-item"],
  ["erase", "remove-item"],
  ["rd", "remove-item"],
  ["rmdir", "remove-item"],
  ["copy-item", "copy-item"],
  ["cpi", "copy-item"],
  ["copy", "copy-item"],
  ["move-item", "move-item"],
  ["mi", "move-item"],
  ["move", "move-item"],
  ["rename-item", "rename-item"],
  ["rni", "rename-item"],
  ["ren", "rename-item"],
]);

/** String-literal paths written by inline Node/Python scripts (`node -e`, `node - <<EOF`, `python -c`). */
const FS_WRITE_CALLS =
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|outputFileSync|outputFile|truncateSync)\s*\(\s*(["'`])([^"'`$\n]+)\1/g;
const FS_REMOVE_CALLS = /\b(?:rmSync|rm|rmdirSync|unlinkSync|unlink|removeSync)\s*\(\s*(["'`])([^"'`$\n]+)\1/g;
const FS_MOVE_CALLS =
  /\b(?:renameSync|rename|copyFileSync|copyFile|cpSync)\s*\(\s*(["'`])([^"'`$\n]+)\1\s*,\s*(["'`])([^"'`$\n]+)\3/g;
const PY_OPEN_WRITE = /\bopen\s*\(\s*(["'])([^"'$\n]+)\1\s*,\s*(["'])[wax]/g;
const PY_PATH_WRITE = /\bPath\s*\(\s*(["'])([^"'$\n]+)\1\s*\)\s*\.write_(?:text|bytes)/g;
/** `p = "x.ts"` / `const p = 'x.ts'` in an inline script, so a write through `p` names its file. */
const SCRIPT_PATH_ASSIGN = /(?:^|[\s;(])(?:const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*=\s*(["'])([^"'$\n]+)\2/gm;
/**
 * Any assignment to a name (`p = …`, not `==`), a loop variable (`for p in`, `for (const p of`) or
 * a `with … as p` target, so a later non-literal value hides an earlier literal.
 */
const SCRIPT_ANY_ASSIGN =
  /(?:^|[\s;(])(?:const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*=(?!=)|\bfor\s*\(?\s*(?:const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s+(?:in|of)\b|\bas\s+([A-Za-z_]\w*)\b/gm;
const NAMED_WRITE_CALLS =
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|outputFileSync|outputFile|truncateSync)\s*\(\s*([A-Za-z_]\w*)\s*[,)]|\bopen\s*\(\s*([A-Za-z_]\w*)\s*,\s*(["'])[wax]/g;

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Cut here-doc bodies (`<<EOF … EOF`, `<<-'EOF'`, `<<"EOF"`) out of a command so their text is
 * not read as shell. The `<<EOF` operator and the rest of its line stay, so a trailing `> file`
 * on that line is still seen.
 * @param {string} command
 */
export function stripHeredocs(command) {
  const opener = /(?<!<)<<(?!<)-?\s*(["']?)([A-Za-z_][\w.-]*)\1/g;
  let out = "";
  let pos = 0;
  let match;
  while ((match = opener.exec(command))) {
    const lineEnd = command.indexOf("\n", match.index + match[0].length);
    if (lineEnd === -1) break;
    const bodyStart = lineEnd + 1;
    const terminator = new RegExp(`^[ \\t]*${match[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?$`, "m");
    const found = terminator.exec(command.slice(bodyStart));
    const bodyEnd = found ? bodyStart + found.index + found[0].length : command.length;
    out += command.slice(pos, bodyStart);
    pos = bodyEnd;
    opener.lastIndex = bodyEnd;
  }
  return out + command.slice(pos);
}

/**
 * Split a command into words and operators. Quotes and escapes follow POSIX sh, or PowerShell
 * (backtick escape, `@'…'@` here-strings) when asked. Redirect operators come out as
 * `>`, `>>`, `<`, `<<`, `<<<`; a descriptor duplication (`2>&1`, `>&2`) comes out as `dup` with
 * no target. Command separators (`;`, `&&`, `||`, `|`, newline, parentheses, backticks) come out
 * as their own operators.
 * @param {string} command
 * @param {{ powershell?: boolean }} [options]
 * @returns {Array<{ word: string, quoted: boolean } | { op: string }>}
 */
export function tokenizeShell(command, { powershell = false } = {}) {
  const tokens = [];
  const length = command.length;
  let word = null;
  const grow = (text, quoted) => {
    word ??= { value: "", quoted: false };
    word.value += text;
    if (quoted) word.quoted = true;
  };
  const flush = () => {
    if (word) tokens.push({ word: word.value, quoted: word.quoted });
    word = null;
  };
  const op = (value) => {
    flush();
    tokens.push({ op: value });
  };
  const escape = powershell ? "`" : "\\";

  let i = 0;
  while (i < length) {
    const ch = command[i];
    const next = command[i + 1];

    if (ch === "#" && word === null) {
      const eol = command.indexOf("\n", i);
      i = eol === -1 ? length : eol;
      continue;
    }
    // PowerShell here-strings: @'…'@ and @"…"@ (the closer must start a line).
    if (ch === "@" && (next === "'" || next === '"') && /^\r?\n/.test(command.slice(i + 2, i + 4))) {
      const close = command.indexOf(`\n${next}@`, i + 2);
      grow(close === -1 ? command.slice(i + 2) : command.slice(i + 2, close), true);
      i = close === -1 ? length : close + 3;
      continue;
    }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      grow(close === -1 ? command.slice(i + 1) : command.slice(i + 1, close), true);
      i = close === -1 ? length : close + 1;
      continue;
    }
    if (ch === '"') {
      let text = "";
      i += 1;
      while (i < length && command[i] !== '"') {
        const isEscape = command[i] === escape && i + 1 < length && (powershell || '"\\$`\n'.includes(command[i + 1]));
        if (isEscape) {
          if (command[i + 1] !== "\n") text += command[i + 1];
          i += 2;
        } else {
          text += command[i];
          i += 1;
        }
      }
      grow(text, true);
      i += 1;
      continue;
    }
    if (ch === escape && i + 1 < length) {
      if (next !== "\n" && next !== "\r") grow(next, true);
      i += 2;
      continue;
    }
    if (ch === "`" && !powershell) {
      op("(");
      i += 1;
      continue;
    }
    if (ch === "\n") {
      op(";");
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }
    if (ch === "&" && next === "&") {
      op("&&");
      i += 2;
      continue;
    }
    if (ch === "|" && next === "|") {
      op("||");
      i += 2;
      continue;
    }
    if (ch === "|") {
      op("|");
      i += next === "&" ? 2 : 1;
      continue;
    }
    if (ch === ";") {
      op(";");
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      op(ch);
      i += 1;
      continue;
    }
    if (ch === "&" && next !== ">") {
      op(";");
      i += 1;
      continue;
    }
    if (ch === ">" || ch === "<" || ch === "&") {
      // A bare unquoted number glued to the operator is a descriptor (`2>`), not a word.
      if (word && !word.quoted && /^\d+$/.test(word.value)) word = null;
      flush();
      let j = ch === "&" ? i + 1 : i;
      let kind = command[j];
      j += 1;
      if (command[j] === kind) {
        kind += kind;
        j += 1;
      }
      if (kind === "<<" && command[j] === "<") {
        kind = "<<<";
        j += 1;
      }
      if (command[j] === "|") j += 1;
      if (command[j] === "&") {
        j += 1;
        while (j < length && /[\d-]/.test(command[j])) j += 1;
        tokens.push({ op: "dup" });
      } else {
        tokens.push({ op: kind });
      }
      i = j;
      continue;
    }
    grow(ch, false);
    i += 1;
  }
  flush();
  return tokens;
}

const SEPARATORS = new Set(["&&", "||", "|", ";", "(", ")"]);

/**
 * Group tokens into simple commands: the words of each, plus the words that follow an output
 * redirect. Input redirects and here-doc delimiters are dropped.
 * @param {ReturnType<typeof tokenizeShell>} tokens
 * @returns {Array<{ words: string[], redirects: string[] }>}
 */
function simpleCommands(tokens) {
  const result = [];
  let current = { words: [], quoted: [], redirects: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if ("op" in token) {
      if (SEPARATORS.has(token.op)) {
        if (current.words.length || current.redirects.length) result.push(current);
        current = { words: [], quoted: [], redirects: [] };
      } else if (token.op === ">" || token.op === ">>") {
        const target = tokens[i + 1];
        if (target && "word" in target) {
          current.redirects.push(target.word);
          i += 1;
        }
      } else if (token.op === "<" || token.op === "<<" || token.op === "<<<") {
        if (tokens[i + 1] && "word" in tokens[i + 1]) i += 1;
      }
      continue;
    }
    current.words.push(token.word);
    current.quoted.push(token.quoted);
  }
  if (current.words.length || current.redirects.length) result.push(current);
  return result;
}

/** Operands that are not a path this module can name. */
function isUsablePath(token) {
  if (typeof token !== "string" || token === "" || token === "-") return false;
  if (/[$%`\n]/.test(token)) return false;
  if (/^(\/dev\/(null|stdout|stderr|tty)|nul|con|prn)$/i.test(token)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  return true;
}

/** Command word without directory, Windows extension or case. */
function commandName(word) {
  return basename(word.replace(/\\/g, "/"))
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
}

/** A word that is itself a script the shell runs: `./x.sh`, `scripts/y.mjs`, `tool.ps1`. */
function looksLikeScript(word) {
  return /[\\/]/.test(word) || /\.(sh|bash|zsh|mjs|cjs|js|ts|py|ps1|cmd|bat)$/i.test(word);
}

/**
 * Drop leading environment assignments, loop and condition keywords, wrapper words and
 * `npx`/`pnpm exec`/`xargs` prefixes so the real command is first. Returns the remaining words;
 * after `xargs`, the operands it would read from stdin are `XARGS_OPERAND`.
 * @param {string[]} words
 */
function unwrap(words) {
  let rest = words;
  for (;;) {
    while (rest.length && /^[A-Za-z_]\w*=/.test(rest[0])) rest = rest.slice(1);
    if (rest.length === 0) return rest;
    const step = unwrapOnce(rest);
    if (step.done) return step.words;
    rest = step.words;
  }
}

/**
 * One layer of `unwrap`: the words after the leading wrapper, or `done` when the first word is
 * the real command.
 * @param {string[]} rest
 * @returns {{ words: string[], done: boolean }}
 */
function unwrapOnce(rest) {
  const name = commandName(rest[0]);
  if (WRAPPERS.has(name) || KEYWORDS.has(rest[0])) return { words: dropWrapper(name, rest), done: false };
  if (name === "xargs") return unwrapXargs(rest);
  if (name === "npx") return { words: rest.slice(skipOptions(rest, /^(-p|--package|-c|--call)$/)), done: false };
  if (name in DEPENDENCY_SUBCOMMANDS) return unwrapPackageManager(rest);
  return { words: rest, done: true };
}

function dropWrapper(name, rest) {
  // `rtk proxy <cmd>` runs `<cmd>` unfiltered; read as a command named `proxy`, a script it ran went unattributed.
  return name === "rtk" && rest[1] === "proxy" ? rest.slice(2) : rest.slice(1);
}

/** Index of the first word after the leading options; an option matching `valueOption` takes the next word. */
function skipOptions(rest, valueOption) {
  let i = 1;
  while (i < rest.length && rest[i].startsWith("-")) {
    i += valueOption.test(rest[i]) && !rest[i].includes("=") ? 2 : 1;
  }
  return i;
}

/** `xargs` options: where its command starts and the `-I` replace string, if any. */
function xargsOptions(rest) {
  let i = 1;
  let replace = null;
  while (i < rest.length && rest[i].startsWith("-")) {
    const option = rest[i];
    if (/^-I.|^--replace=/.test(option)) replace = option.replace(/^-I|^--replace=/, "");
    else if (option === "-I") replace = rest[++i];
    else if (/^(-[nPLdEsa]|--max-args|--max-procs|--max-lines|--delimiter|--arg-file|--eof)$/.test(option)) i += 1;
    i += 1;
  }
  return { start: i, replace };
}

function unwrapXargs(rest) {
  const { start, replace } = xargsOptions(rest);
  const inner = rest.slice(start);
  if (inner.length === 0) return { words: inner, done: true };
  const words = replace
    ? inner.map((word) => (word.includes(replace) ? word.replaceAll(replace, XARGS_OPERAND) : word))
    : [...inner, XARGS_OPERAND];
  return { words, done: false };
}

/** `pnpm exec <cmd>` and the like run `<cmd>`; any other subcommand is the command itself. */
function unwrapPackageManager(rest) {
  const i = skipOptions(rest, /^(--filter|-F|-C|--dir|--prefix|-w|--workspace)$/);
  if (i < rest.length && PM_EXEC_VERBS.has(rest[i])) {
    const words = rest.slice(i + 1);
    return { words: words[0] === "--" ? words.slice(1) : words, done: false };
  }
  return { words: [rest[0], ...rest.slice(i)], done: true };
}

/** Non-option operands; `--` ends option parsing. */
function operands(args, { valueOptions = /^$/ } = {}) {
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") return result.concat(args.slice(i + 1));
    if (arg.startsWith("-") && arg !== "-") {
      if (valueOptions.test(arg) && !arg.includes("=")) i += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

/**
 * perl's leading switches, bundled or not (`-0pi`, `-i.bak`, `-0777`, `-pe`). `-i` takes the rest
 * of its cluster as the backup suffix, so `-pie` is -p and -i with suffix "e"; `-e`/`-E` take the
 * rest of the cluster or the next word as code; `-I`/`-M`/`-m`/`-F`/`-C`/`-x`/`-d`/`-D` take the
 * rest of the cluster. Returns the words after the switches: files, after the script file when no
 * `-e` gave the code.
 * @param {string[]} args
 */
function perlSwitches(args) {
  let inPlace = false;
  let explicitScript = false;
  let i = 0;
  for (; i < args.length && /^-./.test(args[i]) && args[i] !== "--"; i += 1) {
    const cluster = args[i].slice(1);
    for (let j = 0; j < cluster.length; j += 1) {
      const flag = cluster[j];
      if (flag === "i") {
        inPlace = true;
        break;
      }
      if (flag === "e" || flag === "E") {
        explicitScript = true;
        if (j === cluster.length - 1) i += 1;
        break;
      }
      if ("IMmFCxdD".includes(flag)) break;
      if (flag === "0" || flag === "l") {
        const digits = /^(?:x[0-9a-fA-F]+|[0-7]+)/.exec(cluster.slice(j + 1));
        if (digits) j += digits[0].length;
      }
    }
  }
  return { inPlace, explicitScript, rest: args.slice(i) };
}

/**
 * PowerShell parameter binding: named `-Param value` pairs (switches take none), the rest is
 * positional. Comma lists are split.
 * @param {string[]} args
 */
function bindPowerShell(args) {
  const named = new Map();
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("-") && arg.length > 1 && !/^-?\d/.test(arg)) {
      const [name, inlineValue] = arg.slice(1).split(":", 2);
      const key = name.toLowerCase();
      if (inlineValue !== undefined) {
        named.set(key, inlineValue.split(","));
      } else if (PS_SWITCHES.has(key) || key === "confirm" || i + 1 >= args.length) {
        named.set(key, []);
      } else {
        named.set(key, args[i + 1].split(","));
        i += 1;
      }
      continue;
    }
    positional.push(...arg.split(","));
  }
  return { named, positional };
}

/**
 * What `shellWriteTargets` has collected so far, plus what it knows of the shell between commands.
 * @param {string} cwd
 * @param {boolean} powershell
 */
function createWriteState(cwd, powershell) {
  return {
    cwd,
    powershell,
    files: new Set(),
    globs: new Set(),
    removed: new Set(),
    opaque: false,
    integrates: false,
    // `null` once a `cd` went somewhere this parser cannot know (`cd "$X"` with X unset here, `cd
    // $(mktemp -d)`): a relative path after it could be anywhere, so it is not this checkout's.
    dir: cwd,
    /** `NAME=value` / `export NAME=value` earlier in the same command, for `cd $NAME/…`. */
    vars: new Map(),
  };
}

function expandVars(state, token) {
  return token.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, braced, bare) => state.vars.get(braced ?? bare) ?? all);
}

/**
 * POSIX sh splits an unquoted `$VAR` on whitespace after expanding it, so `F="a.ts b.ts" &&
 * prettier --write $F` names two files; a quoted `"$F"` stays one word, and PowerShell never
 * splits. Only variables set earlier in this command expand; the rest stay as written.
 */
function splitWords(state, simple) {
  if (state.powershell) return simple.words;
  return simple.words.flatMap((word, i) => {
    if (simple.quoted[i] || !/\$(\{\w+\}|\w+)/.test(word)) return [word];
    const expanded = expandVars(state, word);
    return /\s/.test(expanded) ? expanded.split(/\s+/).filter(Boolean) : [word];
  });
}

function toAbsolute(state, token) {
  const expanded = token.startsWith("~") ? homedir() + token.slice(1) : token;
  // PowerShell accepts both separators; on a POSIX host (CI) resolve() would keep "\\" as a file-name character.
  const path = state.powershell ? expanded.replaceAll("\\", "/") : expanded;
  if (state.dir === null && !isAbsolute(path)) return null;
  return resolve(state.dir ?? "/", path);
}

/**
 * A write target that is still a variable or a substitution after expansion (`"$f"` in a loop,
 * `$(git grep -l …)`, xargs input) writes somewhere real that this parser cannot name: the
 * command becomes opaque, so the run window attributes what it wrote. PowerShell's `$null` is a
 * device, not a target, and an absolute literal prefix outside the cwd (`/tmp/head-$(…)`) already
 * places the write outside this checkout.
 */
function resolveOperand(state, token) {
  if (typeof token !== "string") return null;
  const expanded = expandVars(state, token);
  if (/^\$null$/i.test(expanded)) return null;
  const unresolved = expanded.search(/[$`]|%\w+%/);
  if (unresolved !== -1 && !literalPrefixIsOutside(expanded.slice(0, unresolved), state.cwd)) state.opaque = true;
  if (!isUsablePath(expanded)) return null;
  return expanded;
}

function literalPrefixIsOutside(prefix, cwd) {
  const known = prefix.slice(0, prefix.lastIndexOf("/") + 1);
  return isAbsolute(known) && !`${resolve(known)}/`.startsWith(`${resolve(cwd)}/`);
}

function addPath(state, token) {
  const path = resolveOperand(state, token);
  if (path === null) return;
  const absolute = toAbsolute(state, path);
  if (absolute === null) return;
  if (GLOB_CHARS.test(path)) state.globs.add(absolute);
  else state.files.add(absolute);
}

/** A path the command deletes or moves away; it is a write target too. */
function addRemoved(state, token) {
  addPath(state, token);
  const path = resolveOperand(state, token);
  const absolute = path === null ? null : toAbsolute(state, path);
  if (absolute !== null) state.removed.add(absolute);
}

function addInto(state, target, sources) {
  addPath(state, target);
  const path = resolveOperand(state, target);
  if (path === null || GLOB_CHARS.test(path)) return;
  const into = toAbsolute(state, path);
  if (into === null) return;
  for (const source of sources) {
    const from = resolveOperand(state, source);
    if (from !== null && !GLOB_CHARS.test(from)) state.files.add(resolve(into, basename(from)));
  }
}

/** Only a command made of assignments sets a variable for the commands after it (`A=1 cmd` does not). */
function recordAssignments(state, words) {
  const assigned = words[0] === "export" ? words.slice(1) : words;
  if (!assigned.length || !assigned.every((word) => /^[A-Za-z_]\w*=/.test(word))) return false;
  for (const word of assigned) {
    const at = word.indexOf("=");
    state.vars.set(word.slice(0, at), expandVars(state, word.slice(at + 1)));
  }
  return true;
}

function changeDirectory(state, args) {
  const [target] = operands(args);
  if (target === undefined) {
    state.dir = homedir();
    return;
  }
  const expanded = expandVars(state, target);
  state.dir = isUsablePath(expanded) ? toAbsolute(state, expanded) : null;
}

/** `out-file`, `set-content`, `remove-item`. */
function writeItems(state, cmdlet, param, positional) {
  const removes = cmdlet === "remove-item";
  const paths = param("filepath", "literalpath", "path") ?? positional.slice(0, removes ? undefined : 1);
  for (const path of paths) (removes ? addRemoved : addPath)(state, path);
}

function newItem(state, cmdlet, param, positional) {
  const paths = param("path", "literalpath") ?? positional.slice(0, 1);
  const [itemName] = param("name") ?? [];
  for (const path of paths) addPath(state, itemName ? `${path}/${itemName}` : path);
}

/** `copy-item`, `move-item`. */
function copyItems(state, cmdlet, param, positional) {
  const sources = param("path", "literalpath") ?? positional.slice(0, 1);
  const [destination] = param("destination") ?? positional.slice(1, 2);
  if (destination) addInto(state, destination, sources);
  if (cmdlet === "move-item") for (const source of sources) addRemoved(state, source);
}

function renameItem(state, cmdlet, param, positional) {
  const [path] = param("path", "literalpath") ?? positional.slice(0, 1);
  const [newName] = param("newname") ?? positional.slice(1, 2);
  if (path) addRemoved(state, path);
  if (path && newName && isUsablePath(path)) addPath(state, `${dirname(path)}/${newName}`);
}

const CMDLET_HANDLERS = new Map([
  ["out-file", writeItems],
  ["set-content", writeItems],
  ["remove-item", writeItems],
  ["new-item", newItem],
  ["copy-item", copyItems],
  ["move-item", copyItems],
  ["rename-item", renameItem],
]);

function applyCmdlet(state, cmdlet, args) {
  const { named, positional } = bindPowerShell(args);
  const param = (...keys) => keys.map((key) => named.get(key)).find(Boolean);
  CMDLET_HANDLERS.get(cmdlet)?.(state, cmdlet, param, positional);
}

function cmdletOf(state, name) {
  return state.powershell || /-/.test(name) ? PS_CMDLETS.get(name) : undefined;
}

function addOperands(state, args) {
  for (const path of operands(args)) addPath(state, path);
}

function removeOperands(state, args) {
  for (const path of operands(args)) addRemoved(state, path);
}

function sedTargets(state, args) {
  // macOS/BSD `sed -i '' …`: the empty word is -i's backup suffix, not the script.
  const sedArgs = args.filter((arg, i) => !(arg === "" && args[i - 1] === "-i"));
  const inPlace = sedArgs.some((arg) => /^(-[a-zA-Z]*i|--in-place)/.test(arg));
  if (!inPlace) return;
  const explicitScript = sedArgs.some((arg) => /^(-e|--expression|-f|--file)/.test(arg));
  const paths = operands(sedArgs, { valueOptions: /^(-e|--expression|-f|--file|-l|--line-length)$/ });
  for (const path of explicitScript ? paths : paths.slice(1)) addPath(state, path);
}

function perlTargets(state, args) {
  const { inPlace, explicitScript, rest } = perlSwitches(args);
  if (!inPlace) return;
  const paths = rest[0] === "--" ? rest.slice(1) : rest;
  for (const path of explicitScript ? paths : paths.slice(1)) addPath(state, path);
}

function prettierTargets(state, args) {
  if (!args.some((arg) => arg === "--write" || arg === "-w")) return;
  for (const path of operands(args, {
    valueOptions: /^(--config|--ignore-path|--plugin|--parser|--log-level|--cache-location|--stdin-filepath)$/,
  }))
    addPath(state, path);
}

function eslintTargets(state, args) {
  if (!args.includes("--fix")) return;
  const paths = operands(args, {
    valueOptions:
      /^(-c|--config|--ext|--rule|--parser|--resolve-plugins-relative-to|--ignore-pattern|--format|-f|-o|--output-file|--max-warnings|--cache-location|--rulesdir|--env|--global|--plugin|--parser-options)$/,
  });
  for (const path of paths.length ? paths : ["."]) addPath(state, path);
}

function knipTargets(state, args) {
  if (args.includes("--fix")) state.opaque = true;
}

/** `mv`, `cp`. */
function copyTargets(state, args, name) {
  const paths = operands(args, { valueOptions: /^(-t|--target-directory|-S|--suffix)$/ });
  if (paths.length < 2) return;
  const target = paths.at(-1);
  const sources = paths.slice(0, -1);
  addInto(state, target, sources);
  if (name === "mv") for (const source of sources) addRemoved(state, source);
}

function touchTargets(state, args) {
  const paths = operands(args, { valueOptions: /^(-s|--size|-r|--reference|-d|--date|-t)$/ });
  for (const path of paths) addPath(state, path);
}

/** `curl -o`, `wget -O` and their long forms, separate or `=`-joined. */
function outputOptionTargets(short, long) {
  return (state, args) => {
    for (let i = 0; i < args.length; i += 1) {
      if ((args[i] === short || args[i] === long) && args[i + 1]) addPath(state, args[i + 1]);
      else if (args[i].startsWith(`${long}=`)) addPath(state, args[i].slice(long.length + 1));
    }
  };
}

function gitTargets(state, args) {
  const sub = operands(args, { valueOptions: /^(-C|-c|--git-dir|--work-tree)$/ });
  if (sub[0] === "mv") {
    const paths = sub.slice(1);
    if (paths.length < 2) return;
    addInto(state, paths.at(-1), paths.slice(0, -1));
    for (const path of paths.slice(0, -1)) addRemoved(state, path);
  } else if (sub[0] === "rm") {
    for (const path of sub.slice(1)) addRemoved(state, path);
  } else if (GIT_INTEGRATING.has(sub[0])) {
    const ownResult = GIT_INTEGRATING.get(sub[0]);
    const ownsResult = args.slice(args.indexOf(sub[0]) + 1).some((arg) => ownResult.test(arg));
    if (ownsResult || args.some((arg) => AUTOSTASH_CONFIG.test(arg))) state.opaque = true;
    else state.integrates = true;
  } else if (GIT_TREE_CHANGING.has(sub[0])) {
    state.opaque = true;
  }
}

/** `pnpm`, `npm`, `yarn`, `bun`. */
function packageManagerTargets(state, args, name) {
  const [sub] = operands(args);
  const manager = DEPENDENCY_SUBCOMMANDS[name];
  if (!sub || PM_READ_ONLY.has(sub)) return;
  if (manager.sub.has(sub)) {
    addPath(state, "package.json");
    addPath(state, manager.lock);
  } else {
    // `pnpm run x`, `pnpm test`, `pnpm <bin>`: a task whose writes are its own business.
    state.opaque = true;
  }
}

function otherCommandTargets(state, args, name, words) {
  if (OPAQUE_COMMANDS.has(name) || looksLikeScript(words[0])) state.opaque = true;
}

const CD_COMMANDS = new Set(["cd", "pushd", "set-location", "sl"]);

const COMMAND_HANDLERS = new Map([
  ["tee", addOperands],
  ["sed", sedTargets],
  ["perl", perlTargets],
  ["prettier", prettierTargets],
  ["eslint", eslintTargets],
  ["knip", knipTargets],
  ["mv", copyTargets],
  ["cp", copyTargets],
  ["rm", removeOperands],
  ["unlink", removeOperands],
  ["touch", touchTargets],
  ["truncate", touchTargets],
  ["curl", outputOptionTargets("-o", "--output")],
  ["wget", outputOptionTargets("-O", "--output-document")],
  ["git", gitTargets],
  ["pnpm", packageManagerTargets],
  ["npm", packageManagerTargets],
  ["yarn", packageManagerTargets],
  ["bun", packageManagerTargets],
]);

function applySimpleCommand(state, simple) {
  for (const target of simple.redirects) addPath(state, target);
  if (recordAssignments(state, simple.words)) return;
  const words = unwrap(splitWords(state, simple));
  if (words.length === 0) return;
  const name = commandName(words[0]);
  const args = words.slice(1);
  if (CD_COMMANDS.has(name)) {
    changeDirectory(state, args);
    return;
  }
  const cmdlet = cmdletOf(state, name);
  if (cmdlet) {
    applyCmdlet(state, cmdlet, args);
    return;
  }
  (COMMAND_HANDLERS.get(name) ?? otherCommandTargets)(state, args, name, words);
}

/** Writes made by a script body the command runs inline (`node -e`, `python -c`): `fs.*` and `open()` calls. */
function scanScriptCalls(state, command) {
  for (const [, , path] of command.matchAll(FS_WRITE_CALLS)) addPath(state, path);
  for (const [, , path] of command.matchAll(FS_REMOVE_CALLS)) addRemoved(state, path);
  for (const [call, , from, , to] of command.matchAll(FS_MOVE_CALLS)) {
    addPath(state, to);
    if (call.startsWith("rename")) addRemoved(state, from);
  }
  for (const [, , path] of command.matchAll(PY_OPEN_WRITE)) addPath(state, path);
  for (const [, , path] of command.matchAll(PY_PATH_WRITE)) addPath(state, path);
}

/**
 * A write through a name credits the literal that name held just before the call, so a name
 * reassigned between writes credits each written path and not one it only read. When the latest
 * assignment before the call is not a literal (`p = path.join(…)`), nothing is named.
 */
function scanNamedWrites(state, command) {
  const literals = new Map([...command.matchAll(SCRIPT_PATH_ASSIGN)].map((entry) => [entry.index, entry[3]]));
  const assignments = [...command.matchAll(SCRIPT_ANY_ASSIGN)];
  for (const call of command.matchAll(NAMED_WRITE_CALLS)) {
    const name = call[1] ?? call[2];
    const latest = assignments
      .filter((entry) => (entry[1] ?? entry[2] ?? entry[3]) === name && entry.index < call.index)
      .at(-1);
    const path = latest ? literals.get(latest.index) : undefined;
    if (path) addPath(state, path);
  }
}

/**
 * Write targets of a Bash or PowerShell command.
 * @param {string} command
 * @param {{ cwd?: string, powershell?: boolean }} [options]
 * @returns {{ files: string[], globs: string[], removed: string[], opaque: boolean, integrates: boolean }}
 *   `integrates`: a `git merge`, `pull`, `rebase` or `cherry-pick` ran; it does not make the call opaque.
 */
export function shellWriteTargets(command, { cwd = process.cwd(), powershell = false } = {}) {
  const state = createWriteState(cwd, powershell);
  for (const simple of simpleCommands(tokenizeShell(stripHeredocs(command), { powershell }))) {
    applySimpleCommand(state, simple);
  }
  scanScriptCalls(state, command);
  scanNamedWrites(state, command);
  const { files, globs, removed, opaque, integrates } = state;
  return { files: [...files], globs: [...globs], removed: [...removed], opaque, integrates };
}

/**
 * Minimal glob → RegExp for repo-relative POSIX paths: `**` any depth, `*` and `?` within one
 * segment, `{a,b}` alternatives. A pattern with no glob characters matches itself and, as a
 * directory, everything under it.
 * @param {string} pattern
 */
export function globToRegExp(pattern) {
  // An unbalanced `{` (a sed script, a stray brace) is a literal, not the start of a group.
  const balanced = (pattern.match(/\{/g) ?? []).length === (pattern.match(/\}/g) ?? []).length;
  let source = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += pattern[i + 2] === "/" ? 2 : 1;
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else if (ch === "{" && balanced) {
      braces += 1;
      source += "(?:";
    } else if (ch === "}" && braces > 0) {
      braces -= 1;
      source += ")";
    } else if (ch === "," && braces > 0) source += "|";
    else source += ch.replace(/[.+^$(){}|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}(?:/.*)?$`);
}
