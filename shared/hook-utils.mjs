// Helpers shared by the agent-kit hook scripts. Edit this file only here, in `shared/`:
// `scripts/vendor-shared.mjs` copies it into every plugin's `lib/`, so each plugin stays
// self-contained once installed. Node built-ins only; no imports from other kit files.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Tools that write a file named in `tool_input.file_path`. */
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Where Claude Code puts the linked worktrees of a checkout, relative to its root. */
export const WORKTREES_DIR = join(".claude", "worktrees");

/**
 * Set on a hook process that another hook handed its payload to (`runWorktreeCopy`), so the
 * child does not hand off in turn.
 */
export const HANDED_OFF_ENV = "AGENT_KIT_HANDED_OFF";

let cachedRoot = null;

/**
 * The project root a hook works on. A plugin's scripts live in the plugin cache, not in the
 * project, so the root cannot be derived from this file's location. Order: `CLAUDE_PROJECT_DIR`
 * (exported to plugin hook processes), then the git top level of the working directory, then the
 * working directory itself. Memoized: one hook process serves one project.
 */
export function projectRoot() {
  if (cachedRoot !== null) return cachedRoot;
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv) {
    cachedRoot = resolve(fromEnv);
    return cachedRoot;
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  cachedRoot = top.status === 0 && top.stdout.trim() ? resolve(top.stdout.trim()) : process.cwd();
  return cachedRoot;
}

