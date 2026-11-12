// `kit release [--yes] [--summary <text>] [--summary-<lang> <text>]`: cut a release of a kit's own
// repo by moving its `stable` tag, as one checked step. A dry run by default: it runs the checks
// and prints each step it would take. With `--yes` it writes the release notes, runs the repo's
// check on the result, commits `chore(release): <nth> stable release` on the integration branch
// (`baseBranch`, usually `dev`) and pushes it, fast-forwards the release branch (`main`) to that
// commit when it is another branch, moves the annotated tag and pushes it, then reads the remote
// back to confirm the tag and the branches name the release commit. `kit.json` `release` says where the notes live and what to check
// (docs/changing.md, Releasing).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKit } from "../lib/kit-config.mjs";

const ONES = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];
const TEENS = ["tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const TENTHS = ["", "", "twentieth", "thirtieth", "fortieth", "fiftieth", "sixtieth", "seventieth", "eightieth", "ninetieth"];

/** The English ordinal word of `n` (1 → first, 21 → twenty-first); past 99, `100th`. @param {number} n */
export function ordinalWord(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`no ordinal for ${n}`);
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  if (n < 100) return n % 10 === 0 ? TENTHS[n / 10] : `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}`;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** The number an ordinal word or a plain number names, or null. @param {string} text */
export function ordinalNumber(text) {
  const value = String(text).trim().toLowerCase();
  if (/^\d+$/.test(value)) return Number(value) || null;
  const numeric = value.match(/^(\d+)(st|nd|rd|th)$/);
  if (numeric) return Number(numeric[1]) || null;
  for (let n = 1; n < 100; n += 1) if (ordinalWord(n) === value) return n;
  return null;
}

/** Today in the local time zone, as YYYY-MM-DD. @param {Date} [now] */
export function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const FORMATS = new Set(["changelog", "table"]);

/**
 * `kit.json` `release` with its defaults: the branch released from (`from`, the integration branch
 * `baseBranch`) and the release branch (`branch`, `main`), the remote, the tag moved, the check run
 * before the commit, the notes files and, for an overlay, the base-kit release it needs. When
 * `from` and `branch` differ, the release commit lands on `from` and `branch` is fast-forwarded to it.
 * @param {ReturnType<typeof readKit>} kit
 */
export function releaseConfig(kit) {
  const raw = kit.raw?.release && typeof kit.raw.release === "object" ? kit.raw.release : {};
  const errors = [];
  const text = (value, fallback) => (typeof value === "string" && value.trim() !== "" ? value.trim() : fallback);
  const notesList = Array.isArray(raw.notes) && raw.notes.length > 0 ? raw.notes : ["CHANGELOG.md"];
  const notes = notesList.map((entry) => {
    const item = typeof entry === "string" ? { path: entry } : entry && typeof entry === "object" ? entry : {};
    const format = text(item.format, "changelog");
    if (typeof item.path !== "string" || item.path === "") errors.push("release.notes: an entry has no path");
    if (!FORMATS.has(format)) errors.push(`release.notes: ${item.path} has format "${format}" (changelog or table)`);
    return { path: item.path, format, lang: text(item.lang, null) };
  });
  let base = null;
  if (raw.base !== undefined) {
    const repo = text(raw.base?.repo, null);
    const needs = text(raw.base?.needs, null);
    if (!repo || !needs) errors.push("release.base needs both repo and needs");
    else base = { repo, needs, tag: text(raw.base.tag, "stable") };
  }
  return {
    branch: text(raw.branch, "main"),
    from: text(raw.from, kit.baseBranch),
    remote: text(raw.remote, "origin"),
    tag: text(raw.tag, "stable"),
    check: text(raw.check, kit.commands.check ?? null),
    notes,
    base,
    errors,
  };
}

const RELEASE_HEADING = /^## (\d{4}-\d{2}-\d{2})\b(.*)$/;

/**
 * A changelog with its `## Unreleased` body moved under a dated release heading.
 * @param {string} content @param {{ date: string, tag: string, summary: string | null, number?: number }} release
 * @returns {{ error: string } | { count: number, next: number, content: string, moved: number }}
 */
export function cutChangelog(content, { date, tag, summary, number }) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => /^## Unreleased\s*$/i.test(line));
  if (start < 0) return { error: "has no `## Unreleased` heading" };
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end < 0) end = lines.length;
  const releases = lines.filter((line) => RELEASE_HEADING.test(line));
  const count = releases.length;
  const latestWord = releases[0]?.match(RELEASE_HEADING)?.[2].match(/—\s*(\S+)/)?.[1];
  if (latestWord && ordinalNumber(latestWord) !== null && ordinalNumber(latestWord) !== count) {
    return { error: `counts ${count} release heading(s), but the latest says "${latestWord}"` };
  }
  const body = lines.slice(start + 1, end);
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  if (body.length === 0) return { error: "has nothing under `## Unreleased`" };
  const next = number ?? count + 1;
  const lead = `\`${tag}\` points at the commit that adds this entry.${summary ? ` ${summary}` : ""}`;
  const rest = lines.slice(end);
  const out = [...lines.slice(0, start + 1), "", `## ${date} — ${ordinalWord(next)} \`${tag}\``, "", lead, "", ...body, ...(rest.length > 0 ? ["", ...rest] : [""])];
  return { count, next, content: out.join("\n"), moved: body.length };
}

