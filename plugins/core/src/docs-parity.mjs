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
// folder is searched recursively (git-tracked files when it is in a git repo). Exit 1 on any
// mismatch. Node built-ins only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

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

/** @param {string[]} args */
export function main(args) {
  const targets = args.length > 0 ? args : ["."];
  const files = new Set(targets.flatMap(markdownFiles));
  const cwd = process.cwd();
  let pairs = 0;
  let failed = false;
  for (const file of [...files].sort()) {
    if (!file.endsWith(".uk.md")) continue;
    const enFile = file.replace(/\.uk\.md$/, ".md");
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
  if (!failed) console.log(`ok   docs parity: ${pairs} page pair(s) under ${targets.map((target) => relative(cwd, resolve(target)) || ".").join(", ")}`);
  return failed ? 1 : 0;
}

