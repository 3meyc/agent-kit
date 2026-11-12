import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDirectRun, parseWorktrees } from "../lib/hook-utils.mjs";
import { escapeRegExp, inLedger, readKit } from "../lib/kit-config.mjs";

/**
 * The branch-and-worktree side of a session, from start to close-out (`worktree-flow` on the Bash
 * PATH, from the plugin's `bin/`):
 *
 *   worktree-flow status [--json]    every worktree: base, merged, pushed, dirty, verdict
 *   worktree-flow resolve <ref>      local branch for a work item (APP-123) or name; tracks origin's if only it exists
 *   worktree-flow base [<ref>]       show, or record, this branch's integration branch
 *   worktree-flow adopt <ref>        move a fresh worktree (no commits of its own) onto <ref>
 *   worktree-flow conflicts [--json] predicted merge conflicts with the base and every active worktree
 *   worktree-flow land [--dry-run]   fast-forward the base to this branch; never merges, never pushes
 *   worktree-flow land --dry-run --report   the same dry run, exiting 0 on a refusal too (close-out's preload)
 *   worktree-flow remove <path>      remove a clean worktree whose commits are all in its base
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
const BASE_KEY = (branch) => `branch.${branch}.kitBase`;

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
  const moved = git(["checkout", "-B", me.branch, target], top);
  if (!moved.ok) {
    for (const { path, bytes } of saved) writeFileSync(join(top, path), bytes);
    fail(moved.err);
  }
  git(["config", BASE_KEY(me.branch), target], cwd);
  console.log(`${me.branch} now starts at ${target} (${gitOut(["rev-parse", "--short", "HEAD"], cwd)}); base recorded`);
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

const COMMANDS = {
  status: cmdStatus,
  resolve: cmdResolve,
  base: cmdBase,
  adopt: cmdAdopt,
  conflicts: cmdConflicts,
  land: cmdLand,
  remove: cmdRemove,
};

/** The flags each command reads; any other is refused, so a typo such as `land --dryrun` never lands. */
const COMMAND_FLAGS = {
  status: ["--json"],
  conflicts: ["--json"],
  land: ["--dry-run", "--report"],
  remove: ["--drop-ledger"],
};

const USAGE = `The branch-and-worktree side of a session, from start to close-out.

  worktree-flow status [--json]           every worktree: base, merged, pushed, dirty, verdict
  worktree-flow resolve <ref>             local branch for a work item (APP-123) or name
  worktree-flow base [<ref>]              show, or record, this branch's integration branch
  worktree-flow adopt <ref>               move a fresh worktree (no commits of its own) onto <ref>
  worktree-flow conflicts [--json]        predicted merge conflicts with the base and every active worktree
  worktree-flow land [--dry-run]          fast-forward the base to this branch; never merges, never pushes
  worktree-flow land --dry-run --report   the same dry run, but a refusal is printed and exits 0
  worktree-flow remove <path | branch> [--drop-ledger]
                                          remove a clean worktree whose commits are all in its base

With no command it runs status. The base is the recorded one (base <ref>), else the SDLC item's
base:, else a guess, with kit.json baseBranch (default dev) winning a tie and dev, develop or
development next.

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
  const unknown = rest.find((arg) => arg.startsWith("-") && !known.includes(arg));
  return {
    args: rest.filter((arg) => !arg.startsWith("-")),
    flags: new Set(rest.filter((arg) => arg.startsWith("-"))),
    error: unknown
      ? `${command} does not take "${unknown}"${known.length ? ` (it takes ${known.join(", ")})` : ""}; --help prints the usage`
      : "",
  };
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
  const { args, flags, error } = splitCommandArgs(command, rest);
  if (error) fail(error);
  run({ args, flags, cwd });
}

if (isDirectRun(import.meta.url)) main(process.argv.slice(2), process.cwd());
