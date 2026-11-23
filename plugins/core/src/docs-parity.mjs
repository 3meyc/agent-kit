// `kit-docs-parity [path...]`: checks that every `name.md` / `name.uk.md` pair (an English page
// and its Ukrainian mirror) keeps the same structure, since the two are edited by hand:
//
// 1. Language-switch line: the first line after the title links the other file.
// 2. Headings: the same levels, in the same order.
// 3. Tables: the same number of tables, each with the same rows and columns.
// 4. Mermaid blocks: the same count, each the same diagram type and line count.
// 5. Command blocks (bash, sh, shell, zsh, powershell, console): identical text.
// 6. Other fenced blocks: the same count and language tags.
// 7. Numbered items: the same numbers, in the same order.
//
// A `.uk.md` with no `.md` beside it is an error. Paths default to the current directory; a
// folder is searched recursively (git-tracked files when it is in a git repo). `kit.json`
// `docsParity.ignore` and each `--ignore <glob>` leave paths out: globs over the path relative to
// the repo root (the current directory outside git); a glob matching a folder leaves out all under
// it. A pair is skipped when either file is ignored, so an ignored lone mirror is no error. Exit 1
// on any mismatch. Node built-ins only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { globMatcher } from "../lib/globs.mjs";
import { readKit } from "../lib/kit-config.mjs";

