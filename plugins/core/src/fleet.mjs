// `kit fleet --source github`: the kit state of several repos, read from GitHub rather than from
// local clones, for a scheduled job. Each repo is read at its default branch (or the branch its
// list entry names) and each kit at its channel ref (`stable`), as archives through the GitHub API
// with a token from the environment. The report covers, per repo:
//
//   1. copies of kit-owned files, by the same check `kit doctor --strict` runs, with ownership read
//      from every kit's plugins at that kit's channel commit;
//   2. the kit marketplaces `.claude/settings.json` declares, and their refs;
//   3. the kit commits the root lockfiles pin, against each kit's channel commit;
//   4. drift: shared agent-tooling files whose git blob fingerprints differ between repos.
//
// The repo list is the caller's configuration, never part of the kit (docs/using.md § 5):
//
//   { "repos": { "app": "my-org/my-app", "api": { "repo": "my-org/my-api", "branch": "dev" } },
//     "kits": [{ "repo": "my-org/my-overlay", "ref": "stable" }],
//     "ignoreDrift": ["scripts/build.mjs"] }
//
// The base kit (`3meyc/agent-kit#stable`) is always one of the kits. Exit 0 when clean, 1 on
// findings (an unreadable repo is one), 2 on a usage error (no list, no token).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { BASE_SOURCE } from "./adopt.mjs";
import { DEFAULT_FILES, DEFAULT_ROOTS, groupOf, walk } from "./inventory.mjs";
import { enabledForProject, findKitCopies, ownershipRootDirs, pluginName, TEST_FILE } from "./kit-owned.mjs";

/** Root lockfiles read for kit pins. */
export const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"];
const PER_PROJECT = new Set(DEFAULT_FILES);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * `owner/repo` or `owner/repo#ref`.
 * @param {string} spec @returns {{ repo: string, ref: string | null } | null}
 */
export function parseRepoSpec(spec) {
  const match = String(spec).trim().match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#(.+))?$/);
  return match ? { repo: match[1], ref: match[2] ?? null } : null;
}

/**
 * The repos and kits to check, from a list file and `--repo` / `--kit` arguments.
 * @param {{ list: string | null, repos: string[], kits: string[] }} options
 * @returns {{ repos: Array<{ name: string, repo: string, branch: string | null }>, kits: Array<{ repo: string, ref: string }>, ignoreDrift: string[] } | { error: string }}
 */
export function loadFleetList({ list, repos: repoArgs = [], kits: kitArgs = [] }) {
  let raw = {};
  if (list) {
    if (!existsSync(list)) return { error: `no repo list at ${list}` };
    raw = readJson(list);
    if (raw === null || typeof raw !== "object") return { error: `${list} does not parse as a JSON object` };
  }
  const repos = [];
  const errors = [];
  const addRepo = (name, entry) => {
    const spec = typeof entry === "string" ? parseRepoSpec(entry) : entry && typeof entry.repo === "string" ? parseRepoSpec(entry.repo) : null;
    if (!spec) {
      errors.push(`repo ${name ?? JSON.stringify(entry)}: expected "owner/repo", "owner/repo#branch" or { "repo": "owner/repo", "branch": "…" }`);
      return;
    }
    const branch = (typeof entry === "object" && typeof entry.branch === "string" && entry.branch) || spec.ref;
    repos.push({ name: name ?? spec.repo.split("/")[1], repo: spec.repo, branch: branch ?? null });
  };
  if (Array.isArray(raw.repos)) raw.repos.forEach((entry) => addRepo(typeof entry === "object" && entry?.name ? entry.name : null, entry));
  else for (const [name, entry] of Object.entries(raw.repos ?? {})) addRepo(name, entry);
  for (const arg of repoArgs) {
    const eq = arg.indexOf("=");
    if (eq > 0 && !arg.slice(0, eq).includes("/")) addRepo(arg.slice(0, eq), arg.slice(eq + 1));
    else addRepo(null, arg);
  }
  const base = parseRepoSpec(BASE_SOURCE);
  const kits = [{ repo: base.repo, ref: base.ref ?? "stable" }];
  const addKit = (entry) => {
    const spec = typeof entry === "string" ? parseRepoSpec(entry) : entry && typeof entry.repo === "string" ? parseRepoSpec(entry.repo) : null;
    if (!spec) {
      errors.push(`kit ${JSON.stringify(entry)}: expected "owner/repo#ref" or { "repo": "owner/repo", "ref": "stable" }`);
      return;
    }
    const ref = (typeof entry === "object" && typeof entry.ref === "string" && entry.ref) || spec.ref || "stable";
    const same = kits.findIndex((kit) => kit.repo.toLowerCase() === spec.repo.toLowerCase());
    if (same >= 0) kits[same].ref = ref;
    else kits.push({ repo: spec.repo, ref });
  };
  for (const entry of Array.isArray(raw.kits) ? raw.kits : []) addKit(entry);
  for (const arg of kitArgs) addKit(arg);
  if (errors.length > 0) return { error: errors.join("; ") };
  if (repos.length === 0) return { error: `no repos to check: list them under "repos" in ${list ?? "a --list file"} or pass --repo owner/repo` };
  const names = new Set();
  for (const repo of repos) {
    if (names.has(repo.name)) return { error: `repo name ${repo.name} is listed twice` };
    names.add(repo.name);
  }
  const ignoreDrift = Array.isArray(raw.ignoreDrift) ? raw.ignoreDrift.filter((item) => typeof item === "string") : [];
  return { repos, kits, ignoreDrift };
}

