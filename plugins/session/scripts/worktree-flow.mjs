import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDirectRun, parseWorktrees } from "../lib/hook-utils.mjs";
import { matchesAny } from "../lib/globs.mjs";
import { escapeRegExp, inLedger, readKit } from "../lib/kit-config.mjs";
import { BASE_KEY, ROLE_KEY, sessionRole } from "./session-role.mjs";

/**
 * The branch-and-worktree side of a session, from start to close-out (`worktree-flow` on the Bash
 * PATH, from the plugin's `bin/`):
 *
 *   worktree-flow status [--json]    every worktree: base, merged, pushed, dirty, verdict
 *   worktree-flow resolve <ref>      local branch for a work item (APP-123) or name; tracks origin's if only it exists
 *   worktree-flow base [<ref>]       show, or record, this branch's integration branch
 *   worktree-flow role [child|main]  show, or record, whether this is a sub-session (`session-role.mjs`)
 *   worktree-flow adopt <ref>        move a fresh worktree (no commits of its own) onto <ref>, then
 *                                    reinstall dependencies when a lockfile or manifest changed
 *   worktree-flow conflicts [--json] predicted merge conflicts with the base and every active worktree
 *   worktree-flow land [--dry-run]   fast-forward the base to this branch; never merges, never pushes
 *   worktree-flow land --dry-run --report   the same dry run, exiting 0 on a refusal too (close-out's preload)
 *   worktree-flow regenerate [--dry-run]    rebuild conflicted generated files by `kit.json` `regenerate`
 *   worktree-flow remove <path>      remove a clean worktree whose commits are all in its base
 *   worktree-flow stale-remote [--base <b>] [--landing] [<branch>...]
 *                                    which branches on origin the base already holds; deletes nothing
 *
 * A base comes from, in order: what `base <ref>` recorded (git config `branch.<name>.kitBase`), the
 * `base:` of the SDLC item whose `branch:` is this branch (`kit.json` `paths.sdlc`), else a
 * guess among the local branches, with `kit.json` `baseBranch` (default `dev`) winning a tie and
 * `dev`, `develop` or `development` next.
 *
 * The desktop app cuts a worktree from the branch picked on its New session screen but knows
 * nothing about where the work lands afterwards; this fills that gap. `land` is fast-forward only
 * on purpose: the base is merged into the worktree branch first, so a conflict is resolved by the session that made the
 * change, in its own worktree, and the integration branch never receives a conflicted merge.
 */

const TICKET = /^[A-Z][A-Z0-9]*-\d+$/i;

/** `kit.json` of the checkout at `dir`, read once per checkout. */
const kits = new Map();
function kitOf(dir) {
  if (!kits.has(dir)) kits.set(dir, readKit(dir));
  return kits.get(dir);
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? "").trim(),
  };
}

function gitOut(args, cwd) {
  const result = git(args, cwd);
  return result.ok ? result.out : null;
}

/**
 * A ticket or branch name → the local branch it means. Exact names win; a ticket matches a branch
 * that carries it as a whole segment (`feat/role-sync-APP-427`), and session branches
 * (`claude/…`) only when nothing else does, since those are worktrees, not integration branches.
 * @param {string} input
 * @param {string[]} branches
 * @returns {{ branch: string } | { candidates: string[] }}
 */
export function matchBranch(input, branches) {
  if (branches.includes(input)) return { branch: input };
  if (!TICKET.test(input)) return { candidates: [] };
  const segment = new RegExp(`(^|[-/_])${input}($|[-/_])`, "i");
  const hits = branches.filter((name) => segment.test(name));
  const integration = hits.filter((name) => !name.startsWith("claude/"));
  const pool = integration.length > 0 ? integration : hits;
  return pool.length === 1 ? { branch: pool[0] } : { candidates: pool };
}

/**
 * The integration branch most likely meant when nothing recorded one: the candidate holding the
 * most of this branch, then the one this branch is least behind, then the project's `baseBranch`,
 * then an integration branch (`dev`, `develop`, `development`) over any other. A fresh worktree cut
 * from `main` is zero ahead of both `main` and an item branch that contains `main`; the second key
 * picks `main`. A worktree cut from `dev` while `main` sits at the same commit picks `dev`.
 * @param {{ name: string, ahead: number, behind: number }[]} candidates ahead/behind of the worktree branch versus each
 * @param {string | null} [preferred] `kit.json` `baseBranch`, which wins a tie
 */
export function guessBase(candidates, preferred = null) {
  const rank = (name) => {
    if (name === preferred) return 0;
    const integration = INTEGRATION_BRANCHES.indexOf(name);
    return integration < 0 ? INTEGRATION_BRANCHES.length + 1 : integration + 1;
  };
  const sorted = [...candidates].sort((a, b) => a.ahead - b.ahead || a.behind - b.behind || rank(a.name) - rank(b.name));
  return sorted[0]?.name ?? null;
}

/** Integration branch names, in the order a tie prefers them after `kit.json` `baseBranch`. */
const INTEGRATION_BRANCHES = ["dev", "develop", "development"];

/**
 * What can happen to a worktree, from its facts. Pure, so the wording and the safety rule are tested.
 * `landedIn` is an integration branch holding every commit when the base does not (or none was
 * found): work landed on an item branch from a branch whose intent named `main` is still landed.
 * @param {{ main: boolean, self: boolean, branch: string | null, base: string | null, dirty: number, dirtyLedger: number, ahead: number | null, unpushed: number | null, baseUnpushed: number | null, landedIn?: string | null }} f
 * @returns {{ removable: boolean, verdict: string }}
 */
