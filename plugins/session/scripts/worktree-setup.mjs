import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDirectRun } from "../lib/hook-utils.mjs";
import { readKit } from "./kit-config.mjs";

/**
 * Prepare a fresh git worktree for a writing session:
 *
 *   worktree-setup          # from a Claude Code session (plugin `bin/`); the SessionStart hook
 *                           # `worktree-setup` runs it in every new linked worktree
 *
 * A worktree shares the repository but not its untracked state: no `node_modules`, no codegraph
 * index. This installs dependencies with the package manager the lockfile names (`PACKAGE_MANAGERS`;
 * pnpm's store is shared, so it is fast) and builds the index where the main checkout has one and
 * the tool is installed. RTK trusts filter files by path, so it also
 * trusts this worktree's `.rtk/filters.toml` when the user already trusted the same content
 * elsewhere (the main checkout). A second run does nothing. It never creates a
 * worktree — the user opts into one by starting a worktree session in the desktop app. Every step
 * is optional on this machine: without a lockfile, a `.codegraph/` index in the main checkout, or
 * the package manager / `codegraph` / `rtk` CLIs, the matching step is skipped.
 */

const isWindows = process.platform === "win32";
// `status` is ~0.5 s even on a stale index (it does not sync) and runs after a
// setup of up to 170 s under the hook's 180 s, so a stall prints the path-only line instead.
const STATUS_TIMEOUT_MS = 10_000;

/**
 * The package managers the install step knows, first match wins: the lockfile that names one, the
 * file a finished install leaves in `node_modules` (its mtime against the lockfile's says whether
 * the install is stale), and the command. A worktree with none of these lockfiles installs nothing.
 */
export const PACKAGE_MANAGERS = [
  {
    name: "pnpm",
    lockfile: "pnpm-lock.yaml",
    marker: join("node_modules", ".modules.yaml"),
    args: ["install", "--frozen-lockfile", "--prefer-offline"],
  },
  {
    name: "npm",
    lockfile: "package-lock.json",
    marker: join("node_modules", ".package-lock.json"),
    args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
  },
];

/**
 * The package manager a checkout's lockfile names, or null.
 * @param {string} top @param {(path: string) => boolean} [exists]
 */
export function packageManagerFor(top, exists = existsSync) {
  return PACKAGE_MANAGERS.find((pm) => exists(join(top, pm.lockfile))) ?? null;
}

/**
 * Which steps a worktree needs, from what is on disk. Pure, so the choice can be tested.
 * `hasLockfile` is false when no known lockfile is there; `packageManagerOnPath` false makes the
 * install a hint, as for codegraph (both default to true for callers that predate them).
 * @param {{ linked: boolean, hasLockfile?: boolean, packageManagerOnPath?: boolean, hasNodeModules: boolean, lockfileNewer: boolean, mainHasCodegraph: boolean, hasCodegraph: boolean, codegraphOnPath: boolean, rtkFilters?: RtkFilterState }} facts
 * @returns {("not-linked" | "install" | "install-hint" | "codegraph" | "codegraph-hint" | "rtk-trust" | "rtk-trust-hint")[]}
 */
export function planSetup(facts) {
  const steps = [];
  if (!facts.linked) steps.push("not-linked");
  if (facts.hasLockfile !== false && (!facts.hasNodeModules || facts.lockfileNewer)) {
    steps.push(facts.packageManagerOnPath === false ? "install-hint" : "install");
  }
  if (facts.mainHasCodegraph && !facts.hasCodegraph) steps.push(facts.codegraphOnPath ? "codegraph" : "codegraph-hint");
  if (facts.rtkFilters === "approved") steps.push("rtk-trust");
  if (facts.rtkFilters === "review") steps.push("rtk-trust-hint");
  return steps;
}

/** @typedef {"none" | "trusted" | "approved" | "review"} RtkFilterState */

/**
 * Where a checkout's `.rtk/filters.toml` stands with RTK, from the `rtk trust --list` text. Pure.
 * `approved`: untrusted at this path, but the user trusted these exact bytes at another path, so
 * trusting them here asks nothing new. `rtk trust --yes` also enables a user-global filter file it
 * finds, so `approved` needs that file to hold no filters (or to be trusted already).
 * @param {{ filePath: string, fileSha: string | null, trustList: string, globalFiltersQuiet: boolean }} input
 * @returns {RtkFilterState}
 */
export function rtkFilterState({ filePath, fileSha, trustList, globalFiltersQuiet }) {
  if (!fileSha) return "none";
  const entries = [...trustList.matchAll(/^\s*(\S.*?) \(trusted [^)]*\)\s*\n\s*sha256:([0-9a-f]{64})/gm)];
  if (entries.some(([, path, sha]) => path === filePath && sha === fileSha)) return "trusted";
  if (globalFiltersQuiet && entries.some(([, , sha]) => sha === fileSha)) return "approved";
  return "review";
}