/**
 * A minimal GitHub REST client: JSON calls and repository archives.
 * @param {{ token: string, fetchImpl?: typeof fetch, api?: string }} options
 */
export function githubClient({ token, fetchImpl = fetch, api = process.env.GITHUB_API_URL || "https://api.github.com" }) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "agent-kit-fleet",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const call = async (path) => {
    const response = await fetchImpl(`${api}${path}`, { headers });
    if (response.ok) return response;
    let message = "";
    try {
      message = (await response.json())?.message ?? "";
    } catch {
      // A body that is not JSON: the status says enough.
    }
    const why =
      response.status === 404
        ? "not found, or the token cannot read it"
        : response.status === 401
          ? "the token was rejected"
          : `HTTP ${response.status}${message ? `: ${message}` : ""}`;
    const error = new Error(`GET ${path}: ${why}`);
    error.status = response.status;
    throw error;
  };
  return {
    json: async (path) => (await call(path)).json(),
    archive: async (repo, sha) => Buffer.from(await (await call(`/repos/${repo}/tarball/${sha}`)).arrayBuffer()),
  };
}

/** The commit a ref (branch, tag or SHA) points at. */
async function resolveRef(client, repo, ref) {
  const commit = await client.json(`/repos/${repo}/commits/${encodeURIComponent(ref)}`);
  return { sha: commit.sha, date: (commit.commit?.committer?.date ?? commit.commit?.author?.date ?? "").slice(0, 10) };
}

/** Unpack a GitHub tarball into `dir` (its single top folder dropped). */
function unpack(buffer, work, name) {
  const archive = `${name}.tar.gz`;
  writeFileSync(join(work, archive), buffer);
  mkdirSync(join(work, name), { recursive: true });
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", name], { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
  rmSync(join(work, archive), { force: true });
  return join(work, name);
}

/** Every file under `dir`, repo-relative with forward slashes. */
function allFiles(dir) {
  return walk(dir, false).map((abs) => relative(dir, abs).split("\\").join("/"));
}