const COMMAND_LANGS = new Set(["bash", "sh", "shell", "zsh", "powershell", "pwsh", "console"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude"]);

/**
 * The structure of one Markdown page.
 * @param {string} text
 */
export function outline(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const result = { title: null, switchLine: null, headings: [], tables: [], mermaid: [], commands: [], blocks: [], numbers: [] };
  let fence = null;
  let table = null;
  let afterTitle = false;
  const closeTable = () => {
    if (table) result.tables.push(table);
    table = null;
  };
  for (const line of lines) {
    if (fence) {
      if (/^\s*(```|~~~)\s*$/.test(line) && line.trim().startsWith(fence.marker)) {
        if (fence.lang === "mermaid") result.mermaid.push(`${fence.body[0]?.trim().split(/\s+/)[0] ?? ""}:${fence.body.length}`);
        else if (COMMAND_LANGS.has(fence.lang)) result.commands.push(fence.body.join("\n"));
        else result.blocks.push(fence.lang || "(none)");
        fence = null;
      } else fence.body.push(line);
      continue;
    }
    const open = line.match(/^\s*(```|~~~)\s*([\w-]*)/);
    if (open) {
      closeTable();
      fence = { marker: open[1], lang: open[2].toLowerCase(), body: [] };
      continue;
    }
    if (afterTitle && line.trim() !== "") {
      result.switchLine = line;
      afterTitle = false;
    }
    const heading = line.match(/^(#{1,6})\s+\S/);
    if (heading) {
      closeTable();
      if (result.title === null && heading[1].length === 1) {
        result.title = line;
        afterTitle = true;
      }
      result.headings.push(heading[1].length);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split(/(?<!\\)\|/).length;
      if (!table) table = { rows: 0, columns: cells };
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.rows += 1;
      continue;
    }
    closeTable();
    const numbered = line.match(/^(\s*)(\d+(?:\.\d+)*)[.)]\s+\S/);
    if (numbered) result.numbers.push(`${numbered[1].length > 0 ? "  " : ""}${numbered[2]}`);
  }
  closeTable();
  return result;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function firstDifference(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return { index: i + 1, en: a[i], uk: b[i] };
  }
  return null;
}

/**
 * Mismatches between a page and its mirror, as one-line messages.
 * @param {string} enText @param {string} ukText @param {string} enName @param {string} ukName
 */
export function compare(enText, ukText, enName, ukName) {
  const en = outline(enText);
  const uk = outline(ukText);
  const problems = [];
  if (!en.switchLine?.includes(`(${ukName})`)) problems.push(`language-switch line under the title does not link ${ukName}`);
  if (!uk.switchLine?.includes(`(${enName})`)) problems.push(`mirror's language-switch line does not link ${enName}`);
  const describe = (label, a, b, show = (value) => JSON.stringify(value)) => {
    if (same(a, b)) return;
    const diff = firstDifference(a, b);
    problems.push(`${label}: ${a.length} vs ${b.length}; first difference at #${diff.index}: ${show(diff.en)} vs ${show(diff.uk)}`);
  };
  describe("headings (levels)", en.headings, uk.headings, (level) => (level ? "#".repeat(level) : "none"));
  describe("tables (rows x columns)", en.tables, uk.tables, (table) => (table ? `${table.rows}x${table.columns}` : "none"));
  describe("mermaid blocks (type:lines)", en.mermaid, uk.mermaid, (value) => value ?? "none");
  describe("command blocks", en.commands, uk.commands, (value) => (value === undefined ? "none" : JSON.stringify(value.split("\n")[0])));
  describe("other code blocks (language)", en.blocks, uk.blocks, (value) => value ?? "none");
  describe("numbered items", en.numbers, uk.numbers, (value) => (value === undefined ? "none" : value.trim()));
  return problems;
}

function markdownFiles(target) {
  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error(`${target}: no such file or folder`);
  if (statSync(abs).isFile()) return [abs];
  try {
    const listed = execFileSync("git", ["-C", abs, "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return listed
      .split("\n")
      .filter(Boolean)
      .map((rel) => join(abs, rel))
      .filter(existsSync);
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(path);
        } else if (name.endsWith(".md")) out.push(path);
      }
    };
    walk(abs);
    return out;
  }
}

/**
 * Paths and `--ignore` globs from the command line (`--ignore <glob>` or `--ignore=<glob>`,
 * repeatable). Any other `--` argument is an error, so a mistyped flag is not read as a path.
 * @param {string[]} args
 * @returns {{ targets: string[], ignore: string[] }}
 */
export function parseArgs(args) {
  const targets = [];
  const ignore = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--ignore") {
      if (args[i + 1] === undefined || args[i + 1] === "") throw new Error("--ignore needs a glob");
      ignore.push(args[(i += 1)]);
    } else if (arg.startsWith("--ignore=")) {
      if (arg.length === "--ignore=".length) throw new Error("--ignore needs a glob");
      ignore.push(arg.slice("--ignore=".length));
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else targets.push(arg);
  }
  return { targets, ignore };
}

/**
 * A test for repo-relative POSIX paths: true when the path, or a folder above it, matches one of
 * the globs, so `docs/guide` and `docs/guide/**` both leave out the whole folder.
 * @param {string[]} globs
 */
export function ignoreMatcher(globs) {
  const matchers = globs.map(globMatcher);
  return (path) => {
    const parts = path.split("/");
    for (let end = parts.length; end > 0; end -= 1) {
      const prefix = parts.slice(0, end).join("/");
      if (matchers.some((matcher) => matcher.test(prefix))) return true;
    }
    return false;
  };
}

/**
 * The top of the git checkout holding `cwd`, spelled from `cwd` (`--show-cdup`) so a symlinked
 * temp folder (`/var` → `/private/var` on macOS) still gives paths relative to it; `cwd` outside git.
 * @param {string} cwd
 */
function repoRoot(cwd) {
  try {
    const up = execFileSync("git", ["rev-parse", "--show-cdup"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return resolve(cwd, up.trim());
  } catch {
    return cwd;
  }
}

/** @param {string[]} args */
export function main(args) {
  const parsed = parseArgs(args);
  const targets = parsed.targets.length > 0 ? parsed.targets : ["."];
  const cwd = process.cwd();
  const root = repoRoot(cwd);
  const ignored = ignoreMatcher([...readKit(root).docsParity.ignore, ...parsed.ignore]);
  const isIgnored = (file) => ignored(relative(root, file).split(sep).join("/"));
  const files = new Set();
  let skipped = 0;
  for (const file of targets.flatMap(markdownFiles)) {
    if (files.has(file)) continue;
    files.add(file);
    if (isIgnored(file)) skipped += 1;
  }
  let pairs = 0;
  let failed = false;
  for (const file of [...files].sort()) {
    if (!file.endsWith(".uk.md")) continue;
    const enFile = file.replace(/\.uk\.md$/, ".md");
    if (isIgnored(file) || isIgnored(enFile)) continue;
    const shown = relative(cwd, file) || file;
    if (!existsSync(enFile)) {
      console.error(`FAIL ${shown}: no ${basename(enFile)} beside it`);
      failed = true;
      continue;
    }
    pairs += 1;
    const problems = compare(readFileSync(enFile, "utf8"), readFileSync(file, "utf8"), basename(enFile), basename(file));
    if (problems.length === 0) continue;
    failed = true;
    console.error(`FAIL ${relative(cwd, enFile) || enFile} ↔ ${basename(file)}`);
    for (const problem of problems) console.error(`     ${problem}`);
  }
  const under = targets.map((target) => relative(cwd, resolve(target)) || ".").join(", ");
  if (!failed) console.log(`ok   docs parity: ${pairs} page pair(s) under ${under}${skipped > 0 ? `, ${skipped} path(s) ignored` : ""}`);
  return failed ? 1 : 0;
}

