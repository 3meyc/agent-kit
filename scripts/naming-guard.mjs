#!/usr/bin/env node
// Naming guard: fails when a banned term appears in a tracked file (its path or its text), in a
// commit message or author line, or in the branch name. This repo is public; the terms are the
// private names that must never reach it, so the list itself is never committed.
//
// Where the list comes from, first match wins:
//   1. env NAMING_GUARD_WORDS        newline-separated (the GitHub Actions secret of that name)
//   2. env NAMING_GUARD_FILE         path to a list file
//   3. ~/.config/agent-kit/naming-guard.txt
// An empty or missing list is an error: a guard with nothing to look for would always pass.
//
// List syntax, one term per line:
//   term        case-insensitive, whole word (letters and digits are word characters)
//   cs:term     case-sensitive, whole word
//   re:pattern  JavaScript regular expression, case-sensitive
//   # comment   ignored, as are blank lines
//
// Usage:
//   node scripts/naming-guard.mjs [--commits <rev-range>] [--no-files]
// Without --commits, commits not yet on origin/main are checked (none when that ref is missing).
// In CI (env CI set) findings name the file, line and term number only: CI logs of a public repo
// are public, and printing the term or the matching line would leak it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
};
const quiet = Boolean(process.env.CI);

function git(gitArgs, { allowFail = false } = {}) {
  const result = spawnSync("git", gitArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowFail) return null;
    console.error(`naming-guard: git ${gitArgs.join(" ")} failed\n${result.stderr}`);
    process.exit(2);
  }
  return result.stdout;
}

function loadList() {
  if (process.env.NAMING_GUARD_WORDS) return { text: process.env.NAMING_GUARD_WORDS, from: "env NAMING_GUARD_WORDS" };
  const file = process.env.NAMING_GUARD_FILE || join(homedir(), ".config", "agent-kit", "naming-guard.txt");
  if (existsSync(file)) return { text: readFileSync(file, "utf8"), from: quiet ? "list file" : file };
  return { text: "", from: file };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (body) => `(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`;

function parseTerms(text) {
  const terms = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    let regex;
    if (line.startsWith("re:")) regex = new RegExp(line.slice(3), "u");
    else if (line.startsWith("cs:")) regex = new RegExp(wholeWord(escape(line.slice(3).trim())), "u");
    else regex = new RegExp(wholeWord(escape(line)), "iu");
    terms.push({ id: terms.length + 1, label: line, regex });
  }
  return terms;
}

const { text, from } = loadList();
const terms = parseTerms(text);
if (terms.length === 0) {
  console.error(
    `naming-guard: no banned terms loaded (looked in ${from}).\n` +
      "Set NAMING_GUARD_WORDS, or create ~/.config/agent-kit/naming-guard.txt, one term per line.",
  );
  process.exit(2);
}

const findings = [];
/** Check one block of text, reporting each matching line under `where`. */
function scan(where, body) {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const term of terms) {
      if (term.regex.test(lines[i])) findings.push({ where: `${where}:${i + 1}`, term, line: lines[i] });
    }
  }
}

let filesChecked = 0;
if (!args.includes("--no-files")) {
  const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    scan(`path ${file}`, file);
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    if (buffer.includes(0)) continue; // binary
    scan(file, buffer.toString("utf8"));
    filesChecked += 1;
  }
}

let range = option("--commits");
if (range === null && git(["rev-parse", "--verify", "--quiet", "origin/main"], { allowFail: true }) !== null) {
  range = "origin/main..HEAD";
}
let commitsChecked = 0;
if (range) {
  const log = git(["log", "--format=%x00%H%n%an <%ae>%n%cn <%ce>%n%B", range]);
  for (const entry of log.split("\0").filter(Boolean)) {
    const [sha, ...rest] = entry.split("\n");
    scan(`commit ${sha.slice(0, 12)}`, rest.join("\n"));
    commitsChecked += 1;
  }
}

const branch =
  process.env.GITHUB_HEAD_REF || git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })?.trim() || "";
if (branch) scan("branch", branch);

if (findings.length > 0) {
  console.error(`naming-guard: ${findings.length} banned-term match(es):`);
  for (const { where, term, line } of findings) {
    if (quiet) console.error(`  ${where}  term #${term.id}`);
    else console.error(`  ${where}  [${term.label}]  ${line.trim().slice(0, 160)}`);
  }
  if (quiet) console.error("Term numbers count non-comment lines of the list. Run the guard locally to see the text.");
  process.exit(1);
}
console.log(
  `ok   naming guard: ${terms.length} terms, ${filesChecked} files, ${commitsChecked} commits${range ? ` (${range})` : ""}, branch`,
);