export function verdictFor(f) {
  if (f.main) return { removable: false, verdict: "main checkout" };
  if (f.self) return { removable: false, verdict: "this session" };
  if (f.dirty > 0) return { removable: false, verdict: `${f.dirty} uncommitted file(s) — keep` };
  // Archiving a session detaches its clean worktree into the app's reuse pool ("kept ready for new
  // sessions"), which the app reuses or reaps itself; removing one behind its back is not ours to do.
  if (!f.branch && (f.landedIn || f.ahead === 0)) {
    return {
      removable: false,
      verdict: "idle in the app's reuse pool (detached, merged) — the app reuses or reaps it",
    };
  }
  const ledger = f.dirtyLedger > 0 ? `; ${f.dirtyLedger} ledger record(s) uncommitted, lost on removal` : "";
  if (f.landedIn && (!f.base || f.ahead !== 0)) {
    return {
      removable: true,
      verdict: `merged into ${f.landedIn}${f.base ? `, not its base ${f.base}` : ""}${ledger}`,
    };
  }
  if (!f.base) return { removable: false, verdict: "no base found — record one with `base <ref>`" };
  if (f.ahead === null) return { removable: false, verdict: `cannot compare with ${f.base}` };
  if (f.ahead > 0) {
    const pushed = f.unpushed === null ? "not pushed" : f.unpushed === 0 ? "pushed" : `${f.unpushed} unpushed`;
    return { removable: false, verdict: `${f.ahead} commit(s) not in ${f.base} (${pushed}) — land or keep` };
  }
  if (f.baseUnpushed)
    return { removable: true, verdict: `merged into ${f.base} (push ${f.base}: ${f.baseUnpushed} ahead)${ledger}` };
  return { removable: true, verdict: `merged into ${f.base}${ledger}` };
}

/**
 * `git merge-tree --write-tree --name-only` output → conflicted paths. Exit 1 means conflicts: the
 * first line is the tree, the paths follow up to the blank line before the messages.
 * @param {string} out
 */
export function parseMergeTree(out) {
  const [, ...rest] = out.split(/\r?\n/);
  const end = rest.indexOf("");
  return [...new Set(end === -1 ? rest : rest.slice(0, end))].filter(Boolean);
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all` → one entry per path; a rename or copy
 * carries its source as the next field, which is skipped.
 * @param {string} out
 * @returns {{ code: string, path: string }[]}
 */
export function parseStatusZ(out) {
  const fields = out.split("\0");
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (code[0] === "R" || code[0] === "C") i++;
  }
  return entries;
}

/**
 * What `adopt` does with each uncommitted path before `git checkout -B`. A fresh worktree is not
 * empty: the SessionStart hooks may write `.codegraph/` and the ledger's `INDEX.md`, which one
 * branch neither tracks nor ignores while another tracks `.codegraph/.gitignore` byte for byte. So
 * an untracked file the target lacks is carried along untouched (checkout leaves it alone), one
 * identical to the target's copy is dropped (checkout writes it back), and anything else — a
 * tracked edit, or an untracked file the target holds differently — is the session's own work.
 * Ledger paths (`kit.json` `paths.ledger`) are never in the way.
 * @param {{ code: string, path: string, target: "absent" | "same" | "differs" | null }[]} entries
 *   `target` compares an untracked path with the target's tree; null for a tracked change
 * @param {string} [ledger] the ledger folder, repo-relative
 * @returns {{ drop: string[], blockers: string[] }}
 */
export function adoptPlan(entries, ledger = ".claude/ledger") {
  const drop = [];
  const blockers = [];
  const kit = { paths: { ledger } };
  for (const { code, path, target } of entries) {
    if (inLedger(path, kit)) continue;
    if (code !== "??") blockers.push(path);
    else if (target === "same") drop.push(path);
    else if (target !== "absent") blockers.push(path);
  }
  return { drop, blockers };
}

/** Files whose change between two commits means the installed dependencies may no longer match. */
const DEPENDENCY_FILE =
  /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|pyproject\.toml|uv\.lock|poetry\.lock|requirements[^/]*\.txt)$/;

/**
 * A `kit.json` command string → its argv, so it spawns without a shell; null when it needs one
 * (an operator, a redirect, a variable, a substitution), since splitting `pnpm install && pnpm build`
 * would hand `&&`, `pnpm` and `build` to `pnpm install` as packages to add. Quotes group, then go. Pure.
 * @param {string} line
 * @returns {string[] | null}
 */
export function commandArgv(line) {
  const argv = [];
  let word = null;
  let quote = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) argv.push(word);
      word = null;
    } else if (/[&|;<>$`()\\%^]/.test(ch)) return null;
    else word = (word ?? "") + ch;
  }
  if (quote) return null;
  if (word !== null) argv.push(word);
  return argv.length ? argv : null;
}

/**
 * Whether `adopt` installs dependencies after its checkout, from the facts. Pure.
 * @param {{ changed: string[], nodeModulesMissing: boolean, install: string | undefined }} f
 *   `changed` the paths that differ between the old and the new commit; `nodeModulesMissing` true
 *   when the checkout has a `package.json` but no `node_modules`; `install` `kit.json` `commands.install`
 * @returns {{ action: "none" } | { action: "run", reason: string, argv: string[] } | { action: "hint", reason: string, why: string }}
 */
export function adoptInstallPlan({ changed, nodeModulesMissing, install }) {
  const files = changed.filter((path) => DEPENDENCY_FILE.test(path));
  if (files.length === 0 && !nodeModulesMissing) return { action: "none" };
  const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? ` and ${files.length - 3} more` : "");
  const reason = files.length ? `${shown} changed` : "node_modules is missing";
  if (!install) return { action: "hint", reason, why: "kit.json sets no commands.install" };
  const argv = commandArgv(install);
  if (!argv) return { action: "hint", reason, why: `kit.json commands.install \`${install}\` needs a shell` };
  return { action: "run", reason, argv };
}

