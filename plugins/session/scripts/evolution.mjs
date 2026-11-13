/**
 * Evolution pages: how a project's way of working and its features grew, one page each with one
 * Mermaid flowchart (stages as subgraphs, changes as boxes) and a Sources table (`evolution` on
 * the Bash PATH, from the plugin's `bin/`):
 *
 *   evolution [status] [--since-release [<tag>] | --base <ref>]
 *                                  each page's version, last_verified and check result, and what is
 *                                  not on it yet: the changelog's `## Unreleased` lines (the triaged
 *                                  list), and the commits since the last release tag (or since the
 *                                  page's last_verified, or in <ref>..HEAD) that changed the process
 *   evolution init [--lang <xx>]... [--no-mirror]
 *                                  write the missing pages; a mirror per language the repo already
 *                                  keeps `*.<xx>.md` pages in (Ukrainian gets a translated template)
 *   evolution bump <page> [--patch] [--date YYYY-MM-DD] [--no-render]
 *                                  raise `version:` (minor, or patch), set `last_verified:`, move the
 *                                  printable link to the new version, the same in every mirror, and
 *                                  run kit.json `commands.evolutionRender` when the page links one
 *   evolution check [<page>...]    lint each page and its mirrors; exit 1 on an error
 *
 * The folder is `kit.json` `paths.evolution` (default `docs/evolution`); the pages are
 * `process-evolution.md` and `features-evolution.md`. A project switches the log on by having
 * them: with no pages every command but `init` says so and exits 0. The pages are brought up to
 * date once per release, not per session: the `kit release` dry run names a page not changed since
 * the last release, and the `evolution` skill says how to triage and write the boxes.
 *
 * `check` is a structural lint, not Mermaid's own parser (which needs a browser): an unknown
 * diagram type is reported as not checked. Exit codes: 0 fine, 1 a check error or a failed render,
 * 2 a usage error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { isUnreleasedHeading } from "../lib/changelog.mjs";
import { isDirectRun, isProcessPath } from "../lib/hook-utils.mjs";
import { readKit, rootFor } from "../lib/kit-config.mjs";

const USAGE = `Usage: evolution [status [--since-release [<tag>] | --base <ref>] | init [--lang <xx>]... [--no-mirror] | bump <page> [--patch] [--date YYYY-MM-DD] [--no-render] | check [<page>...]]

  status    each page's version, last_verified and check result, and what is not on it yet: the
            changelog's ## Unreleased lines, and the commits that changed the process (or, with no
            Unreleased lines, shipped a feature) since the page's last_verified; --since-release
            counts from the last release tag (kit.json release.tag, else stable, else the newest
            tag; a page verified later counts from its last_verified), --base from <ref>.
            Run it before a release.
  init      write the missing pages under kit.json paths.evolution (default docs/evolution),
            with a mirror per language the repo already keeps *.<xx>.md pages in
  bump      raise the page's version (minor; --patch for a correction), set last_verified, move
            the printable link, the same in each mirror, then run commands.evolutionRender
  check     lint each page and its mirrors (front matter, diagram structure, mirror parity)

  <page> is process, features, a file name in the folder, or a repo-relative path.`;

/** The two pages a project keeps, by kind. */
export const PAGES = Object.freeze({ process: "process-evolution.md", features: "features-evolution.md" });

/** Paths outside `PROCESS_PATHS` that also change the way of working. */
const EXTRA_PROCESS_PATHS = [".github/workflows", ".githooks", "lefthook.yml", ".husky"];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIRROR = /^(.+)\.([a-z]{2}(?:-[A-Z]{2})?)\.md$/;

// ---------------------------------------------------------------------------------------------
// Reading a page