/** The git blob id of a file's bytes, as `git hash-object` and the GitHub tree API give it. */
export function blobId(buffer) {
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

/** The agent-tooling files `kit inventory` scans (its default roots and files), with blob ids. */
export function fingerprints(dir) {
  const list = [];
  for (const root of DEFAULT_ROOTS) list.push(...walk(join(dir, root), root === "scripts"));
  for (const file of DEFAULT_FILES) if (existsSync(join(dir, file))) list.push(join(dir, file));
  const out = {};
  for (const abs of new Set(list)) {
    const rel = relative(dir, abs).split("\\").join("/");
    if (TEST_FILE.test(rel)) continue;
    out[rel] = blobId(readFileSync(abs));
  }
  return out;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The commits of `kitRepo` a lockfile text pins: npm (`github.com/o/r.git#<sha>`), pnpm
 * (`codeload.github.com/o/r/tar.gz/<sha>`, `commit: <sha>, repo: …/o/r.git`), yarn and bun.
 * @param {string} text @param {string} kitRepo
 */
export function lockPins(text, kitRepo) {
  const repo = escapeRegExp(kitRepo);
  const patterns = [
    new RegExp(`github\\.com[/:]${repo}(?:\\.git)?(?:#|/tar\\.gz/|/)([0-9a-f]{40})`, "gi"),
    new RegExp(`github:${repo}#([0-9a-f]{40})`, "gi"),
    new RegExp(`commit: ([0-9a-f]{40}), repo: [^,}]*github\\.com[/:]${repo}(?:\\.git)?[,}\\s]`, "gi"),
  ];
  const found = new Set();
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[1].toLowerCase());
  return [...found];
}

/** The `extraKnownMarketplaces` entries of the shared settings. */
export function declaredMarketplaces(dir) {
  const entries = readJson(join(dir, ".claude", "settings.json"))?.extraKnownMarketplaces ?? {};
  return Object.entries(entries).map(([name, entry]) => {
    const source = entry?.source ?? {};
    const repo = source.source === "github" && typeof source.repo === "string" ? source.repo : typeof source.url === "string" ? source.url : null;
    return { name, repo, ref: typeof source.ref === "string" && source.ref ? source.ref : null };
  });
}

const sameRepo = (a, b) => {
  if (!a || !b) return false;
  const norm = (value) => value.toLowerCase().replace(/^.*github\.com[/:]/, "").replace(/\.git$/, "");
  return norm(a) === norm(b);
};

/** Each kit's channel commit, marketplace name and plugin folders (read from its archive). */
async function loadKits(client, kits, work, errors) {
  const loaded = [];
  for (const [index, kit] of kits.entries()) {
    try {
      const { sha, date } = await resolveRef(client, kit.repo, kit.ref);
      const dir = unpack(await client.archive(kit.repo, sha), work, `kit-${index}`);
      const manifest = readJson(join(dir, ".claude-plugin", "marketplace.json"));
      const name = typeof manifest?.name === "string" ? manifest.name : kit.repo.split("/")[1];
      const { roots } = existsSync(join(dir, "plugins")) ? ownershipRootDirs(["plugins"], dir) : { roots: [] };
      const plugins = roots.map((root) => ({ root, name: pluginName(root), source: "root", kit: name }));
      loaded.push({ ...kit, name, sha, date, plugins });
    } catch (error) {
      errors.push({ kind: "kit", repo: kit.repo, text: `kit ${kit.repo}#${kit.ref} unreadable: ${error.message}` });
    }
  }
  return loaded;
}

/** How far `pin` is behind the kit's channel commit, from the compare API (cached per pair). */
async function pinState(client, kit, pin, cache) {
  if (pin === kit.sha) return { state: "current", behind: 0 };
  const key = `${kit.repo}:${pin}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      client.json(`/repos/${kit.repo}/compare/${pin}...${kit.sha}`).then(
        // base = the pin, head = the channel: "ahead" means the channel moved on past the pin.
        (compare) =>
          compare.status === "identical" ? { state: "current", behind: 0 } : compare.status === "behind" ? { state: "ahead", behind: 0 } : { state: "behind", behind: compare.ahead_by ?? null },
        () => ({ state: "unknown", behind: null }),
      ),
    );
  }
  return cache.get(key);
}

/** One repo's state, or `{ error }` when it cannot be read. */
async function readRepo(client, entry, kits, work, index, compareCache) {
  const info = entry.branch ? null : await client.json(`/repos/${entry.repo}`);
  const branch = entry.branch ?? info.default_branch;
  const { sha, date } = await resolveRef(client, entry.repo, branch);
  const dir = unpack(await client.archive(entry.repo, sha), work, `repo-${index}`);
  const files = allFiles(dir);
  const plugins = kits.flatMap((kit) => kit.plugins);
  const copies = plugins.length === 0 ? [] : findKitCopies(dir, enabledForProject(dir, plugins, { local: false }), { tests: files.filter((file) => TEST_FILE.test(file)) });
  const byPlugin = new Map(plugins.map((plugin) => [plugin.name, plugin.kit]));
  const marketplaces = declaredMarketplaces(dir).map((market) => {
    const kit = kits.find((item) => sameRepo(item.repo, market.repo));
    return { ...market, kit: kit?.name ?? null, onChannel: kit ? market.ref === kit.ref || market.ref === kit.sha : null };
  });
  const pins = [];
  for (const file of LOCKFILES) {
    if (!existsSync(join(dir, file)) || statSync(join(dir, file)).size > 32 * 1024 * 1024) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const kit of kits) {
      for (const pin of lockPins(text, kit.repo)) pins.push({ kit: kit.name, file, sha: pin, ...(await pinState(client, kit, pin, compareCache)) });
    }
  }
  return {
    name: entry.name,
    repo: entry.repo,
    branch,
    sha,
    date,
    copies: copies.map((copy) => ({ ...copy, kit: byPlugin.get(copy.plugin) ?? null })),
    marketplaces,
    pins,
    files: fingerprints(dir),
  };
}

/**
 * Drift across repos: per file group (`skill:<name>` or a path), the fingerprint each repo holds,
 * for groups in two or more repos. Per-project files (`CLAUDE.md`, `kit.json`, settings…) are left
 * out: they differ by design. A group's fingerprint is one hash over its paths and blob ids.
 * @param {Array<{ name: string, files: Record<string, string> }>} repos @param {string[]} ignore
 */
export function measureFleetDrift(repos, ignore = []) {
  const ignored = (rel) => ignore.some((item) => rel === item || groupOf(rel) === item || rel.startsWith(item.endsWith("/") ? item : `${item}/`));
  /** @type {Map<string, Map<string, string[]>>} */
  const groups = new Map();
  for (const repo of repos) {
    for (const [rel, blob] of Object.entries(repo.files ?? {})) {
      if (PER_PROJECT.has(rel) || ignored(rel)) continue;
      const key = groupOf(rel);
      if (!groups.has(key)) groups.set(key, new Map());
      const by = groups.get(key);
      if (!by.has(repo.name)) by.set(repo.name, []);
      by.get(repo.name).push(`${rel}:${blob}`);
    }
  }
  const rows = [];
  for (const [group, by] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (by.size < 2) continue;
    const fingerprint = {};
    for (const [name, entries] of by) fingerprint[name] = createHash("sha1").update(entries.sort().join("\n")).digest("hex").slice(0, 7);
    const variants = new Set(Object.values(fingerprint)).size;
    rows.push({ group, status: variants === 1 ? "same" : `drift(${variants})`, by: fingerprint });
  }
  return rows;
}

/** Findings in report order: unreadable kits and repos, copies, marketplaces, pins, drift. */
export function collectFindings(report) {
  const findings = [...report.errors];
  for (const repo of report.repos) {
    for (const copy of repo.copies) {
      findings.push({ kind: "copy", repo: repo.name, text: `${copy.path} — supplied by ${copy.plugin}${copy.kit ? ` (${copy.kit})` : ""}${copy.note ? `: ${copy.note}` : ""}` });
    }
    for (const market of repo.marketplaces) {
      if (market.kit && market.onChannel === false) {
        const kit = report.kits.find((item) => item.name === market.kit);
        findings.push({ kind: "marketplace", repo: repo.name, text: `marketplace ${market.name} declared at ${market.ref ? `ref ${market.ref}` : "no ref (the default branch)"}, not ${kit?.ref ?? "the kit's channel"}` });
      }
    }
    for (const pin of repo.pins) {
      if (pin.state === "current") continue;
      const kit = report.kits.find((item) => item.name === pin.kit);
      const how = pin.state === "behind" && pin.behind !== null ? `${pin.behind} commit${pin.behind === 1 ? "" : "s"} behind` : pin.state === "ahead" ? "ahead of" : "not";
      findings.push({ kind: "pin", repo: repo.name, text: `${pin.file} pins ${pin.kit} at ${pin.sha.slice(0, 7)}, ${how} ${kit?.ref ?? "the channel"} (${kit?.sha.slice(0, 7) ?? "?"})` });
    }
  }
  for (const row of report.drift) {
    if (row.status === "same") continue;
    findings.push({ kind: "drift", repo: Object.keys(row.by).join(", "), text: `${row.group} ${row.status}: ${Object.entries(row.by).map(([name, fp]) => `${name}=${fp}`).join(" ")}` });
  }
  return findings;
}

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The report as Markdown, numbered for replies by reference (F1, R1, K1, D1). */
export function renderMarkdown(report) {
  const lines = [`# Kit fleet check, ${report.date}`, ""];
  const count = report.findings.length;
  lines.push(count === 0 ? "No findings: every repo is on its kits' channel, with no kit-owned copies and no drift." : `${count} finding${count === 1 ? "" : "s"}.`, "");
  lines.push("## 1. Kits", "", "| ID | Kit | Repo | Channel | Commit | Date | Plugins |", "| --- | --- | --- | --- | --- | --- | --- |");
  report.kits.forEach((kit, i) => lines.push(`| K${i + 1} | ${cell(kit.name)} | ${cell(kit.repo)} | ${cell(kit.ref)} | ${kit.sha.slice(0, 7)} | ${kit.date} | ${cell(kit.plugins.map((plugin) => plugin.name).join(", ") || "none")} |`));
  lines.push("", "## 2. Findings", "");
  if (count === 0) lines.push("None.");
  else {
    lines.push("| ID | Kind | Repo | Finding |", "| --- | --- | --- | --- |");
    report.findings.forEach((finding, i) => lines.push(`| F${i + 1} | ${finding.kind} | ${cell(finding.repo)} | ${cell(finding.text)} |`));
  }
  lines.push("", "## 3. Repos", "", "| ID | Repo | Branch | Head | Copies | Marketplaces | Lockfile pins |", "| --- | --- | --- | --- | --- | --- | --- |");
  report.repos.forEach((repo, i) => {
    const markets = repo.marketplaces.map((market) => `${market.name}@${market.ref ?? "HEAD"}${market.onChannel === false ? " (off channel)" : ""}`).join(", ") || "none";
    const pins = repo.pins.map((pin) => `${pin.kit} ${pin.sha.slice(0, 7)} (${pin.state === "current" ? "current" : pin.state === "behind" && pin.behind !== null ? `-${pin.behind}` : pin.state})`).join(", ") || "none";
    lines.push(`| R${i + 1} | ${cell(repo.name)} (${cell(repo.repo)}) | ${cell(repo.branch)} | ${repo.sha.slice(0, 7)} ${repo.date} | ${repo.copies.length} | ${cell(markets)} | ${cell(pins)} |`);
  });
  lines.push("", "## 4. Shared files", "");
  if (report.drift.length === 0) lines.push("No agent-tooling file group is in more than one repo.");
  else {
    lines.push("| ID | Group | Status | Fingerprint per repo |", "| --- | --- | --- | --- |");
    report.drift.forEach((row, i) => lines.push(`| D${i + 1} | ${cell(row.group)} | ${row.status} | ${cell(Object.entries(row.by).map(([name, fp]) => `${name}=${fp}`).join(" "))} |`));
  }
  lines.push("", "Fix a copy or pin in its repo (`kit doctor`, docs/using.md § 3); merge drifting copies or list a group under `ignoreDrift`.");
  return `${lines.join("\n")}\n`;
}

/**
 * Read every kit and repo and build the report.
 * @param {ReturnType<typeof loadFleetList> & { repos: any[] }} list
 * @param {{ client: ReturnType<typeof githubClient>, now?: Date }} options
 */
export async function buildFleetReport(list, { client, now = new Date() }) {
  const work = mkdtempSync(join(tmpdir(), "kit-fleet-"));
  try {
    const errors = [];
    const kits = await loadKits(client, list.kits, work, errors);
    const repos = [];
    const compareCache = new Map();
    for (const [index, entry] of list.repos.entries()) {
      try {
        repos.push(await readRepo(client, entry, kits, work, index, compareCache));
      } catch (error) {
        errors.push({ kind: "unreadable", repo: entry.name, text: `${entry.repo}${entry.branch ? `#${entry.branch}` : ""}: ${error.message}` });
      }
      rmSync(join(work, `repo-${index}`), { recursive: true, force: true });
    }
    const report = {
      date: now.toISOString().slice(0, 10),
      source: "github",
      kits: kits.map(({ plugins, ...kit }) => ({ ...kit, plugins: plugins.map((plugin) => ({ name: plugin.name })) })),
      repos: repos.map(({ files, ...repo }) => ({ ...repo, files: Object.keys(files).length })),
      drift: measureFleetDrift(repos, list.ignoreDrift),
      errors,
    };
    report.findings = collectFindings(report);
    delete report.errors;
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** `kit fleet` arguments; an unknown one is an error. */
export function parseFleetArgs(args) {
  const options = { source: "github", list: null, repos: [], kits: [], out: null, json: false, errors: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const value = () => (inline !== null ? inline : args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[(i += 1)] : null);
    if (flag === "--json") options.json = true;
    else if (["--source", "--list", "--repo", "--kit", "--out"].includes(flag)) {
      const got = value();
      if (got === null) options.errors.push(`${flag} needs a value`);
      else if (flag === "--source") options.source = got;
      else if (flag === "--list") options.list = resolve(got);
      else if (flag === "--repo") options.repos.push(got);
      else if (flag === "--kit") options.kits.push(got);
      else options.out = resolve(got);
    } else options.errors.push(`unknown argument ${arg}`);
  }
  if (options.source !== "github") options.errors.push(`--source ${options.source} is not supported; use --source github`);
  return options;
}

/**
 * `kit fleet --source github --list <file> [--repo [name=]owner/repo[#branch]]... [--kit owner/repo[#ref]]...
 * [--out <dir>] [--json]`. The token comes from KIT_FLEET_TOKEN, GH_TOKEN or GITHUB_TOKEN.
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, print?: (text: string) => void, now?: Date }} [io]
 */
export async function runFleet(args, { env = process.env, fetchImpl = fetch, print = (text) => process.stdout.write(text), now = new Date() } = {}) {
  const options = parseFleetArgs(args);
  const fail = (text) => {
    console.error(`kit fleet: ${text}`);
    return 2;
  };
  if (options.errors.length > 0) return fail(options.errors.join("; "));
  const list = loadFleetList(options);
  if ("error" in list) return fail(list.error);
  const token = env.KIT_FLEET_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) return fail("no token: set KIT_FLEET_TOKEN, GH_TOKEN or GITHUB_TOKEN to a token that can read every listed repo and kit");
  const report = await buildFleetReport(list, { client: githubClient({ token, fetchImpl, api: env.GITHUB_API_URL || "https://api.github.com" }), now });
  const markdown = renderMarkdown(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, "fleet.md"), markdown);
    writeFileSync(join(options.out, "fleet.json"), json);
  }
  print(options.json ? json : markdown);
  if (options.out) console.error(`kit fleet: written to ${join(options.out, "fleet.md")} and ${basename(join(options.out, "fleet.json"))}`);
  return report.findings.length > 0 ? 1 : 0;
}