/** Repo-relative POSIX path for an absolute or cwd-relative file path, or null when outside the repo. */
export function repoRelativePath(filePath, cwd = process.cwd(), root = projectRoot()) {
  if (typeof filePath !== "string" || filePath === "") return null;
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const rel = relative(root, absolute).split("\\").join("/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * `git worktree list --porcelain` → one entry per worktree, in git's order: the first is the main
 * checkout (or a bare repository's entry, marked `bare`). `branch` is null on a detached HEAD.
 * @param {string} porcelain
 * @returns {{ path: string, head: string | null, branch: string | null, main: boolean, bare: boolean }[]}
 */
export function parseWorktrees(porcelain) {
  return porcelain
    .split(/\r?\n[ \t]*\r?\n/)
    .map((block) => block.split(/\r?\n/))
    .filter((lines) => lines.some((line) => line.startsWith("worktree ")))
    .map((lines, index) => {
      const field = (name) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? null;
      const ref = field("branch");
      return {
        path: field("worktree"),
        head: field("HEAD"),
        branch: ref ? ref.replace(/^refs\/heads\//, "") : null,
        main: index === 0,
        bare: lines.includes("bare"),
      };
    });
}

/**
 * Paths that are dirty in git — modified, added, deleted, renamed or untracked — repo-relative.
 * Both sides of a rename are included, so the old path's deletion can be staged too.
 * @param {string} [root] @param {{ nullOnError?: boolean }} [options] null instead of an empty set when
 *   `git status` fails, for a caller that must not read a failure as "nothing dirty"
 * @returns {Set<string> | null}
 */
export function gitDirtyFiles(root = projectRoot(), { nullOnError = false } = {}) {
  const status = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  const dirty = new Set();
  if (status.status !== 0) return nullOnError ? null : dirty;
  const entries = status.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    dirty.add(entry.slice(3));
    // `R  new\0old` / `C  new\0old`: the original path follows as its own entry.
    if (/^[RC]|^.[RC]/.test(entry.slice(0, 2)) && entries[i + 1] !== undefined) {
      dirty.add(entries[i + 1]);
      i += 1;
    }
  }
  return dirty;
}

/**
 * Whether a transcript `cwd` lies in this checkout. A linked worktree nests under
 * `.claude/worktrees/`, so a path inside it is in the repo folder yet in another tree, with its
 * own branch and its own dirty files.
 * @param {string} cwd @param {string} [root]
 */
export function isInCheckout(cwd, root = projectRoot()) {
  const inside = (dir, path) => {
    const rel = relative(dir, resolve(path));
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  return inside(root, cwd) && !inside(join(root, WORKTREES_DIR), cwd);
}

/**
 * Transcript folders of this checkout and of every worktree under it. Claude Code names a folder
 * after its session's working directory, so a worktree session's transcript sits in
 * `<slug>--claude-worktrees-<name>`, where this checkout's own folder never looks.
 * @param {string} [root] @param {string} [home]
 */
export function transcriptDirs(root = projectRoot(), home = homedir()) {
  const projects = join(home, ".claude", "projects");
  if (!existsSync(projects)) return [];
  const slug = root.replace(/[^A-Za-z0-9]/g, "-");
  return readdirSync(projects)
    .filter((name) => name === slug || name.startsWith(`${slug}--claude-worktrees-`))
    .map((name) => join(projects, name));
}

/** The first `cwd` recorded in a list of transcript lines, or null. */
function firstCwd(lines) {
  for (const line of lines) {
    const raw = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
    if (raw) return JSON.parse(`"${raw}"`);
  }
  return null;
}

/**
 * The checkout a transcript's turns ran in: the worktree under `root` its first `cwd` names, or
 * `root` itself. Read from the lines, not the folder name, because a slug cannot be turned back
 * into a path, and the worktree may be gone by the time the transcript is read.
 * @param {string} transcriptPath @param {string} [root]
 */
export function transcriptRoot(transcriptPath, root = projectRoot()) {
  const cwd = firstCwd(readFileSync(transcriptPath, "utf8").split("\n"));
  if (cwd === null) return root;
  const worktrees = join(root, WORKTREES_DIR);
  const rel = relative(worktrees, resolve(cwd));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(worktrees, rel.split(/[\\/]/)[0]) : root;
}

/**
 * The worktree a hook payload's `cwd` belongs to, when it lies under `<root>/.claude/worktrees/`
 * and that worktree holds its own copy of the script at `scriptRel`. For a hook that runs a script
 * kept in the project: the app may run the main checkout's copy for a worktree session, and the
 * worktree's copy is the one that knows that tree. A worktree without the script gets null.
 * Unverified for plugin hooks, whose scripts live in the plugin cache rather than the project.
 * @param {unknown} cwd The payload's cwd. @param {string} scriptRel Script path relative to a checkout root.
 * @param {string} [root] The checkout whose copy is running. @param {(path: string) => boolean} [exists]
 * @returns {{ dir: string, script: string } | null}
 */
export function linkedWorktreeScript(cwd, scriptRel, root = projectRoot(), exists = existsSync) {
  if (typeof cwd !== "string" || cwd === "" || typeof scriptRel !== "string" || scriptRel === "") return null;
  const worktrees = join(root, WORKTREES_DIR);
  const rel = relative(worktrees, resolve(cwd));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const dir = join(worktrees, rel.split(/[\\/]/)[0]);
  const script = join(dir, scriptRel);
  return exists(script) ? { dir, script } : null;
}

/**
 * Run a worktree's copy of a hook script on the same payload: synchronous, with the child's output
 * inherited, and `HANDED_OFF_ENV` set so the child does not hand off in turn. A failure is
 * reported on stderr under `label` and never thrown: a hook that cannot hand off still completes.
 * @param {{ dir: string, script: string }} target @param {object} payload
 * @param {string} label The calling hook's name. @param {number} timeoutMs
 */
export function runWorktreeCopy(target, payload, label, timeoutMs) {
  const result = spawnSync(process.execPath, [target.script], {
    cwd: target.dir,
    input: JSON.stringify(payload),
    stdio: ["pipe", "inherit", "inherit"],
    timeout: timeoutMs,
    env: { ...process.env, [HANDED_OFF_ENV]: "1" },
  });
  if (result.status !== 0) {
    const reason = result.error ? result.error.message : `exit ${result.status}`;
    console.error(`${label}: hand-off to ${target.script} failed (${reason})`);
  }
}

/**
 * Append one line to a diagnostic log in the git common dir — the main checkout's `.git/`, shared
 * by every worktree and never tracked. Diagnostic only: a failure is reported on stderr and never
 * stops the hook.
 * @param {string} name Log file name. @param {string} line One line, without its newline.
 * @param {string} [root] The checkout to resolve the common dir from.
 * @returns {boolean} whether the line was written
 */
export function appendHookLog(name, line, root = projectRoot()) {
  try {
    const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
    if (common.status !== 0) return false;
    appendFileSync(join(resolve(root, common.stdout.trim()), name), `${line}\n`);
    return true;
  } catch (error) {
    console.error(`hook: could not write ${name}: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/**
 * A session's transcript lines, then its sub-agents' (`<id>/subagents/*.jsonl`): a sub-agent's
 * tool calls never appear in the parent's file, yet its edits are the session's work. A sub-agent
 * that ran with `isolation: "worktree"` worked in another tree on its own branch, so its file is
 * skipped: its paths would be read against this checkout's dirty files.
 * @param {string} transcriptPath @param {string} [root]
 */
export function readTranscriptLines(transcriptPath, root = projectRoot()) {
  const subagents = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  const lines = readFileSync(transcriptPath, "utf8").split("\n");
  if (!existsSync(subagents)) return lines;
  for (const name of readdirSync(subagents).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const own = readFileSync(join(subagents, name), "utf8").split("\n");
    const cwd = firstCwd(own);
    if (cwd !== null && !isInCheckout(cwd, root)) continue;
    lines.push(...own);
  }
  return lines;
}

/**
 * Whether the module at `metaUrl` is the process entry (`node <that file>`) rather than an import,
 * so a hook runs its `main()` only when invoked directly. Both sides are real paths: Node resolves
 * the entry's symlinks for `import.meta.url` while `process.argv[1]` is the path as typed, and a
 * plain URL comparison makes every hook a silent no-op under a symlinked checkout.
 * @param {string} metaUrl The caller's `import.meta.url`.
 */
export function isDirectRun(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

/** Claude Code hands the hook payload to stdin as a single JSON document. */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`hook: invalid JSON payload: ${message}`);
    return {};
  }
}

/** Repo-relative POSIX path of the file an Edit/Write tool targeted, or null when outside the repo. */
export function editedFilePath(input) {
  return repoRelativePath(input?.tool_input?.file_path, input?.cwd ?? process.cwd());
}

/**
 * Files that define *how work is done* in a project — the agent layer, settings, MCP servers and
 * the kit manifest — as opposed to the product code. A session that edits one is a process
 * change. Directories match recursively. A project adds its own through `extra`.
 */
export const PROCESS_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "kit.json",
  ".claude/settings.json",
  ".claude/launch.json",
  ".claude/commands",
  ".claude/agents",
  ".claude/rules",
  ".claude/skills",
  ".mcp.json",
];

/** @param {string} path repo-relative POSIX path @param {readonly string[]} [extra] project-specific additions */
export function isProcessPath(path, extra = []) {
  return [...PROCESS_PATHS, ...extra].some((root) => path === root || path.startsWith(`${root}/`));
}