const INSTALL_TIMEOUT_MS = 600_000;

/**
 * Runs the install `adoptInstallPlan` chose and prints one line for it; never exits, since the
 * checkout already succeeded. pnpm and npm are `.cmd` shims on Windows, which Node spawns only
 * through a shell, so Windows gets the argv joined (it holds no shell syntax, `commandArgv` saw to
 * that) as `worktree-setup` does; elsewhere the argv spawns directly. Output is captured: only the
 * last lines of a failure are shown.
 */
function installAfterAdopt(plan, top) {
  if (plan.action === "none") return;
  if (plan.action === "hint") {
    console.log(`worktree-flow: ${plan.reason}; dependencies not reinstalled (${plan.why}): run the install by hand`);
    return;
  }
  const shown = plan.argv.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
  console.log(`worktree-flow: ${plan.reason}; running \`${shown}\``);
  const options = { cwd: top, encoding: "utf8", timeout: INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 };
  const result =
    process.platform === "win32"
      ? spawnSync(shown, { ...options, shell: true })
      : spawnSync(plan.argv[0], plan.argv.slice(1), options);
  if (result.status === 0) return console.log(`worktree-flow: \`${shown}\` done`);
  const cause = result.error ? result.error.message : `exit ${result.status ?? result.signal}`;
  const tail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().split(/\r?\n/).filter(Boolean).slice(-3);
  console.log(`worktree-flow: \`${shown}\` failed (${cause}); the worktree moved, run the install by hand`);
  for (const line of tail) console.log(`    ${line.slice(0, 200)}`);
}

function compareWithTarget(path, target, cwd) {
  const theirs = gitOut(["rev-parse", "--verify", "--quiet", `${target}:${path}`], cwd);
  if (!theirs) return "absent";
  return gitOut(["hash-object", "--", path], cwd) === theirs ? "same" : "differs";
}

function countRange(range, cwd) {
  const out = gitOut(["rev-list", "--count", range], cwd);
  return out === null ? null : Number(out);
}

