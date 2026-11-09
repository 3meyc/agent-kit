/**
 * Render a session's ledger record as a standalone handoff file, for a reader outside this repo's
 * ledger: a colleague, another repo, another harness, a fork. Used by `/handoff --export`.
 *
 *   ledger-export <record.md> [--note "<what the next agent is for>"]
 *     [--start "<skills or docs to load first>"] [--out <path>]
 *
 * The ledger stays the only store; this is a rendering of one record plus the git facts a cold
 * reader needs to find the same state. Specs, ADRs, diffs and commits appear by path or URL only —
 * a copied diff goes stale the moment the branch moves and makes the file as long as the session.
 *
 * Default location is `~/handoffs/<repo>-<date>-<id8>.md`: outside the repo, so never committed,
 * and not the OS temp dir, which is cleared on reboot and gives paths too long to type.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDirectRun } from "../lib/hook-utils.mjs";
import { rootFor } from "./kit-config.mjs";
import { readCommitFacts } from "./ledger-utils.mjs";

// The checkout the record belongs to: the one the command runs in.
const REPO_ROOT = rootFor(process.cwd());
import { filePaths } from "./ledger-record.mjs";
import { redactSecrets } from "./ledger-text.mjs";

const SECTIONS = ["Intent", "Decisions", "Next"];

/**
 * @param {string} text
 * @returns {{ id: string, title: string, commits: string[], files: string[], sections: Map<string, string> }}
 */
export function parseRecord(text) {
  const flat = String(text).replace(/\r\n/g, "\n");
  const field = (name) => flat.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1];
  let title = field("title") ?? "";
  try {
    title = title ? JSON.parse(title) : "";
  } catch {
    /* an unquoted title is still a title */
  }
  /** @type {Map<string, string>} */
  const sections = new Map();
  for (const heading of SECTIONS) {
    const at = flat.search(new RegExp(`^## ${heading}\\s*$`, "m"));
    if (at === -1) continue;
    const body = flat.slice(at).split("\n").slice(1).join("\n").split(/^## /m)[0].trim();
    if (body && !/^_.*_$/s.test(body)) sections.set(heading, body);
  }
  const footer = flat.split(/^## Files(?: \(\d+\))?\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return {
    id: field("id") ?? "",
    title,
    commits: (field("commits") ?? "")
      .replace(/^\[|\]$/g, "")
      .split(", ")
      .filter(Boolean),
    files: filePaths(footer),
    sections,
  };
}

/**
 * A remote URL can carry a token as userinfo (`https://user:token@host/…`); the export never does.
 * SSH remotes become https so the reader can open the commit links.
 * @param {string} remote
 */
export function publicRemote(remote) {
  const trimmed = String(remote).trim();
  const ssh = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return trimmed.replace(/^(https?:\/\/)[^@/]+@/, "$1").replace(/\.git$/, "");
}

/**
 * @param {{ repo: string, remote: string, branch: string, head: string, dirty: number, date: string,
 *   recordPath: string, note?: string, start?: string }} facts
 * @param {ReturnType<typeof parseRecord>} record
 */
export function renderExport(facts, record) {
  const commitRef = (sha) => (/github\.com/.test(facts.remote) ? `${facts.remote}/commit/${sha}` : sha);
  const lines = [
    `# Handoff · ${facts.repo} · ${record.title || record.id.slice(0, 8)}`,
    "",
    `- **Repo:** ${facts.repo} — ${facts.remote || "(no remote)"}`,
    `- **Branch:** \`${facts.branch}\` at \`${facts.head}\``,
    `- **Working tree:** ${facts.dirty === 0 ? "clean" : `dirty (${facts.dirty} path(s) — see \`Resume:\`)`}`,
    `- **Written:** ${facts.date}, from ledger record \`${facts.recordPath}\` (session \`${record.id.slice(0, 8)}\`)`,
  ];
  if (facts.note) lines.push("", `**For the next agent:** ${facts.note}`);
  lines.push(
    "",
    `**Suggested start:** ${facts.start || "read `AGENTS.md` in the repo, then begin at the `Resume:` item under Next."}`,
    "",
    "Items that open with `(unverified)` were never checked by the session that wrote them — confirm before relying on them.",
  );
  for (const heading of SECTIONS) lines.push("", `## ${heading}`, "", record.sections.get(heading) ?? "None.");
  lines.push("", "## References", "", "By path or URL only; open them in the repo at the commit above.", "");
  if (record.commits.length) lines.push(`- Commits: ${record.commits.map(commitRef).join(", ")}`);
  if (record.files.length) lines.push(`- Files the session touched: ${record.files.map((f) => `\`${f}\``).join(", ")}`);
  lines.push("");
  return redactSecrets(lines.join("\n"));
}

/** @param {string[]} args */
function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** @param {string[]} argv @param {string} name */
function option(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function main() {
  const argv = process.argv.slice(2);
  const recordArg = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  if (!recordArg) {
    console.error("ledger-export: pass the record path (session-ledger --record)");
    process.exit(1);
  }
  const recordPath = resolve(REPO_ROOT, recordArg);
  if (!existsSync(recordPath)) {
    console.error(`ledger-export: no record at ${recordArg}`);
    process.exit(1);
  }
  const record = parseRecord(readFileSync(recordPath, "utf8"));
  // Commits made through the commit script are found by trailer; older records stored their own.
  record.commits = [...new Set([...record.commits, ...(readCommitFacts(REPO_ROOT).commitsBySession.get(record.id) ?? [])])];
  // An export of placeholders reads as a handoff and says nothing; write the record first.
  if (!record.sections.has("Intent") || !record.sections.has("Next")) {
    console.error("ledger-export: the record still has placeholder Intent or Next — run /handoff first");
    process.exit(1);
  }
  const date = new Date().toLocaleDateString("sv");
  const repo = basename(REPO_ROOT);
  const out = resolve(
    option(argv, "--out") ?? join(homedir(), "handoffs", `${repo}-${date}-${record.id.slice(0, 8)}.md`),
  );
  const facts = {
    repo,
    remote: publicRemote(git(["remote", "get-url", "origin"])),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown",
    head: git(["rev-parse", "--short", "HEAD"]) || "unknown",
    dirty: git(["status", "--porcelain"]).split("\n").filter(Boolean).length,
    date,
    recordPath: recordArg.replace(/\\/g, "/"),
    note: option(argv, "--note"),
    start: option(argv, "--start"),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderExport(facts, record), "utf8");
  console.log(out);
}

if (isDirectRun(import.meta.url)) main();