/** The cells of a markdown table row, split on unescaped pipes. @param {string} line */
function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/**
 * A release table (the last table in the file) with one more row: the previous row's cells with
 * the id counted up, the date set to today and the last cell holding the summary.
 * @param {string} content @param {{ date: string, summary: string | null }} release
 * @returns {{ error: string } | { count: number, next: number, content: string, row: string }}
 */
export function cutTable(content, { date, summary }) {
  const lines = content.split("\n");
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().startsWith("|")) {
      last = i;
      break;
    }
  }
  if (last < 0) return { error: "has no table" };
  let first = last;
  while (first > 0 && lines[first - 1].trim().startsWith("|")) first -= 1;
  if (last - first < 2) return { error: "has a release table with no row to follow; add the first release by hand" };
  const previous = cells(lines[last]);
  const id = Number(previous[0]);
  if (!Number.isInteger(id)) return { error: `release table's last row starts with "${previous[0]}", not a number` };
  if (!summary) return { error: "needs a summary for the new row" };
  const row = previous.map((cell, index) => {
    if (index === 0) return String(id + 1);
    if (index === previous.length - 1) return summary.replace(/(?<!\\)\|/g, "\\|");
    return /^\d{4}-\d{2}-\d{2}$/.test(cell) ? date : cell;
  });
  const line = `| ${row.join(" | ")} |`;
  return { count: id, next: id + 1, content: [...lines.slice(0, last + 1), line, ...lines.slice(last + 1)].join("\n"), row: line };
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

/** The commit a tag (or branch) on a remote names, peeled; null when it has none. */
function remoteCommit(cwd, remote, ref) {
  const listed = git(cwd, ["ls-remote", remote, ref, `${ref}^{}`]);
  if (!listed.ok) return { error: listed.err || `cannot read ${remote}` };
  const rows = listed.out.split("\n").filter(Boolean).map((line) => line.split("\t"));
  const peeled = rows.find(([, name]) => name === `${ref}^{}`) ?? rows.find(([, name]) => name === ref);
  return { commit: peeled ? peeled[0] : null };
}

/**
 * Whether the base kit's tag already holds the release an overlay needs: a commit (its sha), or a
 * release named by its number or ordinal word (the base's `chore(release): <nth> <tag> release`).
 * @param {{ repo: string, needs: string, tag: string }} base
 * @returns {{ ok: boolean, detail: string }}
 */