function localBranches(cwd) {
  return (gitOut(["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd) ?? "").split("\n").filter(Boolean);
}

/**
 * `base:` of the SDLC item whose `branch:` is this branch, active or archived, in that worktree:
 * `<paths.sdlc>/<item>/intent.md` or `<paths.sdlc>/archive/<item>/intent.md`, front matter fields
 * `branch:` and `base:`.
 */
function intentBase(root, branch) {
  const sdlc = join(root, ...kitOf(root).paths.sdlc.split("/"));
  for (const dir of [sdlc, join(sdlc, "archive")]) {
    if (!existsSync(dir)) continue;
    for (const item of readdirSync(dir)) {
      const file = join(dir, item, "intent.md");
      if (!existsSync(file)) continue;
      const head = readFileSync(file, "utf8").split(/^---\s*$/m)[1] ?? "";
      const field = (name) => head.match(new RegExp(`^${escapeRegExp(name)}:\\s*(\\S+)`, "m"))?.[1];
      if (field("branch") === branch && field("base")) return field("base");
    }
  }
  return null;
}

/**
 * @param {string | null} branch null for a detached HEAD, which has nothing recorded and is only guessed
 * @param {string} ref the branch, or the detached commit
 * @returns {{ base: string | null, source: "recorded" | "intent" | "guessed" | null }}
 */
function baseOf(branch, ref, root, cwd) {
  const recorded = branch && gitOut(["config", "--get", BASE_KEY(branch)], cwd);
  if (recorded) return { base: recorded, source: "recorded" };
  const fromIntent = branch && intentBase(root, branch);
  if (fromIntent && gitOut(["rev-parse", "--verify", "--quiet", `refs/heads/${fromIntent}`], cwd))
    return { base: fromIntent, source: "intent" };
  const candidates = localBranches(cwd)
    .filter((name) => name !== branch && !name.startsWith("claude/"))
    .map((name) => ({ name, ahead: countRange(`${name}..${ref}`, cwd), behind: countRange(`${ref}..${name}`, cwd) }))
    .filter((c) => c.ahead !== null && c.behind !== null);
  const guess = guessBase(candidates, kitOf(root).baseBranch);
  return { base: guess, source: guess ? "guessed" : null };
}

function dirtyCounts(path) {
  const lines = (gitOut(["status", "--porcelain", "--untracked-files=normal"], path) ?? "").split("\n").filter(Boolean);
  const paths = lines.map((line) => line.slice(3));
  const kit = kitOf(path);
  const ledger = paths.filter((p) => inLedger(p.replace(/\/$/, ""), kit)).length;
  return { dirty: paths.length - ledger, dirtyLedger: ledger };
}

function upstreamAhead(branch, cwd) {
  const upstream = gitOut(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd);
  return upstream ? countRange(`${upstream}..${branch}`, cwd) : null;
}

/**
 * Integration branches among the local branches that contain a worktree's HEAD: its own branch and
 * other session branches (`claude/…`) prove nothing about the work having landed.
 * @param {string[]} containing @param {string | null} own
 */
export function integrationHolders(containing, own) {
  return containing.filter((name) => name && name !== own && !name.startsWith("claude/"));
}

/** The first integration branch containing `head`, or null. */
function landedIn(head, own, cwd) {
  const containing = gitOut(["for-each-ref", "--contains", head, "--format=%(refname:short)", "refs/heads"], cwd);
  return integrationHolders((containing ?? "").split("\n"), own)[0] ?? null;
}

/**
 * Worktrees safe to remove, cheaply enough for the SessionStart brief: on a branch (a detached one
 * is the app's reuse pool), some integration branch already contains the HEAD, and nothing outside
 * the ledger folder is uncommitted. Unlike `status`
 * it guesses no base (a rev-list pair per candidate branch per worktree), so it costs one
 * `for-each-ref` per worktree plus a `git status` only for the merged ones.
 * @returns {{ path: string, branch: string | null }[]}
 */
export function mergedCleanWorktrees(cwd) {
  const self = resolve(gitOut(["rev-parse", "--show-toplevel"], cwd) ?? cwd);
  return parseWorktrees(gitOut(["worktree", "list", "--porcelain"], cwd) ?? "")
    .filter((tree) => !tree.main && tree.branch && resolve(tree.path) !== self && existsSync(tree.path))
    .filter((tree) => landedIn(tree.head, tree.branch, cwd) !== null)
    .filter((tree) => dirtyCounts(tree.path).dirty === 0)
    .map(({ path, branch }) => ({ path, branch }));
}

function collect(cwd) {
  const self = resolve(gitOut(["rev-parse", "--show-toplevel"], cwd) ?? cwd);
  const trees = parseWorktrees(gitOut(["worktree", "list", "--porcelain"], cwd) ?? "");
  return trees.map((tree) => {
    const isSelf = resolve(tree.path) === self;
    const missing = !existsSync(tree.path);
    const ref = tree.branch ?? tree.head;
    const { base, source } = ref ? baseOf(tree.branch, ref, tree.path, cwd) : { base: null, source: null };
    const counts = missing ? { dirty: 0, dirtyLedger: 0 } : dirtyCounts(tree.path);
    const ahead = base && ref ? countRange(`${base}..${ref}`, cwd) : null;
    const behind = base && ref ? countRange(`${ref}..${base}`, cwd) : null;
    const unpushed = tree.branch ? upstreamAhead(tree.branch, cwd) : null;
    const baseUnpushed = base ? upstreamAhead(base, cwd) : null;
    const landed = tree.head && !tree.main && (!base || ahead) ? landedIn(tree.head, tree.branch, cwd) : null;
    const last = gitOut(["log", "-1", "--format=%cs", ref ?? "HEAD"], cwd);
    const facts = {
      main: tree.main,
      self: isSelf,
      branch: tree.branch,
      base,
      ...counts,
      ahead,
      unpushed,
      baseUnpushed,
      landedIn: landed,
    };
    return { ...tree, self: isSelf, missing, baseSource: source, behind, last, ...facts, ...verdictFor(facts) };
  });
}

function fail(message) {
  console.error(`worktree-flow: ${message}`);
  process.exit(1);
}

/** This checkout from git alone, for `adopt`, which must also run from stdin without the worktree list. */
function thisWorktree(cwd) {
  const branch = gitOut(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
  if (!branch) fail("this checkout is on a detached HEAD; switch to a branch first");
  const dir = (flag) => resolve(cwd, gitOut(["rev-parse", "--path-format=absolute", flag], cwd) ?? "");
  return {
    path: gitOut(["rev-parse", "--show-toplevel"], cwd),
    branch,
    main: dir("--git-dir") === dir("--git-common-dir"),
  };
}

function current(cwd) {
  const all = collect(cwd);
  const me = all.find((tree) => tree.self);
  if (!me?.branch) fail("this checkout is on a detached HEAD; switch to a branch first");
  return { all, me };
}

function printStatus(rows) {
  for (const row of rows) {
    const name = row.branch ?? `(detached ${row.head?.slice(0, 7)})`;
    const base = row.base ? ` ← ${row.base}${row.baseSource === "guessed" ? " (guessed)" : ""}` : "";
    const sync = row.behind ? `, ${row.behind} behind` : "";
    console.log(
      `${row.removable ? "✓" : "·"} ${name}${base}${sync} — ${row.verdict}${row.last ? ` [${row.last}]` : ""}`,
    );
    console.log(`    ${row.path}${row.missing ? " (missing on disk: git worktree prune)" : ""}`);
  }
}

function resolveRef(input, cwd, { track }) {
  const local = matchBranch(input, localBranches(cwd));
  if ("branch" in local) return local.branch;
  if (local.candidates.length > 1)
    fail(`"${input}" matches several local branches: ${local.candidates.join(", ")} — name one`);
  git(["fetch", "--quiet", "origin"], cwd);
  const remote = (gitOut(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], cwd) ?? "")
    .split("\n")
    .map((name) => name.replace(/^origin\//, ""))
    .filter((name) => name && name !== "HEAD" && name !== "origin");
  const hit = matchBranch(input, remote);
  if (!("branch" in hit))
    fail(
      hit.candidates.length > 1
        ? `"${input}" matches several origin branches: ${hit.candidates.join(", ")}`
        : `no local or origin branch matches "${input}"`,
    );
  if (!track) return hit.branch;
  const made = git(["branch", "--track", hit.branch, `origin/${hit.branch}`], cwd);
  if (!made.ok) fail(made.err);
  console.error(`worktree-flow: created local ${hit.branch} tracking origin/${hit.branch}`);
  return hit.branch;
}

function conflictsOf(me, all, cwd) {
  const versus = (other) => {
    const result = git(["merge-tree", "--write-tree", "--name-only", me.branch, other], cwd);
    if (result.status === 0) return [];
    if (result.status === 1) return parseMergeTree(result.out);
    return [`(merge-tree failed: ${result.err.split("\n")[0]})`];
  };
  const report = [];
  if (me.base) report.push({ with: me.base, kind: "base", files: versus(me.base) });
  for (const tree of all) {
    if (tree.self || tree.main || !tree.branch || !tree.ahead) continue;
    report.push({ with: tree.branch, kind: "worktree", path: tree.path, files: versus(tree.branch) });
  }
  return report;
}

function usage(args, text) {
  if (!args[0]) fail(`usage: ${text}`);
}

function cmdStatus({ flags, cwd }) {
  const rows = collect(cwd);
  if (flags.has("--json")) console.log(JSON.stringify(rows, null, 2));
  else printStatus(rows);
}

function cmdResolve({ args, cwd }) {
  usage(args, "resolve <APP-123 | branch>");
  console.log(resolveRef(args[0], cwd, { track: true }));
}

function cmdBase({ args, cwd }) {
  const { me } = current(cwd);
  if (!args[0]) return console.log(me.base ? `${me.base} (${me.baseSource})` : "none");
  const base = resolveRef(args[0], cwd, { track: true });
  git(["config", BASE_KEY(me.branch), base], cwd);
  return console.log(`${me.branch} → base ${base}`);
}

function cmdAdopt({ args, cwd }) {
  usage(args, "adopt <APP-123 | branch>");
  const me = thisWorktree(cwd);
  if (me.main) fail("adopt only re-points a linked worktree, never the main checkout");
  const target = resolveRef(args[0], cwd, { track: true });
  const own = countRange(`${target}..HEAD`, cwd);
  if (own > 0) fail(`${me.branch} has ${own} commit(s) not in ${target}; merge ${target} in instead of adopting`);
  // Porcelain paths are relative to the worktree root, and `git()` trims the leading space of " M".
  const top = me.path;
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: top,
    encoding: "utf8",
  });
  const entries = parseStatusZ(status.stdout ?? "").map((entry) => ({
    ...entry,
    target: entry.code === "??" ? compareWithTarget(entry.path, target, top) : null,
  }));
  const ledger = kitOf(top).paths.ledger;
  const { drop, blockers } = adoptPlan(entries, ledger);
  if (blockers.length > 0) {
    fail(`${blockers.length} uncommitted file(s) outside ${ledger}/: ${blockers.join(", ")}; commit or move them first`);
  }
  const saved = drop.map((path) => ({ path, bytes: readFileSync(join(top, path)) }));
  for (const { path } of saved) unlinkSync(join(top, path));
  const before = gitOut(["rev-parse", "HEAD"], top);
  const moved = git(["checkout", "-B", me.branch, target], top);
  if (!moved.ok) {
    for (const { path, bytes } of saved) writeFileSync(join(top, path), bytes);
    fail(moved.err);
  }
  git(["config", BASE_KEY(me.branch), target], cwd);
  console.log(`${me.branch} now starts at ${target} (${gitOut(["rev-parse", "--short", "HEAD"], cwd)}); base recorded`);
  // The SessionStart setup installed dependencies for the old commit; the new one may need others.
  const changed = (gitOut(["diff", "--name-only", before, "HEAD"], top) ?? "").split("\n").filter(Boolean);
  const nodeModulesMissing = existsSync(join(top, "package.json")) && !existsSync(join(top, "node_modules"));
  // Read afresh: the target's kit.json, not the one cached before the checkout.
  installAfterAdopt(adoptInstallPlan({ changed, nodeModulesMissing, install: readKit(top).commands.install }), top);
}

function cmdConflicts({ flags, cwd }) {
  const { me, all } = current(cwd);
  const report = conflictsOf(me, all, cwd);
  if (flags.has("--json")) return console.log(JSON.stringify(report, null, 2));
  if (report.length === 0) return console.log("no base and no other active worktree to compare with");
  for (const entry of report) {
    const files = entry.files.length ? `: ${entry.files.join(", ")}` : "";
    console.log(`${entry.files.length ? "✗" : "✓"} ${me.branch} × ${entry.with} (${entry.kind})${files}`);
  }
  return undefined;
}

/** Why this worktree cannot land yet ("" when it can): it must be committed and already contain its base. */
function landRefusal(me, cwd) {
  if (me.main) return "land runs in the worktree being landed, not in the main checkout";
  if (!me.base) return "no base found; record one with `base <ref>`";
  if (me.dirty > 0 || me.dirtyLedger > 0) return "commit everything first, the ledger record included";
  if (countRange(`HEAD..${me.base}`, cwd) > 0) {
    return `${me.base} has commits this branch lacks: merge it in here first (app: sync_with_base_branch, or git merge ${me.base}), resolve, run the checks, then land again`;
  }
  return "";
}

/**
 * A base checked out elsewhere is moved by that checkout's own merge, so its index and files
 * follow, and git refuses there if a neighbour's uncommitted edit would be overwritten. A base
 * checked out nowhere is moved by compare-and-swap on the ref.
 */
function fastForward(me, holder, cwd) {
  if (holder) return git(["-C", holder.path, "merge", "--ff-only", me.branch], cwd);
  const head = gitOut(["rev-parse", "HEAD"], cwd);
  return git(["update-ref", `refs/heads/${me.base}`, head, gitOut(["rev-parse", me.base], cwd)], cwd);
}

function cmdLand({ flags, cwd }) {
  const { me, all } = current(cwd);
  // `--report` is a dry run for /close-out's preload, which must load in exactly the states `land`
  // refuses (base ahead, files uncommitted): Claude Code drops the whole command on a non-zero exit.
  const report = flags.has("--report");
  const refusal = landRefusal(me, cwd);
  if (refusal) return report ? console.log(`cannot land yet: ${refusal}`) : fail(refusal);
  const ahead = countRange(`${me.base}..HEAD`, cwd);
  if (ahead === 0) return console.log(`${me.base} already contains ${me.branch}; nothing to land`);
  const holder = all.find((tree) => tree.branch === me.base);
  if (report || flags.has("--dry-run")) {
    const plan = holder
      ? `git -C ${holder.path} merge --ff-only ${me.branch}`
      : `git update-ref refs/heads/${me.base} ${me.branch}`;
    return console.log(`would fast-forward ${me.base} by ${ahead} commit(s): ${plan}`);
  }
  const result = fastForward(me, holder, cwd);
  if (!result.ok) fail(`fast-forward of ${me.base} refused: ${result.err.split("\n")[0]}`);
  const unpushed = upstreamAhead(me.base, cwd);
  const push = unpushed ? `; ${me.base} is ${unpushed} ahead of its upstream — push it when ready` : "";
  return console.log(`landed ${ahead} commit(s) on ${me.base}${push}`);
}

function cmdRemove({ args, flags, cwd }) {
  usage(args, "remove <worktree path | branch>");
  const target = collect(cwd).find((tree) => tree.branch === args[0] || resolve(tree.path) === resolve(cwd, args[0]));
  if (!target) fail(`no worktree at or on "${args[0]}"`);
  if (!target.removable) fail(`refusing to remove ${target.path}: ${target.verdict}`);
  const dropLedger = target.dirtyLedger > 0;
  if (dropLedger && !flags.has("--drop-ledger")) {
    fail(
      `${target.path} holds ${target.dirtyLedger} uncommitted ledger record(s); commit them there or pass --drop-ledger`,
    );
  }
  const removed = git(["worktree", "remove", ...(dropLedger ? ["--force"] : []), target.path], cwd);
  if (!removed.ok) fail(removed.err);
  if (!target.branch) return console.log(`removed ${target.path}`);
  // Every commit of the branch is in its base (removable says so), so deleting it loses nothing.
  const dropped = git(["branch", "-D", target.branch], cwd);
  return console.log(
    `removed ${target.path}${dropped.ok ? ` and branch ${target.branch}` : `; branch ${target.branch} kept: ${dropped.err}`}`,
  );
}

/** Branch names never offered for deletion on the remote, whatever they hold. */
const PROTECTED_BRANCHES = ["main", "master", ...INTEGRATION_BRANCHES];

/**
 * Whether a branch on origin is stale: safe to delete there because a base already holds its work.
 * Pure, so the safety rule is tested. The order is the rule: a protected or checked-out branch is
 * kept even when merged; a squash-merged PR counts only into this base and only when origin's tip
 * is the PR's head, so a commit pushed after the merge is never lost.
 * @param {{ branch: string, base: string, protectedBy?: string | null, onRemote: boolean, checkedOutAt?: string | null, inRef?: string | null, ahead?: number | null, baseRef: string, pr?: { number: number, baseRefName: string, headMatches: boolean } | null, ghError?: string | null }} f
 * @returns {{ stale: boolean, reason: string }}
 */
export function staleVerdict(f) {
  if (f.protectedBy) return { stale: false, reason: `protected: ${f.protectedBy}` };
  if (!f.onRemote) return { stale: false, reason: "not on origin" };
  if (f.checkedOutAt) return { stale: false, reason: `checked out in ${f.checkedOutAt}` };
  if (f.inRef) return { stale: true, reason: `in ${f.inRef}` };
  const behind = `${f.ahead ?? "?"} commit(s) not in ${f.baseRef}`;
  if (f.pr && f.pr.baseRefName !== f.base)
    return { stale: false, reason: `${behind}; PR #${f.pr.number} merged into ${f.pr.baseRefName}, not ${f.base}` };
  if (f.pr && !f.pr.headMatches)
    return { stale: false, reason: `${behind}; PR #${f.pr.number} merged, but origin has commits pushed after it` };
  if (f.pr) return { stale: true, reason: `PR #${f.pr.number} merged into ${f.base} (squash or rebase)` };
  return { stale: false, reason: `${behind}; ${f.ghError ?? "no merged PR"}` };
}

/**
 * The merged PR of `branch`, by `gh pr list --head`: one into `base` first, the one whose head is
 * origin's tip first among those. `gh` comes from `WORKTREE_FLOW_GH` (tests), else the PATH.
 * @returns {{ pr: { number: number, baseRefName: string, headMatches: boolean } | null, ghError: string | null }}
 */
function mergedPr(branch, base, tip, cwd) {
  const gh = process.env.WORKTREE_FLOW_GH || "gh";
  const args = ["pr", "list", "--head", branch, "--state", "merged", "--json", "number,baseRefName,headRefOid", "--limit", "20"];
  const result = spawnSync(gh, args, { cwd, encoding: "utf8", timeout: 15000 });
  if (result.error) return { pr: null, ghError: "gh not found, so a squash merge was not checked" };
  if (result.status !== 0)
    return { pr: null, ghError: `gh failed (${(result.stderr ?? "").trim().split("\n")[0] || `exit ${result.status}`})` };
  let list;
  try {
    list = JSON.parse(result.stdout || "[]");
  } catch {
    return { pr: null, ghError: "gh answered something other than JSON" };
  }
  const prs = list.map((pr) => ({ number: pr.number, baseRefName: pr.baseRefName, headMatches: pr.headRefOid === tip }));
  const rank = (pr) => (pr.baseRefName === base ? 0 : 2) + (pr.headMatches ? 0 : 1);
  return { pr: prs.sort((a, b) => rank(a) - rank(b))[0] ?? null, ghError: null };
}

/**
 * Every named branch on origin (all `claude/*` there when none is named), sorted into stale and
 * kept. Read-only on the remote: one `git fetch --prune origin` refreshes the remote-tracking refs.
 * With `landing`, HEAD counts as the base too, since landing fast-forwards the base to it and the
 * push brings it to origin: the list a close-out question shows before it lands.
 */
function staleRemote({ branches, base, landing }, cwd) {
  if (!gitOut(["remote", "get-url", "origin"], cwd)) fail("no origin remote");
  const fetched = git(["fetch", "--quiet", "--prune", "origin"], cwd);
  const baseRef = `origin/${base}`;
  if (!gitOut(["rev-parse", "--verify", "--quiet", `refs/remotes/${baseRef}`], cwd)) fail(`origin has no ${base}`);
  const remote = (gitOut(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], cwd) ?? "")
    .split("\n")
    .map((name) => name.replace(/^origin\//, ""))
    .filter((name) => name && name !== "HEAD" && name !== "origin");
  const names = branches.length ? [...new Set(branches)] : remote.filter((name) => name.startsWith("claude/"));
  const self = resolve(gitOut(["rev-parse", "--show-toplevel"], cwd) ?? cwd);
  const others = parseWorktrees(gitOut(["worktree", "list", "--porcelain"], cwd) ?? "").filter(
    (tree) => tree.branch && resolve(tree.path) !== self,
  );
  const upstreamOf = (branch) => gitOut(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd);
  const defaultBranch = gitOut(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], cwd)?.replace(/^origin\//, "");
  const guarded = new Map([
    ...PROTECTED_BRANCHES.map((name) => [name, `${name} is an integration or release branch`]),
    [kitOf(self).baseBranch, "kit.json baseBranch"],
    [defaultBranch, "origin's default branch"],
    [base, "the base"],
  ]);
  const rows = names.map((branch) => {
    const tip = gitOut(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], cwd);
    const holder = others.find((tree) => tree.branch === branch || upstreamOf(tree.branch) === `origin/${branch}`);
    const contains = (ref) => tip && git(["merge-base", "--is-ancestor", tip, ref], cwd).ok;
    const inRef = !tip ? null : contains(baseRef) ? baseRef : landing && contains("HEAD") ? `HEAD, which lands on ${base}` : null;
    const facts = {
      branch,
      base,
      baseRef,
      protectedBy: guarded.get(branch) ?? null,
      onRemote: Boolean(tip),
      checkedOutAt: holder?.path ?? null,
      inRef,
      ahead: tip ? countRange(`${baseRef}..${tip}`, cwd) : null,
    };
    const lookup = !guarded.has(branch) && tip && !holder && !inRef;
    const { pr, ghError } = lookup ? mergedPr(branch, base, tip, cwd) : { pr: null, ghError: null };
    return { branch, tip, ...staleVerdict({ ...facts, pr, ghError }) };
  });
  return { base, baseRef, landing, fetched: fetched.ok, stale: rows.filter((r) => r.stale), kept: rows.filter((r) => !r.stale) };
}

function cmdStaleRemote({ args, flags, values, cwd }) {
  const base = values["--base"] ?? current(cwd).me.base;
  if (!base) fail("no base found; pass --base <branch>");
  const report = staleRemote({ branches: args, base, landing: flags.has("--landing") }, cwd);
  if (flags.has("--json")) return console.log(JSON.stringify(report, null, 2));
  const when = report.landing ? ` once HEAD lands on ${base} and is pushed` : "";
  const fetch = report.fetched ? "" : " (fetch failed: from the last-fetched refs)";
  console.log(`${report.baseRef}: ${report.stale.length} stale${when}, ${report.kept.length} kept${fetch}`);
  for (const row of [...report.stale, ...report.kept]) console.log(`${row.stale ? "✓" : "·"} ${row.branch} — ${row.reason}`);
  if (report.stale.length)
    console.log(`to delete, on the user's word: git push origin --delete ${report.stale.map((r) => r.branch).join(" ")}`);
  return undefined;
}

function cmdRole({ args, cwd }) {
  const me = thisWorktree(cwd);
  if (args[0]) {
    if (args[0] !== "child" && args[0] !== "main") fail(`usage: role [child | main], not ${args[0]}`);
    git(["config", ROLE_KEY(me.branch), args[0]], cwd);
    return console.log(`${me.branch} → ${args[0]} session (recorded)`);
  }
  const { role, source } = sessionRole(cwd);
  const why = { recorded: "recorded", base: "its base is another session's branch", default: "nothing recorded" }[source];
  return console.log(`${role} (${why})`);
}

/**
 * Which conflicted paths each `kit.json` `regenerate` rule rebuilds, and the ones no rule takes.
 * Pure. @param {string[]} unmerged @param {Array<{ match: string[], command: string }>} rules
 */
export function regeneratePlan(unmerged, rules) {
  const taken = new Set();
  const steps = [];
  for (const rule of rules) {
    const paths = unmerged.filter((path) => !taken.has(path) && matchesAny(path, rule.match));
    if (paths.length === 0) continue;
    for (const path of paths) taken.add(path);
    steps.push({ command: rule.command, paths });
  }
  return { steps, left: unmerged.filter((path) => !taken.has(path)) };
}

function cmdRegenerate({ flags, cwd }) {
  const top = thisWorktree(cwd).path;
  const unmerged = (gitOut(["diff", "--name-only", "--diff-filter=U"], top) ?? "").split("\n").filter(Boolean);
  if (unmerged.length === 0) return console.log("no conflicted files");
  const { steps, left } = regeneratePlan(unmerged, kitOf(top).regenerate);
  if (steps.length === 0) return console.log(`no kit.json regenerate rule matches the conflicted files: ${unmerged.join(", ")}`);
  for (const step of steps) {
    if (flags.has("--dry-run")) {
      console.log(`would regenerate ${step.paths.join(", ")} with \`${step.command}\``);
      continue;
    }
    const ours = git(["checkout", "--ours", "--", ...step.paths], top);
    if (!ours.ok) fail(`could not take this branch's side of ${step.paths.join(", ")}: ${ours.err}`);
    const run = spawnSync(step.command, { cwd: top, shell: true, stdio: "inherit" });
    if (run.status !== 0) fail(`\`${step.command}\` failed (exit ${run.status ?? run.error?.message}); ${step.paths.join(", ")} hold this branch's side, unstaged`);
    const added = git(["add", "--", ...step.paths], top);
    if (!added.ok) fail(added.err);
    console.log(`regenerated ${step.paths.join(", ")} with \`${step.command}\`; staged`);
  }
  if (left.length) console.log(`still conflicted (no regenerate rule): ${left.join(", ")}`);
  return undefined;
}

const COMMANDS = {
  status: cmdStatus,
  resolve: cmdResolve,
  base: cmdBase,
  role: cmdRole,
  adopt: cmdAdopt,
  conflicts: cmdConflicts,
  land: cmdLand,
  regenerate: cmdRegenerate,
  remove: cmdRemove,
  "stale-remote": cmdStaleRemote,
};

/** The flags each command reads; any other is refused, so a typo such as `land --dryrun` never lands. */
const COMMAND_FLAGS = {
  status: ["--json"],
  conflicts: ["--json"],
  land: ["--dry-run", "--report"],
  regenerate: ["--dry-run"],
  remove: ["--drop-ledger"],
  "stale-remote": ["--json", "--landing"],
};

/** The flags that take a value, the next argument. */
const COMMAND_VALUES = {
  "stale-remote": ["--base"],
};

const USAGE = `The branch-and-worktree side of a session, from start to close-out.

  worktree-flow status [--json]           every worktree: base, merged, pushed, dirty, verdict
  worktree-flow resolve <ref>             local branch for a work item (APP-123) or name
  worktree-flow base [<ref>]              show, or record, this branch's integration branch
  worktree-flow role [child | main]       show, or record, whether this session is a sub-session
                                          (child) whose parent lands its branch, or the main session
  worktree-flow adopt <ref>               move a fresh worktree (no commits of its own) onto <ref>;
                                          when a lockfile or manifest changed, or node_modules is
                                          missing, run kit.json commands.install (else print a hint)
  worktree-flow conflicts [--json]        predicted merge conflicts with the base and every active worktree
  worktree-flow land [--dry-run]          fast-forward the base to this branch; never merges, never pushes
  worktree-flow land --dry-run --report   the same dry run, but a refusal is printed and exits 0
  worktree-flow regenerate [--dry-run]    during a merge, rebuild each conflicted file a kit.json
                                          regenerate rule matches (this branch's side, then the
                                          rule's command) and stage it; other conflicts stay
  worktree-flow remove <path | branch> [--drop-ledger]
                                          remove a clean worktree whose commits are all in its base
  worktree-flow stale-remote [--base <b>] [--landing] [--json] [<branch>...]
                                          list the named branches on origin (every claude/* when none)
                                          as stale (in origin/<base>, or a PR merged into <base>) or
                                          kept with the reason; read-only, it deletes nothing

With no command it runs status. The base is the recorded one (base <ref>), else the SDLC item's
base:, else a guess, with kit.json baseBranch (default dev) winning a tie and dev, develop or
development next.

role is child when recorded so (role child), else when the recorded base is another session's
claude/* branch; else main. The desktop app's get_session is the agent's own check.

stale-remote fetches origin (with --prune) first. It keeps main, master, dev, develop,
development, the base, kit.json baseBranch and origin's default branch, a branch checked out in
another worktree, and one with commits the base lacks. --landing also counts what HEAD holds, as
landing and pushing will bring it to origin/<base>.

Flags:
  --help, -h   print this and exit 0 (any command)

Exit codes:
  0  done (or help printed)
  1  usage error, git error, or a refusal (the message names the cause; land --report exits 0 on a refusal)
`;

/**
 * Splits a command's arguments, or names the first one it does not take. Pure, so the refusal is tested.
 * @param {string} command
 * @param {string[]} rest
 * @returns {{ args: string[], flags: Set<string>, error: string }}
 */
export function splitCommandArgs(command, rest) {
  const known = COMMAND_FLAGS[command] ?? [];
  const valued = COMMAND_VALUES[command] ?? [];
  const takes = [...known, ...valued];
  const args = [];
  const flags = new Set();
  const values = {};
  let error = "";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (valued.includes(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) error ||= `${command} ${arg} needs a value`;
      else values[arg] = value;
      i++;
    } else if (!arg.startsWith("-")) args.push(arg);
    else {
      flags.add(arg);
      if (!known.includes(arg))
        error ||= `${command} does not take "${arg}"${takes.length ? ` (it takes ${takes.join(", ")})` : ""}; --help prints the usage`;
    }
  }
  return { args, flags, values, error };
}

function main(argv, cwd) {
  // Before the command lookup and any git call, so a usage request reads nothing and changes nothing.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const [command = "status", ...rest] = argv;
  const run = COMMANDS[command];
  if (!run) fail(`unknown command "${command}" — ${Object.keys(COMMANDS).join(" | ")}; --help prints the usage`);
  const { args, flags, values, error } = splitCommandArgs(command, rest);
  if (error) fail(error);
  run({ args, flags, values, cwd });
}

if (isDirectRun(import.meta.url)) main(process.argv.slice(2), process.cwd());