/** `YYYY-MM-DD` in local time. @param {Date} [date] */
export function today(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A front-matter value without YAML quotes. @param {string} value */
function unquote(value) {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * The parts of an evolution page the tools read.
 * @param {string} text
 */
export function parsePage(text) {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const head = clean.match(/^---\n([\s\S]*?)\n---\n/);
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of (head?.[1] ?? "").split("\n")) {
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (field && field[2].trim() !== "") fields[field[1]] = unquote(field[2]);
  }
  const body = head ? clean.slice(head[0].length) : clean;
  const mermaid = body.match(/```mermaid\n([\s\S]*?)```/)?.[1] ?? null;
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^## (Sources|Джерела)\s*$/.test(line.trim()));
  let sourcesRows = null;
  if (start !== -1) {
    const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
    const table = lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.trim().startsWith("|"));
    sourcesRows = Math.max(0, table.length - 2);
  }
  const printable = [...body.matchAll(/\(([^()\s]*-v(\d+\.\d+\.\d+)\.pdf)\)/g)].map((m) => ({ link: m[1], version: m[2] }));
  return {
    hasFrontMatter: Boolean(head),
    id: fields.id ?? null,
    version: fields.version ?? null,
    lastVerified: fields.last_verified ?? null,
    title: body.match(/^# (.+)$/m)?.[1].trim() ?? null,
    mermaid,
    sourcesRows,
    printable,
  };
}

// ---------------------------------------------------------------------------------------------
// The diagram lint

const STATEMENT = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;
const ID = /[A-Za-z_][\w]*/g;

/** A line with its quoted text replaced by `""`, and how many quotes it had. @param {string} line */
function stripQuotes(line) {
  const quotes = (line.match(/"/g) ?? []).length;
  return { text: line.replace(/"[^"]*"/g, '""'), quotes };
}

/** Bracketed labels, `|edge labels|` and text on a link (`a -- text --> b`) removed. @param {string} text */
function stripLabels(text) {
  let out = text.replace(/\|[^|]*\|/g, " ").replace(/(^|\s)(--|==|-\.)\s(.+?)\s(-{2,}>?|={2,}>?|\.-+>?)(?=\s|$)/g, "$1$4");
  for (let i = 0; i < 4; i += 1) out = out.replace(/\[[^\[\]]*\]|\([^()]*\)|\{[^{}]*\}/g, " ");
  return out;
}

/** Whether a stripped line holds an edge. @param {string} text */
function hasEdge(text) {
  return /--|==|-\.|\.-|~~~/.test(text);
}

/**
 * A structural lint of a Mermaid flowchart: balanced quotes, brackets and `subgraph`/`end`, every
 * class used by a `class` line defined by a `classDef`, and every id an edge, `class` or `style`
 * line names defined somewhere (a typo there draws a new, unlabelled box). Errors break the
 * render; warnings draw something the author did not mean. Not Mermaid's parser.
 * @param {string} source The text inside the ```mermaid fence.
 * @returns {{ type: string | null, checked: boolean, ids: string[], findings: Array<{ level: "error" | "warn", message: string }> }}
 */
export function lintMermaid(source) {
  /** @type {Array<{ level: "error" | "warn", message: string }>} */
  const findings = [];
  const lines = source.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "" && !line.trim().startsWith("%%"));
  const type = first === -1 ? null : lines[first].trim().split(/\s+/)[0];
  if (type === null) return { type, checked: false, ids: [], findings: [{ level: "error", message: "the diagram is empty" }] };
  if (type !== "flowchart" && type !== "graph") return { type, checked: false, ids: [], findings: [] };

  const defined = new Set();
  const classDefs = new Set();
  /** @type {Array<{ id: string, line: number, what: string }>} */
  const idRefs = [];
  /** @type {Array<{ name: string, line: number }>} */
  const classRefs = [];
  let depth = 0;

  lines.forEach((raw, index) => {
    const n = index + 1;
    const line = raw.trim();
    if (index <= first || line === "" || line.startsWith("%%")) return;
    const { text, quotes } = stripQuotes(line);
    if (quotes % 2 === 1) findings.push({ level: "error", message: `line ${n}: a quote is not closed` });
    if (/^subgraph\b/.test(text)) {
      depth += 1;
      const id = text.slice("subgraph".length).trim().match(/^[A-Za-z_]\w*/)?.[0];
      if (id) defined.add(id);
      return;
    }
    if (text === "end") {
      depth -= 1;
      if (depth < 0) {
        findings.push({ level: "error", message: `line ${n}: \`end\` without a \`subgraph\`` });
        depth = 0;
      }
      return;
    }
    const statement = text.match(STATEMENT)?.[1];
    if (statement === "classDef") {
      const name = text.split(/\s+/)[1];
      if (name) classDefs.add(name);
      return;
    }
    if (statement === "class") {
      const [, ids = "", name] = text.split(/\s+/);
      for (const id of ids.split(",").filter(Boolean)) idRefs.push({ id, line: n, what: "class" });
      if (name) classRefs.push({ name, line: n });
      return;
    }
    if (statement === "style" || statement === "click") {
      const id = text.split(/\s+/)[1];
      if (id) idRefs.push({ id, line: n, what: statement });
      return;
    }
    if (statement) return;
    for (const [open, close] of [["[", "]"], ["(", ")"], ["{", "}"]]) {
      const opened = text.split(open).length - 1;
      const closed = text.split(close).length - 1;
      if (opened !== closed) findings.push({ level: "error", message: `line ${n}: ${opened} \`${open}\` against ${closed} \`${close}\`` });
    }
    for (const match of text.matchAll(/([A-Za-z_]\w*)\s*(?=[\[\(\{])/g)) defined.add(match[1]);
    const bare = stripLabels(text);
    if (!hasEdge(bare)) {
      // A node on its own line (`a`, `a & b`) defines it.
      for (const id of bare.replace(/[^\w\s&]/g, " ").match(ID) ?? []) defined.add(id);
      return;
    }
    // `--o` and `--x` arrowheads leave an `o` or `x` behind; they are never taken for an id.
    for (const id of bare.replace(/[^\w\s&]/g, " ").match(ID) ?? []) {
      if (id !== "o" && id !== "x") idRefs.push({ id, line: n, what: "edge" });
    }
  });

  if (depth > 0) findings.push({ level: "error", message: `${depth} \`subgraph\` without its \`end\`` });
  for (const { name, line } of classRefs) {
    if (!classDefs.has(name)) findings.push({ level: "error", message: `line ${line}: class \`${name}\` has no \`classDef\`` });
  }
  const reported = new Set();
  for (const { id, line, what } of idRefs) {
    if (defined.has(id) || reported.has(id)) continue;
    reported.add(id);
    findings.push({ level: "warn", message: `line ${line}: \`${id}\` (${what}) is not defined with a label; a typo draws a new empty box` });
  }
  return { type, checked: true, ids: [...defined].sort(), findings };
}

/**
 * Findings for one page, and for its mirrors against it.
 * @param {string} text @param {Array<{ name: string, text: string }>} [mirrors]
 * @returns {Array<{ level: "error" | "warn", message: string }>}
 */
export function lintPage(text, mirrors = []) {
  const page = parsePage(text);
  /** @type {Array<{ level: "error" | "warn", message: string }>} */
  const findings = [];
  if (!page.hasFrontMatter) findings.push({ level: "error", message: "no front matter (`---` with `version:` and `last_verified:`)" });
  if (!page.version) findings.push({ level: "error", message: "no `version:` in the front matter" });
  else if (!SEMVER.test(page.version)) findings.push({ level: "error", message: `\`version: ${page.version}\` is not MAJOR.MINOR.PATCH` });
  if (!page.lastVerified) findings.push({ level: "error", message: "no `last_verified:` in the front matter" });
  else if (!ISO_DATE.test(page.lastVerified)) findings.push({ level: "error", message: `\`last_verified: ${page.lastVerified}\` is not YYYY-MM-DD` });
  for (const { link, version } of page.printable) {
    if (page.version && version !== page.version) findings.push({ level: "error", message: `the printable link ${link} names v${version}, the page is v${page.version}: run \`evolution bump\` or re-render` });
  }
  let ids = null;
  if (page.mermaid === null) findings.push({ level: "error", message: "no ```mermaid block" });
  else {
    const lint = lintMermaid(page.mermaid);
    ids = lint.checked ? lint.ids : null;
    if (!lint.checked && lint.type) findings.push({ level: "warn", message: `a \`${lint.type}\` diagram: its structure is not checked` });
    findings.push(...lint.findings);
  }
  if (page.sourcesRows === null) findings.push({ level: "warn", message: "no `## Sources` table: each box should name the commit or release it comes from" });
  for (const mirror of mirrors) {
    const other = parsePage(mirror.text);
    if (other.version !== page.version) findings.push({ level: "error", message: `${mirror.name} is v${other.version ?? "?"}, the page is v${page.version ?? "?"}` });
    if (other.lastVerified !== page.lastVerified) findings.push({ level: "warn", message: `${mirror.name} was last verified ${other.lastVerified ?? "never"}, the page ${page.lastVerified ?? "never"}` });
    if (other.mermaid === null) {
      findings.push({ level: "error", message: `${mirror.name} has no \`\`\`mermaid block` });
      continue;
    }
    const lint = lintMermaid(other.mermaid);
    for (const finding of lint.findings) findings.push({ level: finding.level, message: `${mirror.name}: ${finding.message}` });
    if (ids && lint.checked) {
      const theirs = new Set(lint.ids);
      const missing = ids.filter((id) => !theirs.has(id));
      const extra = lint.ids.filter((id) => !ids.includes(id));
      if (missing.length > 0) findings.push({ level: "error", message: `${mirror.name} lacks the boxes ${missing.join(", ")}` });
      if (extra.length > 0) findings.push({ level: "error", message: `${mirror.name} has boxes the page lacks: ${extra.join(", ")}` });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Bumping a page

/**
 * The next version: minor resets patch; patch adds one.
 * @param {string} version @param {"minor" | "patch"} level
 */
export function nextVersion(version, level) {
  const match = String(version).match(SEMVER);
  if (!match) throw new Error(`version ${version} is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = match.slice(1).map(Number);
  return level === "patch" ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
}

/**
 * The page text with `version:` and `last_verified:` set and every printable link moved to the
 * new version. A field missing from the front matter is added.
 * @param {string} text @param {string} version @param {string} date
 */
export function applyBump(text, version, date) {
  const head = text.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/);
  if (!head) throw new Error("the page has no front matter");
  let fields = head[2];
  const set = (name, value) => {
    const line = new RegExp(`^${name}:.*$`, "m");
    fields = line.test(fields) ? fields.replace(line, `${name}: ${value}`) : `${fields}\n${name}: ${value}`;
  };
  set("version", version);
  set("last_verified", date);
  const body = text.slice(head[0].length).replace(/(-v)\d+\.\d+\.\d+(\.pdf)/g, `$1${version}$2`);
  return `${head[1]}${fields}${head[3]}${body}`;
}

// ---------------------------------------------------------------------------------------------
// The commits not on a page

/**
 * Commits classified for the two pages. A commit that touches a process path belongs to the
 * process page; a `feat` commit that touches anything else belongs to the features page (both,
 * when it does both). Merges are skipped.
 * @param {Array<{ date: string, subject: string, files: string[] }>} commits
 * @param {string[]} extraProcess
 */
export function classifyCommits(commits, extraProcess = []) {
  const extra = [...EXTRA_PROCESS_PATHS, ...extraProcess];
  /** @type {{ process: typeof commits, features: typeof commits }} */
  const out = { process: [], features: [] };
  for (const commit of commits) {
    const processFiles = commit.files.filter((file) => isProcessPath(file, extra));
    if (processFiles.length > 0) out.process.push({ ...commit, files: processFiles });
    const isFeat = /^feat(\([^)]*\))?!?:/.test(commit.subject);
    if (isFeat && commit.files.some((file) => !isProcessPath(file, extra))) out.features.push(commit);
  }
  return out;
}

/** `git log` output with `%x1e%ad%x1f%s` and `--name-only`. @param {string} out */
export function parseLog(out) {
  return out
    .split("\x1e")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const [headLine, ...rest] = chunk.split("\n");
      const [date, subject] = headLine.split("\x1f");
      return { date: date.trim(), subject: (subject ?? "").trim(), files: rest.map((line) => line.trim()).filter(Boolean) };
    });
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Commits in a range (`a..b`) or after a day, oldest first.
 * @param {string} root @param {{ range?: string, after?: string }} which
 */
function commitsIn(root, { range, after }) {
  const args = ["log", "--no-merges", "--reverse", "--date=short", "--format=%x1e%ad%x1f%s", "--name-only"];
  if (range) args.push(range);
  // `--after` reads the committer date, which a rebase moves forward: a coarse filter, then the
  // author date (the one shown) decides.
  else if (after) args.push(`--after=${after} 00:00:00`);
  const out = git(args, root);
  if (out === null) return null;
  const commits = parseLog(out);
  return after && !range ? commits.filter((commit) => commit.date > after) : commits;
}

/**
 * The tag the last release moved or made: `kit.json` `release.tag`, else `stable`, when it exists;
 * else the newest tag reachable from HEAD; null without any.
 * @param {string} root @param {ReturnType<typeof readKit>} kit
 */
export function releaseTag(root, kit) {
  const named = typeof kit.raw?.release?.tag === "string" && kit.raw.release.tag.trim() ? kit.raw.release.tag.trim() : "stable";
  if (git(["rev-parse", "--verify", "-q", `refs/tags/${named}^{commit}`], root) !== null) return named;
  return git(["describe", "--tags", "--abbrev=0"], root)?.trim() || null;
}

/**
 * The changelog the release notes go to: the first `kit.json` `release.notes` entry in changelog
 * format without a language, else `CHANGELOG.md`. Repo-relative.
 * @param {ReturnType<typeof readKit>} kit
 */
export function changelogPath(kit) {
  const notes = Array.isArray(kit.raw?.release?.notes) ? kit.raw.release.notes : [];
  for (const entry of notes) {
    const item = typeof entry === "string" ? { path: entry } : entry ?? {};
    if (typeof item.path === "string" && item.path && (item.format ?? "changelog") === "changelog" && !item.lang) return item.path;
  }
  return "CHANGELOG.md";
}

/**
 * The items under `## Unreleased`: each top-level list item with its wrapped lines joined. These
 * are the release's triaged changes: someone judged each worth a line.
 * @param {string} text
 */
export function unreleasedItems(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex(isUnreleasedHeading);
  if (start === -1) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) items.push(item[1].trim());
    else if (/^\s+\S/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/** A long line cut at a word, for a list. @param {string} text @param {number} max */
function clip(text, max = 140) {
  if (text.length <= max) return text;
  return `${text.slice(0, text.lastIndexOf(" ", max - 1) > 40 ? text.lastIndexOf(" ", max - 1) : max - 1)} …`;
}

// ---------------------------------------------------------------------------------------------
// Files

/** @param {string} root @param {ReturnType<typeof readKit>} kit */
function folderOf(root, kit) {
  return { rel: kit.paths.evolution, abs: join(root, ...kit.paths.evolution.split("/")) };
}

/** Mirrors of `name` in `dir`: `<stem>.<lang>.md`. @param {string} dir @param {string} name */
export function mirrorsOf(dir, name) {
  if (!existsSync(dir)) return [];
  const stem = name.replace(/\.md$/, "");
  return readdirSync(dir)
    .filter((file) => {
      const match = file.match(MIRROR);
      return match !== null && match[1] === stem;
    })
    .sort();
}

/** Pages in the folder: every `*.md` with a mermaid block that is not a mirror. @param {string} dir */
function pagesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && !MIRROR.test(file) && /```mermaid/.test(readFileSync(join(dir, file), "utf8")))
    .sort();
}

/**
 * Resolve `process`, `features`, a file name in the folder or a repo-relative path to a page file.
 * @param {string} root @param {{ rel: string, abs: string }} folder @param {string} arg
 */
function resolvePage(root, folder, arg) {
  const candidates = [PAGES[arg] ? join(folder.abs, PAGES[arg]) : null, join(folder.abs, arg), join(folder.abs, `${arg}.md`), join(root, arg)];
  return candidates.find((file) => file && existsSync(file) && file.endsWith(".md")) ?? null;
}

/** The languages the repo keeps `*.<xx>.md` mirrors in. @param {string} root */
export function mirrorLanguages(root) {
  const out = git(["ls-files", "*.md"], root) ?? "";
  const langs = new Set();
  for (const file of out.split("\n")) {
    const match = basename(file).match(MIRROR);
    if (match && existsSync(join(root, dirname(file), `${match[1]}.md`))) langs.add(match[2]);
  }
  return [...langs].sort();
}

// ---------------------------------------------------------------------------------------------
// Templates

const CLASS_DEFS = {
  process: [
    "  classDef agentConfig fill:#a5d8ff,stroke:#1c7ed6,color:#0b3f75",
    "  classDef tooling fill:#dee2e6,stroke:#495057,color:#212529",
    "  classDef ledger fill:#ffec99,stroke:#f08c00,color:#5c3d00",
    "  classDef sdlc fill:#d0bfff,stroke:#7048e8,color:#3b1f9e",
    "  classDef git fill:#96f2d7,stroke:#0ca678,color:#054d3b",
    "  classDef docs fill:#d8f5a2,stroke:#66a80f,color:#3a5f0b",
    "  classDef planned stroke-dasharray:5 5",
  ],
  features: [
    "  classDef feature fill:#a5d8ff,stroke:#1c7ed6,color:#0b3f75",
    "  classDef infrastructure fill:#dee2e6,stroke:#495057,color:#212529",
    "  classDef planned stroke-dasharray:5 5",
  ],
};

const TEXT = {
  en: {
    process: {
      title: "How the way of working grew",
      intro:
        "The stages of how this project is built (agent rules and skills, hooks, CI, the work-item loop, docs rules) in the order they landed. Each box is one change; its Sources row names the commit. The features built over the same time: [features-evolution.md](features-evolution.md).",
      stage: "Stage 1: start",
      box: "[tooling] Project set up with agent-kit<br/>kit.json and the kit plugins",
      node: "Kit set up",
      source: "the commit that added `kit.json`",
      legend: [
        "**Stages** run top to bottom; boxes inside a stage are in commit order. When each landed is in the **When** column of the Sources table.",
        "**Tags and colors**: the `[tag]` that opens a box names the part of the workflow it changed, and its color follows the tag: **agent config** blue (rules, skills, agents, always-on context), **tooling** gray (hooks, MCP, scripts, CI), **ledger** yellow, **sdlc** violet (the work-item loop), **git** teal (branches, worktrees, landing), **docs** green (design rules, decision records, docs review). A dashed box is planned.",
        "Box text is the change, not the tool's whole feature list.",
      ],
    },
    features: {
      title: "How the features grew",
      intro:
        "The project's features in the order they landed, grouped by release. Each box is one feature or one release's worth of them; its Sources row names the commit or the CHANGELOG section. The way of working over the same time: [process-evolution.md](process-evolution.md).",
      stage: "Unreleased",
      box: "[infrastructure] Project start",
      node: "Project start",
      source: "the first commit",
      legend: [
        "**Releases** run top to bottom; boxes inside a release are in commit order. When each landed is in the **When** column of the Sources table.",
        "**Tags and colors**: the `[tag]` that opens a box names the product area; **feature** blue, **infrastructure** gray. Add a `classDef` per area the project needs. A dashed box is planned and turns solid once its work is on the base branch.",
        "Box text is what a user gets, not how it was built.",
      ],
    },
    legendHeading: "Legend",
    sourcesHeading: "Sources",
    columns: "| Node | When | Source |",
    switchLine: (name, langs) => `**English** · ${langs.map((lang) => `[${LANGUAGE_NAMES[lang] ?? lang}](${name.replace(/\.md$/, `.${lang}.md`)})`).join(" · ")}`,
  },
  uk: {
    process: {
      title: "Як зростав спосіб роботи",
      intro:
        "Етапи того, як будується цей проєкт (правила і скіли агента, хуки, CI, цикл робочих елементів, правила документації), у порядку, в якому вони з'являлися. Кожен блок — одна зміна; його рядок у «Джерелах» називає коміт. Функції, створені за той самий час: [features-evolution.uk.md](features-evolution.uk.md).",
      stage: "Етап 1: старт",
      box: "[tooling] Проєкт налаштовано з agent-kit<br/>kit.json і плагіни набору",
      node: "Kit set up",
      source: "коміт, що додав `kit.json`",
      legend: [
        "**Етапи** йдуть згори донизу; блоки всередині етапу — у порядку комітів. Коли з'явився кожен, видно в колонці **When** таблиці «Джерела».",
        "**Теги і кольори**: `[тег]` на початку блока називає частину процесу, яку він змінив, а колір відповідає тегу: **agent config** синій (правила, скіли, агенти, постійний контекст), **tooling** сірий (хуки, MCP, скрипти, CI), **ledger** жовтий, **sdlc** фіолетовий (цикл робочих елементів), **git** бірюзовий (гілки, worktree, злиття), **docs** зелений (правила дизайну, записи рішень, огляд документації). Пунктирний блок — запланований.",
        "Текст блока — це зміна, а не повний перелік можливостей інструмента.",
      ],
    },
    features: {
      title: "Як зростали функції",
      intro:
        "Функції проєкту в порядку появи, згруповані за релізами. Кожен блок — одна функція або набір функцій одного релізу; його рядок у «Джерелах» називає коміт або розділ CHANGELOG. Спосіб роботи за той самий час: [process-evolution.uk.md](process-evolution.uk.md).",
      stage: "Невипущене",
      box: "[infrastructure] Старт проєкту",
      node: "Project start",
      source: "перший коміт",
      legend: [
        "**Релізи** йдуть згори донизу; блоки всередині релізу — у порядку комітів. Коли з'явився кожен, видно в колонці **When** таблиці «Джерела».",
        "**Теги і кольори**: `[тег]` на початку блока називає частину продукту; **feature** синій, **infrastructure** сірий. Додайте `classDef` для кожної потрібної проєкту частини. Пунктирний блок — запланований; він стає суцільним, щойно його робота потрапила в базову гілку.",
        "Текст блока — це те, що отримує користувач, а не як це зроблено.",
      ],
    },
    legendHeading: "Легенда",
    sourcesHeading: "Джерела",
    columns: "| Node | When | Source |",
    switchLine: (name, langs, self) =>
      [`[English](${name})`, ...langs.map((lang) => (lang === self ? `**${LANGUAGE_NAMES[lang] ?? lang}**` : `[${LANGUAGE_NAMES[lang] ?? lang}](${name.replace(/\.md$/, `.${lang}.md`)})`))].join(" · "),
  },
};

const LANGUAGE_NAMES = { uk: "Українська", en: "English", de: "Deutsch", fr: "Français", es: "Español", pl: "Polski" };

/**
 * A new page, English or a mirror. A language without its own template gets the English text and
 * the switch line, to translate by hand.
 * @param {"process" | "features"} kind @param {string} date @param {string[]} langs Mirror languages.
 * @param {string | null} [lang] The mirror's language; null for the English page.
 */
export function template(kind, date, langs = [], lang = null) {
  const words = TEXT[lang ?? "en"] ?? TEXT.en;
  const text = words[kind];
  const name = PAGES[kind];
  const lines = ["---", `id: ${kind}-evolution`, "version: 1.0.0", `last_verified: ${date}`, "---", "", `# ${text.title}`, ""];
  if (langs.length > 0) {
    lines.push(lang === null ? TEXT.en.switchLine(name, langs) : TEXT.uk.switchLine(name, langs, lang), "");
  }
  const nodeId = kind === "process" ? "kitSetUp" : "projectStart";
  const stageId = kind === "process" ? "s1" : "unreleased";
  const firstClass = kind === "process" ? "tooling" : "infrastructure";
  lines.push(
    text.intro,
    "",
    "```mermaid",
    "flowchart TD",
    `  subgraph ${stageId}["${text.stage}"]`,
    `    ${nodeId}["${text.box}"]`,
    "  end",
    "",
    ...CLASS_DEFS[kind],
    `  class ${nodeId} ${firstClass}`,
    "```",
    "",
    `## ${words.legendHeading}`,
    "",
    ...text.legend.map((item, i) => `${i + 1}. ${item}`),
    "",
    `## ${words.sourcesHeading}`,
    "",
    words.columns,
    "| --- | --- | --- |",
    `| ${text.node} | ${date} | ${text.source} |`,
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Commands

/** @param {string[]} args @param {string} flag */
function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** @param {Array<{ level: string, message: string }>} findings */
function summary(findings) {
  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.length - errors;
  if (findings.length === 0) return "check passed";
  return [errors ? `${errors} error${errors === 1 ? "" : "s"}` : "", warns ? `${warns} warning${warns === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
}

/** @param {string} dir @param {string} name */
function lintFile(dir, name) {
  const mirrors = mirrorsOf(dir, name).map((file) => ({ name: file, text: readFileSync(join(dir, file), "utf8") }));
  return lintPage(readFileSync(join(dir, name), "utf8"), mirrors);
}

function noPages(folder, print) {
  print(`No evolution pages in ${folder.rel} (kit.json paths.evolution): \`evolution init\` starts them.`);
  return 0;
}

/** @param {string} root @param {ReturnType<typeof readKit>} kit @param {string[]} args @param {(line: string) => void} print */
export function cmdStatus(root, kit, args, print = console.log) {
  const folder = folderOf(root, kit);
  const present = Object.entries(PAGES).filter(([, name]) => existsSync(join(folder.abs, name)));
  if (present.length === 0) return noPages(folder, print);
  let base = valueOf(args, "--base") ?? null;
  const sinceAt = args.indexOf("--since-release");
  if (sinceAt !== -1) {
    const named = args[sinceAt + 1] && !args[sinceAt + 1].startsWith("--") ? args[sinceAt + 1] : null;
    base = named ?? releaseTag(root, kit);
    if (!base) print("No release tag yet: counting from each page's last_verified instead.");
  }
  const extra = [kit.paths.decisions];
  const changelog = changelogPath(kit);
  const changelogFile = join(root, ...changelog.split("/"));
  const items = existsSync(changelogFile) ? unreleasedItems(readFileSync(changelogFile, "utf8")) : [];
  const itemsAt = present.length + 1;
  print(`Evolution pages in ${folder.rel}${base ? `, counting from ${base}` : ""}:`);
  present.forEach(([kind, name], index) => {
    const n = index + 1;
    const text = readFileSync(join(folder.abs, name), "utf8");
    const page = parsePage(text);
    const mirrors = mirrorsOf(folder.abs, name);
    const findings = lintFile(folder.abs, name);
    const mirrorText = mirrors.length ? `; mirrors ${mirrors.join(", ")}` : "";
    const rel = `${folder.rel}/${name}`;
    const touched = base ? (spawnSync("git", ["diff", "--quiet", base, "--", rel], { cwd: root }).status === 0 ? `; unchanged since ${base}` : `; changed since ${base}`) : "";
    print(`${n}. ${name} v${page.version ?? "?"}, last verified ${page.lastVerified ?? "never"}, ${page.sourcesRows ?? 0} Sources rows${mirrorText}${touched}; ${summary(findings)}`);
    if (kind === "features" && items.length > 0) {
      print(`   Its candidates are the ${changelog} \`## Unreleased\` lines (${itemsAt} below), not the commits.`);
      return;
    }
    const verified = page.lastVerified && ISO_DATE.test(page.lastVerified) ? page.lastVerified : undefined;
    // A page verified after the release tag already covers what came before: count from the later.
    const tagDay = base && sinceAt !== -1 ? git(["log", "-1", "--format=%ad", "--date=short", base], root)?.trim() : undefined;
    const range = base && !(verified && tagDay && verified > tagDay) ? `${base}..HEAD` : null;
    const after = range ? undefined : verified;
    if (!range && !after) {
      print(`   No usable last_verified: the commits since cannot be listed.`);
      return;
    }
    const commits = commitsIn(root, { range: range ?? undefined, after });
    if (commits === null) {
      print(`   git log failed for ${range ?? `after ${after}`}.`);
      return;
    }
    const mine = classifyCommits(commits, extra)[/** @type {"process" | "features"} */ (kind)];
    const open = mine.filter((commit) => !text.includes(commit.subject));
    const scope = range ? `in ${range}` : `after ${after}`;
    if (open.length === 0) {
      print(`   Nothing ${kind === "process" ? "changed the way of working" : "shipped a feature"} ${scope} that the page does not name.`);
      return;
    }
    print(`   ${open.length} commit${open.length === 1 ? "" : "s"} ${scope} not named on the page (a box, a line in a box, or nothing):`);
    open.slice(0, 15).forEach((commit, i) => {
      const files = kind === "process" ? ` — ${commit.files.slice(0, 3).join(", ")}${commit.files.length > 3 ? ", …" : ""}` : "";
      print(`   ${n}.${i + 1}. ${commit.date} \`${commit.subject}\`${files}`);
    });
    if (open.length > 15) print(`   and ${open.length - 15} more.`);
  });
  if (items.length > 0) {
    print(`${itemsAt}. ${changelog} \`## Unreleased\`: ${items.length} line${items.length === 1 ? "" : "s"}, the triaged list for this release. Each is a box, a line in a box, or nothing, on either page:`);
    items.forEach((item, i) => print(`   ${itemsAt}.${i + 1}. ${clip(item)}`));
  } else {
    print(`${itemsAt}. ${changelog}: no \`## Unreleased\` lines; the commits above are the only candidates.`);
  }
  const render = kit.commands.evolutionRender;
  print(render ? `Renderer: \`${render}\` (commands.evolutionRender), run by \`evolution bump\`.` : "Renderer: none (kit.json commands.evolutionRender); a page's printable version, if it links one, is not re-rendered.");
  return 0;
}

/** @param {string} root @param {ReturnType<typeof readKit>} kit @param {string[]} args @param {(line: string) => void} print */
export function cmdInit(root, kit, args, print = console.log, date = today()) {
  const folder = folderOf(root, kit);
  const asked = args.flatMap((arg, i) => (args[i - 1] === "--lang" ? [arg] : []));
  const langs = args.includes("--no-mirror") ? [] : asked.length ? asked : mirrorLanguages(root);
  mkdirSync(folder.abs, { recursive: true });
  let written = 0;
  for (const kind of /** @type {Array<"process" | "features">} */ (Object.keys(PAGES))) {
    const files = [[PAGES[kind], null], ...langs.map((lang) => [PAGES[kind].replace(/\.md$/, `.${lang}.md`), lang])];
    for (const [file, lang] of files) {
      const path = join(folder.abs, file);
      if (existsSync(path)) {
        print(`kept ${folder.rel}/${file} (already there)`);
        continue;
      }
      writeFileSync(path, template(kind, date, langs, lang));
      written += 1;
      print(`wrote ${folder.rel}/${file}${lang && !TEXT[lang] ? " (English text: translate it)" : ""}`);
    }
  }
  if (written > 0) print("Next: replace the first box with the project's real first stage and feature, then commit the pages.");
  return 0;
}

/** @param {string} root @param {ReturnType<typeof readKit>} kit @param {string[]} args @param {(line: string) => void} print */
export function cmdBump(root, kit, args, print = console.log, run = runShell) {
  const folder = folderOf(root, kit);
  const target = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--date");
  if (!target) {
    console.error(`evolution bump: name a page (process, features, or a file)\n\n${USAGE}`);
    return 2;
  }
  const file = resolvePage(root, folder, target);
  if (!file) {
    console.error(`evolution bump: no page ${target} in ${folder.rel}`);
    return 2;
  }
  const date = valueOf(args, "--date") ?? today();
  if (!ISO_DATE.test(date)) {
    console.error(`evolution bump: --date ${date} is not YYYY-MM-DD`);
    return 2;
  }
  const level = args.includes("--patch") ? "patch" : "minor";
  const text = readFileSync(file, "utf8");
  const page = parsePage(text);
  let version;
  try {
    version = nextVersion(page.version ?? "", level);
  } catch (error) {
    console.error(`evolution bump: ${relative(root, file)}: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  writeFileSync(file, applyBump(text, version, date));
  const dir = dirname(file);
  const mirrors = mirrorsOf(dir, basename(file));
  for (const mirror of mirrors) {
    const path = join(dir, mirror);
    writeFileSync(path, applyBump(readFileSync(path, "utf8"), version, date));
  }
  const rel = relative(root, file).split("\\").join("/");
  print(`${rel}: v${page.version} → v${version}, last_verified ${date}${mirrors.length ? `; the same in ${mirrors.join(", ")}` : ""}.`);
  if (args.includes("--no-render")) return 0;
  const render = kit.commands.evolutionRender;
  if (!render) {
    if (page.printable.length > 0) print(`Printable version not rendered: kit.json sets no commands.evolutionRender. The link now names v${version}; render it with the project's own renderer, or report it as not rendered.`);
    return 0;
  }
  const quoted = `"${rel.replace(/(["\\$`])/g, "\\$1")}"`;
  const command = render.includes("{page}") ? render.replaceAll("{page}", quoted) : `${render} ${quoted}`;
  const status = run(command, root);
  if (status !== 0) {
    print(`Render failed (exit ${status}): \`${command}\`. The printable version is not current.`);
    return 1;
  }
  print(`Rendered: \`${command}\`.`);
  return 0;
}

/** @param {string} command @param {string} cwd */
function runShell(command, cwd) {
  return spawnSync(command, { cwd, shell: true, stdio: "inherit" }).status ?? 1;
}

/** @param {string} root @param {ReturnType<typeof readKit>} kit @param {string[]} args @param {(line: string) => void} print */
export function cmdCheck(root, kit, args, print = console.log) {
  const folder = folderOf(root, kit);
  const named = args.filter((arg) => !arg.startsWith("--"));
  const files = named.length ? named.map((arg) => resolvePage(root, folder, arg)) : pagesIn(folder.abs).map((name) => join(folder.abs, name));
  if (named.length) {
    const missing = named.filter((_, i) => !files[i]);
    if (missing.length) {
      console.error(`evolution check: no page ${missing.join(", ")} in ${folder.rel}`);
      return 2;
    }
  }
  if (files.length === 0) return noPages(folder, print);
  let errors = 0;
  files.forEach((file, index) => {
    const findings = lintFile(dirname(/** @type {string} */ (file)), basename(/** @type {string} */ (file)));
    errors += findings.filter((f) => f.level === "error").length;
    print(`${index + 1}. ${relative(root, /** @type {string} */ (file)).split("\\").join("/")}: ${summary(findings)}`);
    findings.forEach((finding, i) => print(`   ${index + 1}.${i + 1}. ${finding.level === "error" ? "ERROR" : "WARN"} ${finding.message}`));
  });
  return errors > 0 ? 1 : 0;
}

/** @param {string[]} argv @param {string} [cwd] */
export function main(argv, cwd = process.cwd()) {
  const [command = "status", ...args] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  const root = rootFor(cwd);
  const kit = readKit(root);
  if (kit.error) console.error(`evolution: ${kit.error}; using the default paths.`);
  switch (command) {
    case "status":
      return cmdStatus(root, kit, args);
    case "init":
      return cmdInit(root, kit, args);
    case "bump":
      return cmdBump(root, kit, args);
    case "check":
      return cmdCheck(root, kit, args);
    default:
      console.error(`evolution: unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