/** A filter file with no `[filters.*]` table: RTK's own template, or absent. */
function holdsNoFilters(path) {
  return !existsSync(path) || !/^\s*\[filters\./m.test(readFileSync(path, "utf8"));
}

/** @param {string} top */
export function readRtkFilterState(top) {
  const filePath = join(top, ".rtk", "filters.toml");
  if (!existsSync(filePath) || !onPath("rtk")) return "none";
  const fileSha = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  // rtk ships as a native binary on every OS, so no `.cmd` shell detour as for pnpm and codegraph.
  const trustList = spawnSync("rtk", ["trust", "--list"], { cwd: top, encoding: "utf8" }).stdout ?? "";
  const configDir = /^Config: (.+)[\\/]config\.toml$/m.exec(
    spawnSync("rtk", ["config"], { encoding: "utf8" }).stdout ?? "",
  )?.[1];
  const globalPath = configDir ? join(configDir, "filters.toml") : null;
  const globalFiltersQuiet = globalPath !== null && (holdsNoFilters(globalPath) || trustList.includes(globalPath));
  return rtkFilterState({ filePath, fileSha, trustList, globalFiltersQuiet });
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * pnpm, npm and codegraph are `.cmd` shims on Windows, which Node spawns only through a shell; an args
 * array with `shell: true` is deprecated (DEP0190), so Windows gets one joined string. Safe: every
 * argument here is a literal.
 */
function run(command, args, cwd) {
  console.log(`worktree-setup: ${command} ${args.join(" ")}`);
  const result = isWindows
    ? spawnSync([command, ...args].join(" "), { cwd, stdio: "inherit", shell: true })
    : spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`worktree-setup: ${command} failed (exit ${result.status})`);
    process.exit(1);
  }
}

/**
 * The text of `codegraph status` for the checkout at `top`, or null when the command fails or is
 * missing. Read by the SessionStart hook for its one-line summary of the index a session reads;
 * ~0.3–0.5 s on a synced index. Windows spawns the `.cmd` shim through a shell, as `run` does.
 * @param {string} top
 * @returns {string | null}
 */
export function codegraphStatus(top) {
  const result = isWindows
    ? spawnSync("codegraph status", { cwd: top, encoding: "utf8", shell: true, timeout: STATUS_TIMEOUT_MS })
    : spawnSync("codegraph", ["status"], { cwd: top, encoding: "utf8", timeout: STATUS_TIMEOUT_MS });
  return result.status === 0 ? result.stdout : null;
}

function onPath(command) {
  return spawnSync(isWindows ? "where" : "which", [command], { encoding: "utf8" }).status === 0;
}

/**
 * What is on disk for the checkout containing `cwd`, as `planSetup` expects; null outside git.
 * @param {string} cwd
 */
export function readFacts(cwd) {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (!top) return null;
  const gitDir = resolve(top, git(["rev-parse", "--git-dir"], top) ?? ".git");
  const commonDir = resolve(top, git(["rev-parse", "--git-common-dir"], top) ?? ".git");
  // The first entry of `git worktree list` is the main checkout, wherever its git dir lives.
  const listed = git(["worktree", "list", "--porcelain"], top) ?? "";
  const mainCheckout = listed.match(/^worktree (.+)$/m)?.[1] ?? dirname(commonDir);
  const pm = packageManagerFor(top);
  const modulesMarker = pm ? join(top, pm.marker) : join(top, "node_modules");
  const lockfile = pm ? join(top, pm.lockfile) : "";
  const facts = {
    linked: gitDir !== commonDir,
    hasLockfile: pm !== null,
    packageManager: pm?.name ?? null,
    packageManagerOnPath: pm ? onPath(pm.name) : false,
    hasNodeModules: existsSync(modulesMarker),
    lockfileNewer:
      existsSync(modulesMarker) && existsSync(lockfile) && statSync(lockfile).mtimeMs > statSync(modulesMarker).mtimeMs,
    // The index file, not the folder: a stub `.codegraph/` without it answers from the main checkout.
    mainHasCodegraph: existsSync(join(mainCheckout, ".codegraph", "codegraph.db")),
    hasCodegraph: existsSync(join(top, ".codegraph", "codegraph.db")),
    codegraphOnPath: onPath("codegraph"),
    rtkFilters: readRtkFilterState(top),
  };
  return { top, commonDir, facts };
}

/**
 * The closing line: where the dev server runs, from `kit.json` `devServer.port` when set. Pure.
 * @param {{ devServer: { port?: number } | null }} kit
 */
export function doneLine(kit) {
  const port = kit.devServer?.port;
  return port
    ? `worktree-setup: done. Dev server: port ${port} is fixed (kit.json devServer.port); stop the one in another checkout before starting one here.`
    : "worktree-setup: done.";
}

function main() {
  const read = readFacts(process.cwd());
  if (!read) {
    console.error("worktree-setup: not inside a git repository");
    process.exit(1);
  }
  const { top, facts } = read;
  const steps = planSetup(facts);
  for (const step of steps) {
    if (step === "not-linked") console.log("worktree-setup: this is the main checkout, not a linked worktree");
    if (step === "install") {
      const pm = packageManagerFor(top);
      if (pm) run(pm.name, pm.args, top);
    }
    if (step === "install-hint") {
      console.log(`worktree-setup: ${facts.packageManager} is not installed here; dependencies were not installed`);
    }
    // A desktop-app worktree sits inside the main checkout, so plain `init` finds the main index up
    // the tree and writes only a stub; `-i` builds a worktree-local one (codegraph's own advice).
    if (step === "codegraph") run("codegraph", ["init", "-i", "-y", "."], top);
    if (step === "codegraph-hint") {
      console.log("worktree-setup: codegraph is not installed here; the session will skip it");
    }
    if (step === "rtk-trust") run("rtk", ["trust", "--yes"], top);
    if (step === "rtk-trust-hint") {
      console.log("worktree-setup: RTK skips .rtk/filters.toml until you review it and run `rtk trust` here");
    }
  }
  if (steps.every((step) => step === "not-linked")) console.log("worktree-setup: already set up, nothing to do");
  console.log(doneLine(readKit(top)));
}

if (isDirectRun(import.meta.url)) main();
