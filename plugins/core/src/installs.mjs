// `kit installs`: the project- and local-scope copies of kit-style plugins on this machine, and
// clearing the stale ones.
//
// The kit is installed at user scope only; a project enables its plugins in `.claude/settings.json`
// and installs nothing. Claude Code still writes a project-scope install record per folder (each
// worktree too), at the version the session there loaded, and the first matching record in
// `installed_plugins.json` is the copy that runs (docs/spikes.md S11). `claude plugin update` without
// `--scope` updates one of those records, and `--scope project` the first one of the repository,
// not necessarily the current folder's, so a project copy can lag unseen or shadow the user copy.
//
// The only CLI way to drop one record is `claude plugin uninstall <id> --scope project` run from
// that record's folder, which also removes the plugin from that folder's `.claude/settings.json`.
// `--clean` runs it per stale copy and puts both settings files back byte for byte; for a folder
// that no longer exists it creates the folder for the call and removes it again.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  channelResolver,
  claudeDir,
  defaultCacheFile,
  isCommitVersioned,
  loadedRecord,
  readPluginState,
  repoRoot,
  splitId,
} from "./update-check.mjs";

const short = (sha) => (typeof sha === "string" ? sha.slice(0, 12) : "none");

/** `path` with the home folder written as `~`, for reports. */
export function tilde(path) {
  const home = homedir();
  return typeof path === "string" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/**
 * Every project- or local-scope record of a kit-style plugin, against the plugin's user-scope copy
 * and, when `channels` is given, its channel's commit. A copy is `stale` when it differs from the
 * user copy or from the channel. `loads` says that sessions in its repository load this copy, not
 * the user one (S11). `blocked` says why `--clean` leaves it: no user copy to fall back to, or a
 * user copy that itself lags the channel.
 * @param {{ state?: ReturnType<typeof readPluginState>, channels?: ReturnType<typeof channelResolver> | null }} [options]
 * @returns {Copy[]}
 * @typedef {{ id: string, plugin: string, marketplace: string, scope: string, projectPath: string, exists: boolean, repo: string | null, installed: string, user: string | null, latest: string | null, ref: string | null, loads: boolean, stale: boolean, blocked: string | null }} Copy
 */
export function surveyInstalls({ state = readPluginState(), channels = null } = {}) {
  const keys = new Map();
  const copies = [];
  for (const [id, entries] of Object.entries(state.installed)) {
    const name = splitId(id);
    if (!name || !Array.isArray(entries)) continue;
    const scoped = entries.filter((entry) => (entry.scope === "project" || entry.scope === "local") && typeof entry.projectPath === "string" && isCommitVersioned(entry));
    if (scoped.length === 0) continue;
    const user = entries.find((entry) => entry.scope === "user");
    const userSha = typeof user?.gitCommitSha === "string" ? user.gitCommitSha : null;
    const channel = channels?.channel(name.marketplace, name.plugin) ?? null;
    const latest = channel?.latest ?? null;
    for (const entry of scoped) {
      const installed = entry.gitCommitSha;
      const stale = (userSha !== null && installed !== userSha) || (latest !== null && installed !== latest);
      let blocked = null;
      if (userSha === null) blocked = `no user-scope copy to fall back to; run \`claude plugin install ${id} --scope user\` first`;
      else if (latest !== null && userSha !== latest) blocked = `the user copy (${short(userSha)}) lags ${channel?.ref} (${short(latest)}); run \`claude plugin update ${id} --scope user\` first`;
      copies.push({
        id,
        ...name,
        scope: entry.scope,
        projectPath: entry.projectPath,
        exists: existsSync(entry.projectPath),
        repo: repoRoot(entry.projectPath),
        installed,
        user: userSha,
        latest,
        ref: channel?.ref ?? null,
        loads: loadedRecord(entries, entry.projectPath, keys) === entry,
        stale,
        blocked,
      });
    }
  }
  return copies;
}

/** Runs the `claude` CLI in `cwd`; `ok` and the last output line. */
function runClaude(args, cwd) {
  const result = spawnSync("claude", args, { cwd, encoding: "utf8", timeout: 120_000 });
  const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").map((line) => line.trim()).filter(Boolean);
  return { ok: result.status === 0, output: lines.at(-1) ?? (result.error ? String(result.error.message) : "") };
}

/** The topmost folder of `dir` that does not exist yet, or null when `dir` exists. */
function firstMissing(dir) {
  if (existsSync(dir)) return null;
  let top = dir;
  while (!existsSync(dirname(top)) && dirname(top) !== top) top = dirname(top);
  return top;
}

/**
 * Uninstall one project- or local-scope copy from its folder, leaving that folder's settings files
 * exactly as they were (the uninstall drops the plugin from them).
 * @param {Pick<Copy, "id" | "scope" | "projectPath">} copy
 * @param {(args: string[], cwd: string) => { ok: boolean, output: string }} [run]
 */
export function uninstallCopy(copy, run = runClaude) {
  const dir = copy.projectPath;
  const created = firstMissing(dir);
  if (created) mkdirSync(dir, { recursive: true });
  const claudeFolder = join(dir, ".claude");
  const hadClaudeFolder = existsSync(claudeFolder);
  const files = ["settings.json", "settings.local.json"].map((name) => join(claudeFolder, name));
  const before = files.map((file) => (existsSync(file) ? readFileSync(file) : null));
  try {
    return run(["plugin", "uninstall", copy.id, "--scope", copy.scope], dir);
  } finally {
    files.forEach((file, index) => {
      if (before[index] !== null) writeFileSync(file, before[index]);
      else if (existsSync(file)) rmSync(file);
    });
    if (created) rmSync(created, { recursive: true, force: true });
    else if (!hadClaudeFolder && existsSync(claudeFolder) && readdirSync(claudeFolder).length === 0) rmdirSync(claudeFolder);
  }
}

/**
 * `kit installs [--clean] [--offline]`: list the stale project- and local-scope copies (current
 * ones are only counted), and with `--clean` uninstall each one that is not blocked.
 * @param {string[]} args
 * @param {{ print?: (line: string) => void, state?: ReturnType<typeof readPluginState>, resolveSha?: (remote: {url: string, ref: string}) => string | null, run?: Parameters<typeof uninstallCopy>[1] }} [options]
 */
export function runInstalls(args, { print = console.log, state = readPluginState(), resolveSha, run } = {}) {
  const offline = args.includes("--offline");
  const clean = args.includes("--clean");
  const channels = channelResolver({ state, cacheFile: offline ? null : defaultCacheFile(), fresh: true, resolveSha: offline ? () => null : resolveSha });
  const copies = surveyInstalls({ state, channels });
  channels.save();
  print(`Project- and local-scope copies of kit plugins (${tilde(join(claudeDir(), "plugins", "installed_plugins.json"))}):`);
  const stale = copies.filter((copy) => copy.stale);
  if (stale.length === 0) {
    print(`None is stale (${copies.length} current). Nothing to clear.`);
    return 0;
  }
  const ids = [...new Set(stale.map((copy) => copy.id))].sort();
  ids.forEach((id, i) => {
    const group = stale.filter((copy) => copy.id === id);
    const { user, latest, ref } = group[0];
    print(`${i + 1}. ${id}: user copy ${short(user)}${latest ? `, ${ref} is ${short(latest)}` : offline ? "" : ", channel not read"}`);
    group.forEach((copy, n) => {
      const notes = [copy.exists ? null : "folder gone", copy.loads ? "loaded instead of the user copy" : null, copy.blocked ? `left: ${copy.blocked}` : null].filter(Boolean);
      print(`   ${i + 1}.${n + 1}. ${copy.scope} ${tilde(copy.projectPath)}: ${short(copy.installed)}${notes.length ? ` (${notes.join("; ")})` : ""}`);
    });
  });
  const current = copies.length - stale.length;
  const channelRead = copies.some((copy) => copy.latest !== null);
  if (current > 0) print(`${current} other copies match the user copy${channelRead ? " and the channel" : ""}; left alone.`);
  if (!clean) {
    print("");
    print("`kit installs --clean` uninstalls the stale copies that are not marked `left`; each folder's .claude settings files stay as they were (docs/using.md § 3).");
    return 0;
  }
  let failed = 0;
  for (const copy of stale.filter((item) => !item.blocked)) {
    const result = uninstallCopy(copy, run);
    if (!result.ok) failed += 1;
    print(`${result.ok ? "cleared" : "FAILED "} ${copy.id} ${copy.scope} ${tilde(copy.projectPath)}: ${result.output}`);
  }
  print("");
  print("Start a new session to load the user copy. Claude Code writes a fresh project-scope record per folder again, at the version it loads (S11).");
  return failed > 0 ? 1 : 0;
}
