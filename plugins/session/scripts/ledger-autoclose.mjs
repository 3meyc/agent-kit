import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Automatic closing of `## Next` items: rules that tell, from the item's text, the record's day and
 * git, that an item no longer owes anything. In a busy project most open items were done or
 * overtaken long before anyone marked them, and a brief that lists them all gets skipped.
 *
 * Read-time only: the brief hides these items and `session-ledger --owed` lists them apart, with
 * the reason; nothing changes in a record until `session-ledger --sweep` writes the done marks.
 *
 * 1. An `Open question at Stop: …` item (the recap's unanswered question) expires once the record
 *    was last active more than `ledgerAutoClose.questionDays` days ago (`kit.json`, default 7).
 * 2. An item with `(until <YYYY-MM-DD>)` closes the day after that date.
 * 3. An item naming a pull request (`PR #12`, `pull request 12`, `owner/repo#12`, a `/pull/12`
 *    URL) closes once that PR merged on or after the record's day. The base's merge subjects
 *    (`Merge pull request #12 from …`, a squash's `(#12)`) answer offline; `gh pr view` answers the
 *    rest when it is installed, only for `--owed` and `--sweep` (the brief never waits on the
 *    network), cached in the git common dir. Without `gh` the item simply stays open.
 * 4. An item naming a branch closes once that branch landed in its base and was not there yet when
 *    the record's day began: an item written after a branch landed is not about landing it. The
 *    base is the one `worktree-flow base` recorded (`branch.<name>.kitBase`), else, for a session
 *    branch (`claude/…`), any integration branch (a local branch outside `claude/`), else
 *    `kit.json` `baseBranch`. A deleted branch counts when a merge subject on those names it.
 * 5. An item naming a branch and saying "push" closes once the branch's remote-tracking ref holds
 *    what the local branch held at the end of the record's day.
 */

/** Days an `Open question at Stop` item stays open; `kit.json` `ledgerAutoClose.questionDays`. */
export const QUESTION_DAYS = 7;
const DAY_MS = 86_400_000;
/** How long a "not merged" answer from `gh` is trusted before asking again. */
const PR_RECHECK_MS = 6 * 3_600_000;
/** `gh` calls per run at most, so a ledger full of PR numbers cannot stall `--owed`. */
const MAX_GH_CALLS = 30;
const GH_TIMEOUT_MS = 8000;
/** The PR answers, in the git common dir: shared by every worktree, never tracked. */
export const PR_CACHE_NAME = "session-ledger-prs.json";

const QUESTION = /^(?:\(unverified\)\s*)?Open question at Stop:/i;
const PUSH = /\bpush/i;
/** The branch rule needs an item about landing a branch, not one that only mentions one. */
const LANDING = /\b(?:land|lands|landed|landing|merge|merged|merges|merging|fast-forward|close-out|push|pushed)\b/i;
/** A branch named in a condition ("once `x` lands") makes the item due when it lands, not done. */
const CONDITION = /\b(?:once|when|after|until|before|if)\b/i;
const CONDITION_REACH = 60;
const UNTIL = /\(until (\d{4}-\d{2}-\d{2})\)/i;
const PR_PATTERNS = [
  { re: /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi, repo: 1, n: 2 },
  { re: /(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d+)\b/g, repo: 1, n: 2 },
  { re: /\bPR ?#?(\d+)\b/gi, n: 1 },
  { re: /\bpull request #?(\d+)\b/gi, n: 1 },
];
const BACKTICKED = /`([^`\s]+)`/g;
// A bare word with a slash: `claude/fix-x`, `feat/APP-12-y`. Paths match too and are dropped later
// for naming no branch.
const SLASHED = /(?:^|[\s(])([A-Za-z0-9][\w.-]*\/[\w./-]*[\w-])(?=$|[\s),.;:!?'"])/g;

/** @param {number} ms */
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * What an item's text names that a rule can check. Pure.
 * @param {string} text The item's text, as `parseNextItems` returns it.
 * @returns {{ question: boolean, push: boolean, landing: boolean, until: string | null,
 *   prs: { repo: string | null, n: number }[], branches: string[] }} `branches`: the words that may
 *   name a branch, less those named in a condition ("once `x` lands").
 */
export function itemRefs(text) {
  const prs = new Map();
  for (const { re, repo, n } of PR_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const ref = { repo: repo ? m[repo] : null, n: Number(m[n]) };
      prs.set(`${ref.repo ?? ""}#${ref.n}`, ref);
    }
  }
  const branches = new Set();
  const conditional = new Set();
  const note = (name, at) => {
    // The words before the mention, back to the start of its sentence or clause.
    const before = text.slice(Math.max(0, at - CONDITION_REACH), at).split(/[.;!?]\s/).at(-1);
    (CONDITION.test(before) ? conditional : branches).add(name);
  };
  for (const m of text.matchAll(BACKTICKED)) note(m[1].replace(/^refs\/heads\//, ""), m.index);
  for (const m of text.matchAll(SLASHED)) note(m[1], m.index + m[0].indexOf(m[1]));
  for (const name of conditional) branches.delete(name);
  return {
    question: QUESTION.test(text),
    push: PUSH.test(text),
    landing: LANDING.test(text),
    until: text.match(UNTIL)?.[1] ?? null,
    prs: [...prs.values()],
    branches: [...branches],
  };
}

/**
 * When a record was last active, for the question rule: the newest edit time in its `## Files`,
 * else the end of its day (a record's name carries its start day only).
 * @param {string} day `YYYY-MM-DD` @param {Iterable<string | null>} fileTimes ISO times
 */
export function lastActive(day, fileTimes) {
  let last = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
  for (const at of fileTimes) {
    const ms = at ? Date.parse(at) : NaN;
    if (!Number.isNaN(ms) && ms > last) last = ms;
  }
  return last;
}

/**
 * @typedef {{
 *   prMerged: (ref: { repo: string | null, n: number }, day: string) => boolean,
 *   branchLanded: (name: string, day: string) => { branch: string, into: string } | null,
 *   branchPushed: (name: string, day: string) => { branch: string, to: string } | null,
 * }} CloseFacts `branch` is the name as git knows it (`origin/x` → `x`).
 */

/**
 * Why an item counts as closed, or null while it still owes something. Pure but for `facts`.
 * @param {string} text @param {{ day: string, lastAt: number }} record
 * @param {CloseFacts} facts @param {{ now: number, questionDays: number }} options
 */
export function closeReason(text, record, facts, { now, questionDays }) {
  const refs = itemRefs(text);
  if (refs.until && refs.until < isoDay(now)) return `until ${refs.until} passed`;
  if (refs.question && now - record.lastAt >= questionDays * DAY_MS)
    return `open question older than ${questionDays} days`;
  for (const pr of refs.prs) {
    if (facts.prMerged(pr, record.day)) return `PR ${pr.repo ?? ""}#${pr.n} merged`;
  }
  if (!refs.landing) return null;
  for (const name of refs.branches) {
    const landed = facts.branchLanded(name, record.day);
    if (landed) return `branch ${landed.branch} landed in ${landed.into}`;
  }
  if (!refs.push) return null;
  for (const name of refs.branches) {
    const pushed = facts.branchPushed(name, record.day);
    if (pushed) return `branch ${pushed.branch} pushed to ${pushed.to}`;
  }
  return null;
}

/**
 * A record's not-done items split into those still open and those a rule closed.
 * @template {{ n: number, text: string, done: boolean }} Item
 * @param {Item[]} items @param {{ day: string, lastAt: number }} record
 * @param {CloseFacts} facts @param {{ now: number, questionDays: number }} options
 * @returns {{ open: Item[], closed: { item: Item, reason: string }[] }}
 */
export function splitItems(items, record, facts, options) {
  const open = [];
  const closed = [];
  for (const item of items) {
    if (item.done) continue;
    const reason = closeReason(item.text, record, facts, options);
    if (reason) closed.push({ item, reason });
    else open.push(item);
  }
  return { open, closed };
}

/**
 * Branches a merge on the base names, and the PRs it merged, each with the newest commit time.
 * `Merge pull request #12 from owner/branch`, `Merge branch 'x'`, `Merge remote-tracking branch
 * 'origin/x'`, and a squash merge's `Subject (#12)`. Pure.
 * @param {string} log Lines of `<ISO time>\t<subject>`. @param {Set<string>} remotes Remote names.
 */
export function parseMergeSubjects(log, remotes = new Set(["origin"])) {
  const branches = new Map();
  const prs = new Map();
  const keep = (map, key, at) => {
    if (!map.has(key) || map.get(key) < at) map.set(key, at);
  };
  for (const line of log.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const at = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    const pr = subject.match(/^Merge pull request #(\d+) from [^/\s]+\/(\S+)/);
    if (pr) {
      keep(prs, Number(pr[1]), at);
      keep(branches, pr[2], at);
      continue;
    }
    const merged = subject.match(/^Merge (remote-tracking )?branch '([^']+)'/);
    if (merged) {
      const [first, ...rest] = merged[2].split("/");
      keep(branches, merged[1] && rest.length && remotes.has(first) ? rest.join("/") : merged[2], at);
      continue;
    }
    const squash = subject.match(/\(#(\d+)\)\s*$/);
    if (squash) keep(prs, Number(squash[1]), at);
  }
  return { branches, prs };
}

/**
 * Branch → the session ids of the records made on it, from each record's `branch:` and `id:`. Pure.
 * @param {{ branch?: string | null, id?: string | null }[]} records
 */
export function branchSessions(records) {
  const map = new Map();
  for (const { branch, id } of records) {
    if (!branch || !id || branch === "unknown" || branch === "HEAD") continue;
    map.set(branch, [...(map.get(branch) ?? []), id]);
  }
  return map;
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** @param {string} root */
function cachePath(root) {
  const common = git(["rev-parse", "--git-common-dir"], root);
  return common === null ? null : join(resolve(root, common.trim()), PR_CACHE_NAME);
}

/** @param {string | null} path */
function readCache(path) {
  try {
    const parsed = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The git and `gh` side of the rules for the checkout at `root`. Everything loads on first use and
 * once per process; a git or `gh` failure answers "not closed", so an item is never hidden on a
 * missing fact.
 * @param {string} root @param {string} base `kit.json` `baseBranch`
 * @param {{ network?: boolean, gh?: string, sessionsByBranch?: Map<string, string[]> }} [options]
 *   `network`: may call `gh` (not in the brief). `sessionsByBranch`: the ledger's records, branch →
 *   their session ids (`branchSessions`), which prove a deleted branch landed.
 * @returns {CloseFacts & { save: () => void }}
 */
export function gitCloseFacts(
  root,
  base,
  { network = false, gh = process.env.LEDGER_GH || "gh", sessionsByBranch = new Map() } = {},
) {
  /**
   * @type {{ heads: Map<string, string>, tracking: Map<string, string[]>, aliases: Map<string, string>,
   *   remotes: Set<string> } | null} `tracking`: branch name → its remote-tracking refs
   */
  let refs = null;
  /** @type {ReturnType<typeof parseMergeSubjects> | null} */
  let merges = null;
  const memo = new Map();
  const once = (key, compute) => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  const file = cachePath(root);
  let cache = null;
  let cacheChanged = false;
  let ghCalls = 0;
  let ghMissing = false;

  const loadRefs = () => {
    if (refs) return refs;
    const out = git(["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads", "refs/remotes"], root) ?? "";
    const heads = new Map();
    const tracking = new Map();
    const aliases = new Map();
    const remotes = new Set();
    for (const line of out.split("\n")) {
      const [ref, sha] = line.split("\t");
      if (!ref || !sha) continue;
      if (ref.startsWith("refs/heads/")) {
        heads.set(ref.slice(11), sha);
        continue;
      }
      const [remote, ...rest] = ref.slice(13).split("/");
      const name = rest.join("/");
      if (!name || name === "HEAD") continue;
      remotes.add(remote);
      aliases.set(`${remote}/${name}`, name);
      tracking.set(name, [...(tracking.get(name) ?? []), ref]);
    }
    refs = { heads, tracking, aliases, remotes };
    return refs;
  };

  /**
   * Integration branches: local branches outside `claude/`, and the base's remote-tracking refs when
   * there is no local base. Ordered so a reason names the likely one: the base, then the branches
   * a worktree has checked out (the main checkout usually sits on the integration branch).
   */
  const integration = () =>
    once("integration", () => {
      const { heads, tracking } = loadRefs();
      const porcelain = git(["worktree", "list", "--porcelain"], root) ?? "";
      const checkedOut = new Set([...porcelain.matchAll(/^branch refs\/heads\/(.+)$/gm)].map((m) => m[1]));
      const rank = (name) => (name === base ? 0 : checkedOut.has(name) ? 1 : 2);
      const names = [...heads.keys()].filter((name) => !name.startsWith("claude/")).sort((a, b) => rank(a) - rank(b));
      return [...names.map((name) => `refs/heads/${name}`), ...(heads.has(base) ? [] : (tracking.get(base) ?? []))];
    });

  /** `worktree-flow base` records: branch → its base, from one `git config` read. */
  const recordedBases = () =>
    once("kitBase", () => {
      const out = git(["config", "--get-regexp", "^branch\\..*\\.kitbase$"], root) ?? "";
      return new Map(
        out
          .split("\n")
          .map((line) => line.match(/^branch\.(.+)\.kitbase (.+)$/i))
          .filter(Boolean)
          .map((m) => [m[1], m[2].trim()]),
      );
    });

  /** The refs a branch lands in (see rule 4), as full ref names. */
  const holders = (name) =>
    once(`holders ${name}`, () => {
      const { heads, tracking } = loadRefs();
      const recorded = recordedBases().get(name);
      const refsOf = (branch) => (heads.has(branch) ? [`refs/heads/${branch}`] : (tracking.get(branch) ?? []));
      if (recorded) return refsOf(recorded);
      if (name.startsWith("claude/")) return integration().filter((ref) => ref !== `refs/heads/${name}`);
      return name === base ? [] : refsOf(base);
    });

  /**
   * Commits carrying a `Session-Id` trailer: session id → `{ sha, at }[]`, read from `revs`.
   * @param {string[]} revs
   */
  const sessionCommits = (revs) =>
    once(`sessions ${revs.join(" ")}`, () => {
      const out = git(["log", "--format=%H%x09%ct%x09%(trailers:key=Session-Id,valueonly,separator=%x2C)%x1e", ...revs], root);
      const bySession = new Map();
      for (const entry of (out ?? "").split("\x1e")) {
        const [sha, at, ids] = entry.trim().split("\t");
        if (!sha || !ids) continue;
        for (const id of ids.split(",").map((s) => s.trim()).filter(Boolean))
          bySession.set(id, [...(bySession.get(id) ?? []), { sha, at: Number(at) * 1000 }]);
      }
      return bySession;
    });

  /**
   * A deleted branch, through the sessions whose records name it as their branch: landed when they
   * made commits, all of them are in `into`, and the newest is from the record's day or later.
   * @param {string[]} sessions @param {string[]} into @param {string} day
   */
  const sessionsLanded = (sessions, into, day) => {
    const everywhere = sessionCommits(["--all"]);
    const landed = sessionCommits(into);
    const commits = sessions.flatMap((id) => everywhere.get(id) ?? []);
    if (!commits.length) return null;
    const inInto = new Set(sessions.flatMap((id) => (landed.get(id) ?? []).map((c) => c.sha)));
    if (!commits.every((c) => inInto.has(c.sha))) return null;
    const newest = commits.reduce((a, b) => (b.at > a.at ? b : a));
    if (newest.at < Date.parse(`${day}T00:00:00Z`)) return null;
    const found = containing(newest.sha, into);
    return found.length ? firstHolder(found, newest.at) : null;
  };

  const loadMerges = () => {
    if (merges) return merges;
    const refsToRead = integration();
    const log = refsToRead.length ? git(["log", "--format=%cI%x09%s", ...refsToRead], root) : null;
    merges = parseMergeSubjects(log ?? "", loadRefs().remotes);
    return merges;
  };

  const isAncestor = (sha, of) =>
    once(`ancestor ${sha} ${of}`, () => spawnSync("git", ["merge-base", "--is-ancestor", sha, of], { cwd: root }).status === 0);

  /** A ref as it stood at `iso`, by its first-parent history; null when it did not exist yet. */
  const refAt = (ref, iso) =>
    once(`at ${ref} ${iso}`, () => git(["rev-list", "-1", "--first-parent", `--before=${iso}`, ref], root)?.trim() || null);

  /** The refs among `candidates` that contain `sha`, from one `for-each-ref --contains`. */
  const containing = (sha, candidates) => {
    const all = once(`contains ${sha}`, () => {
      const out = git(["for-each-ref", "--contains", sha, "--format=%(refname)", "refs/heads", "refs/remotes"], root);
      return new Set((out ?? "").split("\n").filter(Boolean));
    });
    return candidates.filter((ref) => all.has(ref));
  };

  const shortName = (ref) => ref.replace(/^refs\/(?:heads|remotes)\//, "");

  /** When a ref was created, from its reflog's oldest entry when that entry is the creation; else null. */
  const createdAt = (ref) =>
    once(`created ${ref}`, () => {
      const lines = (git(["reflog", "show", "--format=%ct%x09%gs", ref], root) ?? "").trim().split("\n");
      const [at, subject = ""] = (lines.at(-1) ?? "").split("\t");
      return /^branch: Created\b/.test(subject) ? Number(at) * 1000 : null;
    });

  const commitTime = (rev) => once(`time ${rev}`, () => Number(git(["log", "-1", "--format=%ct", rev], root)) * 1000);

  /**
   * The holder the work first landed in. A branch cut from the integration branch later holds the
   * same commits, so a holder its reflog shows was created after `landedAt` is passed over; the
   * order of `holders` (`integration`) decides among the rest.
   * @param {string[]} found Holders containing the work, in order. @param {number} landedAt ms
   */
  const firstHolder = (found, landedAt) =>
    found.find((ref) => {
      const created = createdAt(ref);
      return created === null || created <= landedAt;
    }) ?? found[0];

  /** @type {CloseFacts["branchLanded"]} */
  const branchLanded = (candidate, day) => {
    const { heads, tracking, aliases } = loadRefs();
    const name = aliases.get(candidate) ?? candidate;
    const own = [...(heads.has(name) ? [`refs/heads/${name}`] : []), ...(tracking.get(name) ?? [])];
    const sessions = sessionsByBranch.get(name) ?? [];
    // Most words with a slash are paths: settle those before any per-name git call.
    if (!own.length && !sessions.length && !loadMerges().branches.has(name)) return null;
    const into = holders(name);
    if (!into.length) return null;
    if (own.length) {
      const dayStart = `${day}T00:00:00Z`;
      for (const ref of own) {
        // Landed since the record's day began: some holder has it now and did not have it then.
        const since = containing(ref, into).filter((holder) => {
          const then = refAt(holder, dayStart);
          return !then || !isAncestor(ref, then);
        });
        if (since.length) return { branch: name, into: shortName(firstHolder(since, commitTime(ref))) };
      }
      return null;
    }
    const bySessions = sessions.length ? sessionsLanded(sessions, into, day) : null;
    if (bySessions) return { branch: name, into: shortName(bySessions) };
    const at = loadMerges().branches.get(name);
    return at && at.slice(0, 10) >= day ? { branch: name, into: into.map(shortName).join(" or ") } : null;
  };

  /** @type {CloseFacts["branchPushed"]} */
  const branchPushed = (candidate, day) => {
    const { heads, tracking, aliases } = loadRefs();
    const name = aliases.get(candidate) ?? candidate;
    // The base is named as context far more often than as the thing to push.
    if (name === base || !heads.has(name) || !tracking.has(name)) return null;
    const dayEnd = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString();
    const then = refAt(`refs/heads/${name}`, dayEnd);
    if (!then) return null;
    const to = tracking.get(name).find((ref) => isAncestor(then, ref));
    return to ? { branch: name, to: shortName(to) } : null;
  };

  const askGh = (ref) => {
    if (!network || ghMissing || ghCalls >= MAX_GH_CALLS) return null;
    ghCalls += 1;
    const args = ["pr", "view", String(ref.n), "--json", "state,mergedAt", ...(ref.repo ? ["--repo", ref.repo] : [])];
    const result = spawnSync(gh, args, { cwd: root, encoding: "utf8", timeout: GH_TIMEOUT_MS });
    if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
      ghMissing = true;
      return null;
    }
    let answer = { state: "UNKNOWN", mergedAt: null };
    try {
      if (result.status === 0) answer = { ...answer, ...JSON.parse(result.stdout) };
    } catch {
      /* an unreadable answer is UNKNOWN, asked again after the recheck window */
    }
    return { state: String(answer.state), mergedAt: answer.mergedAt ?? null, checkedAt: new Date().toISOString() };
  };

  /** @type {CloseFacts["prMerged"]} */
  const prMerged = (ref, day) => {
    if (!ref.repo) {
      const at = loadMerges().prs.get(ref.n);
      if (at) return at.slice(0, 10) >= day;
    }
    cache ??= readCache(file);
    const key = `${ref.repo ?? ""}#${ref.n}`;
    let entry = cache[key];
    const fresh = entry && (entry.state === "MERGED" || Date.now() - Date.parse(entry.checkedAt) < PR_RECHECK_MS);
    if (!fresh) {
      const answer = askGh(ref);
      if (answer) {
        entry = answer;
        cache[key] = answer;
        cacheChanged = true;
      }
    }
    return Boolean(entry?.state === "MERGED" && entry.mergedAt && entry.mergedAt.slice(0, 10) >= day);
  };

  const save = () => {
    if (!cacheChanged || !file) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(cache, null, 1)}\n`, "utf8");
      renameSync(tmp, file);
      cacheChanged = false;
    } catch {
      /* the cache only saves `gh` calls; losing it costs a lookup next time */
    }
  };

  return { prMerged, branchLanded, branchPushed, save };
}