export function baseContains(base) {
  const dir = mkdtempSync(join(tmpdir(), "kit-release-base-"));
  try {
    git(dir, ["init", "--bare", "-q"]);
    const fetched = git(dir, ["fetch", "-q", "--filter=blob:none", base.repo, `+refs/tags/${base.tag}:refs/tags/${base.tag}`]);
    if (!fetched.ok) return { ok: false, detail: `cannot fetch ${base.tag} from ${base.repo}: ${fetched.err.split("\n").pop()}` };
    const tagged = git(dir, ["rev-parse", `refs/tags/${base.tag}^{commit}`]).out;
    if (/^[0-9a-f]{7,40}$/i.test(base.needs)) {
      const commit = git(dir, ["rev-parse", "--verify", "-q", `${base.needs}^{commit}`]);
      const holds = commit.ok && git(dir, ["merge-base", "--is-ancestor", commit.out, tagged]).ok;
      return { ok: holds, detail: `${base.repo} ${base.tag} (${tagged.slice(0, 12)}) ${holds ? "contains" : "does not contain"} ${base.needs}` };
    }
    const n = ordinalNumber(base.needs);
    if (n === null) return { ok: false, detail: `release.base.needs "${base.needs}" is neither a commit nor a release number` };
    const subject = `chore(release): ${ordinalWord(n)} ${base.tag} release`;
    const subjects = git(dir, ["log", "--format=%s", tagged]).out.split("\n");
    const holds = subjects.includes(subject);
    return { ok: holds, detail: `${base.repo} ${base.tag} (${tagged.slice(0, 12)}) ${holds ? "contains" : "does not yet contain"} its ${ordinalWord(n)} release` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EVOLUTION_PAGES = ["process-evolution.md", "features-evolution.md"];

/**
 * One release step line on the project's evolution pages, or null when it keeps none: which page
 * the commits since the last release left unchanged. A release is when the pages are brought up to
 * date (the session plugin's `evolution` skill), so the dry run names the ones still to do; it
 * never refuses.
 * @param {string} root @param {string} folder `kit.json` `paths.evolution`
 * @param {string | null} since The commit the tag names now; null on a first release.
 * @param {string} tag
 */
export function evolutionLine(root, folder, since, tag) {
  const pages = EVOLUTION_PAGES.map((name) => `${folder}/${name}`).filter((path) => existsSync(join(root, ...path.split("/"))));
  if (pages.length === 0) return null;
  const todo = "bring them up to date first: `evolution status --since-release` and the `evolution` skill (session plugin)";
  if (!since) return `Evolution pages: ${pages.join(", ")}; first release, ${todo}`;
  const stale = pages.filter((path) => git(root, ["diff", "--quiet", since, "--", path]).ok);
  if (stale.length === 0) return `Evolution pages: ${pages.join(", ")} changed since ${tag}`;
  return `Evolution pages: ${stale.join(", ")} unchanged since ${tag}; ${todo}, or release without them`;
}

const SUMMARY_FLAG = /^--summary(?:-([a-z]{2,8}))?$/;

/**
 * `kit release` arguments: `--yes`, `--summary <text>` and `--summary-<lang> <text>`.
 * @param {string[]} args
 */
export function parseReleaseArgs(args) {
  const errors = [];
  /** @type {Record<string, string>} */
  const summaries = {};
  let yes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const match = flag.match(SUMMARY_FLAG);
    if (!match) {
      errors.push(`unknown argument ${arg}`);
      continue;
    }
    const value = inline ?? args[i + 1];
    if (inline === undefined) i += 1;
    if (value === undefined || value.trim() === "" || (inline === undefined && value.startsWith("--"))) {
      errors.push(`${flag} needs a text`);
      continue;
    }
    if (/[\r\n]/.test(value)) errors.push(`${flag} must be one line`);
    summaries[match[1] ?? ""] = value.trim();
  }
  return { yes, summaries, errors };
}

/**
 * Run `kit release` in `root`. Returns the exit code: 0 done (or a clean dry run), 1 refused or
 * failed, 2 a usage error.
 * @param {string} root
 * @param {string[]} args
 * @param {{ print?: (line: string) => void, today?: string, checkOutput?: "inherit" | "pipe" }} [options]
 */
export function runRelease(root, args, options = {}) {
  const print = options.print ?? console.log;
  const parsed = parseReleaseArgs(args);
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) print(`kit release: ${error}`);
    return 2;
  }
  const kit = readKit(root);
  if (kit.error) {
    print(`kit release: ${kit.error}`);
    return 2;
  }
  const config = releaseConfig(kit);
  if (config.errors.length > 0) {
    for (const error of config.errors) print(`kit release: kit.json ${error}`);
    return 2;
  }
  const { branch, from, remote, tag } = config;
  // Promote: the release commit lands on the integration branch, and the release branch follows it.
  const promote = from !== branch;
  const today = options.today ?? localDate();
  const refusals = [];
  let step = 0;
  const say = (text) => print(`${(step += 1)}. ${text}`);
  const refuse = (text) => {
    refusals.push(text);
    print(`   refused: ${text}`);
  };

  print(parsed.yes ? `kit release in ${root}` : `kit release in ${root} (dry run; --yes does it)`);

  // 1. The tree: on the branch released from, nothing uncommitted, level with the remote.
  const current = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).out;
  const dirty = git(root, ["status", "--porcelain"]).out;
  const fetched = git(root, ["fetch", "-q", remote, `+refs/heads/${from}:refs/remotes/${remote}/${from}`]);
  const head = git(root, ["rev-parse", "HEAD"]).out;
  say(`Tree: branch ${current || "(detached)"} at ${head.slice(0, 12)}, ${remote}/${from}`);
  if (current !== from) refuse(`on ${current || "a detached HEAD"}, not ${from}`);
  if (dirty) refuse(`the tree has uncommitted or untracked files (${dirty.split("\n").length})`);
  if (!fetched.ok) refuse(`cannot fetch ${from} from ${remote}: ${fetched.err.split("\n").pop()}`);
  else {
    const counts = git(root, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/${remote}/${from}`]).out.split(/\s+/).map(Number);
    if (counts[0] > 0) refuse(`HEAD is ${counts[0]} commit(s) ahead of ${remote}/${from}; push or land them first`);
    if (counts[1] > 0) refuse(`HEAD is ${counts[1]} commit(s) behind ${remote}/${from}; pull first`);
  }

  // 1b. The release branch, when it is not the one released from: it must fast-forward to HEAD.
  if (promote) {
    const target = remoteCommit(root, remote, `refs/heads/${branch}`);
    if (target.error) {
      say(`Release branch ${remote}/${branch}: unreadable`);
      refuse(target.error);
    } else if (target.commit === null) {
      say(`Release branch ${remote}/${branch}: none yet; the release creates it from ${from}`);
    } else {
      const got = git(root, ["fetch", "-q", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
      const behind = git(root, ["rev-list", "--count", `refs/remotes/${remote}/${branch}..HEAD`]).out;
      say(`Release branch ${remote}/${branch}: ${target.commit.slice(0, 12)}, ${behind || "?"} commit(s) behind ${from}; fast-forwarded to the release commit`);
      if (!got.ok) refuse(`cannot fetch ${branch} from ${remote}: ${got.err.split("\n").pop()}`);
      else if (!git(root, ["merge-base", "--is-ancestor", `refs/remotes/${remote}/${branch}`, "HEAD"]).ok) {
        refuse(`${remote}/${branch} has commits that ${from} lacks; merge ${branch} into ${from} and land that first`);
      }
    }
  }

  // 2. The tag on the remote: something to release, and the tag on this branch's history.
  const tagged = remoteCommit(root, remote, `refs/tags/${tag}`);
  if (tagged.error) {
    say(`${tag} on ${remote}: unreadable`);
    refuse(tagged.error);
  } else if (tagged.commit === null) {
    say(`${tag} on ${remote}: none yet (first release)`);
  } else {
    const since = git(root, ["rev-list", "--count", `${tagged.commit}..HEAD`]);
    say(`${tag} on ${remote}: ${tagged.commit.slice(0, 12)}${since.ok ? `, ${since.out} commit(s) to release` : ""}`);
    if (tagged.commit === head) refuse(`nothing to release: ${tag} already points at HEAD`);
    else if (!git(root, ["merge-base", "--is-ancestor", tagged.commit, "HEAD"]).ok) refuse(`${tag} (${tagged.commit.slice(0, 12)}) is not on ${from}'s history`);
  }

  // 3. The notes: each file cut in memory, all agreeing on the release number.
  const cuts = [];
  for (const note of config.notes) {
    let content;
    try {
      content = readFileSync(join(root, note.path), "utf8");
    } catch {
      refuse(`${note.path} is missing`);
      continue;
    }
    const summary = note.lang ? parsed.summaries[note.lang] ?? null : parsed.summaries[""] ?? null;
    const cut = note.format === "table" ? cutTable(content, { date: today, summary }) : cutChangelog(content, { date: today, tag, summary });
    if ("error" in cut) {
      const flag = note.lang ? `--summary-${note.lang}` : "--summary";
      refuse(`${note.path} ${cut.error}${cut.error.startsWith("needs a summary") ? ` (${flag} "<text>")` : ""}`);
      continue;
    }
    cuts.push({ ...note, before: content, ...cut });
  }
  const numbers = [...new Set(cuts.map((cut) => cut.next))];
  if (numbers.length > 1) refuse(`the notes disagree on the release number (${cuts.map((cut) => `${cut.path}: ${cut.next}`).join(", ")})`);
  const number = numbers[0];
  const word = number ? ordinalWord(number) : null;
  const subject = word ? `chore(release): ${word} ${tag} release` : null;
  const tagMessage = word ? `${today}: ${word} release` : null;
  say(word ? `Release: ${word} \`${tag}\`, dated ${today}` : "Release: number unknown (see the notes above)");

  // The evolution pages (session plugin), when the project keeps them: reported, never refused.
  const evolution = tagged.error ? null : evolutionLine(root, kit.paths.evolution, tagged.commit, tag);
  if (evolution) say(evolution);

  // 4. An overlay's base kit: its tag already holds the release this one needs.
  if (config.base) {
    const held = baseContains(config.base);
    say(`Base: ${held.detail}`);
    if (!held.ok) refuse(`the base kit's ${config.base.tag} lacks the release this one needs (kit.json release.base.needs ${config.base.needs})`);
  }

  if (!config.check) {
    say("Check: none set");
    refuse("no check to run: set kit.json release.check or commands.check");
  }

  const runCheck = () => {
    const ran = spawnSync(config.check, { cwd: root, shell: true, stdio: options.checkOutput ?? "inherit", encoding: "utf8" });
    return ran.status === 0;
  };

  if (!parsed.yes) {
    if (config.check) {
      if (refusals.length > 0) say(`Check \`${config.check}\`: not run (refused above)`);
      else {
        const passed = runCheck();
        say(`Check \`${config.check}\` on the current tree: ${passed ? "passed" : "failed"}`);
        if (!passed) refuse("the check fails");
      }
    }
    for (const cut of cuts) say(`Would write ${cut.path}: ${cut.format === "table" ? `add row ${cut.next}` : `move ${cut.moved} line(s) from \`## Unreleased\` under \`## ${today} — ${word} \`${tag}\`\``}`);
    say(`Would run the check again on the written notes, commit \`${subject ?? "chore(release): …"}\` and push ${remote} ${from}`);
    if (promote) say(`Would fast-forward ${remote} ${branch} to the release commit (never forced)`);
    say(`Would move the annotated tag ${tag} ("${tagMessage ?? "…"}") and push ${remote} +refs/tags/${tag}`);
    say(`Would confirm ${tag}^{}${promote ? `, ${from} and ${branch}` : ` and ${branch}`} on ${remote} all name the release commit`);
    print(refusals.length > 0 ? `Refused: ${refusals.length} reason(s) above.` : "Ready: run `kit release --yes` with the same arguments to release.");
    return refusals.length > 0 ? 1 : 0;
  }

  if (refusals.length > 0) {
    print(`Refused: ${refusals.length} reason(s) above; nothing was changed.`);
    return 1;
  }

  // 5. Write the notes, check the result, commit. A failure puts the notes back.
  const restore = () => cuts.forEach((cut) => writeFileSync(join(root, cut.path), cut.before));
  for (const cut of cuts) writeFileSync(join(root, cut.path), cut.content);
  say(`Wrote ${cuts.map((cut) => cut.path).join(", ")}`);
  const passed = runCheck();
  say(`Check \`${config.check}\`: ${passed ? "passed" : "failed"}`);
  if (!passed) {
    restore();
    print("Refused: the check fails; the notes are back as they were.");
    return 1;
  }
  const paths = cuts.map((cut) => cut.path);
  const committed = git(root, ["commit", "-q", "-m", subject, "--", ...paths]);
  if (!committed.ok) {
    restore();
    print(`Failed: git commit: ${committed.err}`);
    print("The notes are back as they were; nothing was pushed.");
    return 1;
  }
  const release = git(root, ["rev-parse", "HEAD"]).out;
  say(`Committed ${release.slice(0, 12)} \`${subject}\``);

  // 6. Push the branch released from (never forced), fast-forward the release branch to it (never
  // forced), then move and push the tag (the one forced ref).
  const pushed = git(root, ["push", "-q", remote, `refs/heads/${from}:refs/heads/${from}`]);
  if (!pushed.ok) {
    print(`Failed: git push ${remote} ${from}: ${pushed.err.split("\n").pop()}`);
    print(`The release commit is local only; the tag was not moved. Pull, then rerun or push by hand.`);
    return 1;
  }
  say(`Pushed ${remote} ${from}`);
  if (promote) {
    const forwarded = git(root, ["push", "-q", remote, `${release}:refs/heads/${branch}`]);
    if (!forwarded.ok) {
      print(`Failed: fast-forwarding ${remote} ${branch}: ${forwarded.err.split("\n").pop()}`);
      print(`${from} holds the release commit; ${branch} and the tag were not moved. Fast-forward ${branch} by hand (git push ${remote} ${from}:${branch}), then move the tag: git tag -fa ${tag}, git push ${remote} +refs/tags/${tag}.`);
      return 1;
    }
    say(`Fast-forwarded ${remote} ${branch} to the release commit`);
    // The local release branch follows when it is behind and no worktree has it checked out.
    const local = git(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
    if (local.ok && local.out !== release) {
      const moved = git(root, ["merge-base", "--is-ancestor", local.out, release]).ok && git(root, ["branch", "-f", branch, release]).ok;
      if (!moved) print(`   note: local ${branch} was left as it is; pull it to follow ${remote}/${branch}`);
    }
  }
  const moved = git(root, ["tag", "-f", "-a", tag, "-m", tagMessage, release]);
  const tagPushed = moved.ok && git(root, ["push", "-q", remote, `+refs/tags/${tag}`]);
  if (!moved.ok || !tagPushed.ok) {
    print(`Failed: moving ${tag}: ${(moved.ok ? tagPushed.err : moved.err).split("\n").pop()}`);
    print(`${branch} holds the release commit; move the tag by hand: git tag -fa ${tag}, git push ${remote} +refs/tags/${tag}.`);
    return 1;
  }
  say(`Moved ${tag} ("${tagMessage}") and pushed it`);

  // 7. Read the remote back.
  const after = remoteCommit(root, remote, `refs/tags/${tag}`);
  const branches = promote ? [from, branch] : [branch];
  const heads = branches.map((name) => ({ name, commit: remoteCommit(root, remote, `refs/heads/${name}`).commit }));
  const verified = after.commit === release && heads.every((h) => h.commit === release);
  const shown = heads.map((h) => `${h.name} ${h.commit?.slice(0, 12) ?? "?"}`).join(", ");
  say(`${remote}: ${tag}^{} ${after.commit?.slice(0, 12) ?? "?"}, ${shown}: ${verified ? `${promote ? "all" : "both"} the release commit` : "MISMATCH"}`);
  print(verified ? `Released the ${word} \`${tag}\`.` : `Failed: ${remote} does not show the release; check by hand.`);
  return verified ? 0 : 1;
}
