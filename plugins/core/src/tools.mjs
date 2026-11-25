// `kit tools`: install the machine tools the kit's hooks use (rtk, CodeGraph, Fallow) at the pins in
// ../tools.json, set them up, and clear what earlier installs left behind.
//
// Every tool is optional: each hook that uses one skips quietly without it. So `kit tools` asks
// before each install, Y by default (`--yes` answers for all), and in a shell with no terminal it
// only prints the plan. Where a tool has a GitHub release asset for this OS (rtk), the asset is
// downloaded, its sha256 checked against the release's checksums file, unpacked with `tar` (bsdtar
// reads zip on Windows 10+ and macOS) and put on PATH; otherwise its package command runs
// (`npm install -g`). After installing it clears `.old`/`.bak` files beside each tool, uninstalls
// copies off the pin that a package manager owns once a pinned copy is on PATH, and checks that
// the shell now runs the pinned copy, and turns off rtk's "No hook installed" warning while core's
// rtk-rewrite hook runs RTK's hook. Last it offers `codegraph init` for the current repo
// (indexing is the user's call: asked even under --yes, unless --index).
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { HOOK_ID as RTK_HOOK_ID } from "../hooks/rtk-rewrite.mjs";
import { hookOff, readKit } from "../lib/kit-config.mjs";
import { runInstalls } from "./installs.mjs";
import { defaultCacheFile } from "./update-check.mjs";

export const TOOLS_FILE = fileURLToPath(new URL("../tools.json", import.meta.url));
export const TOOLS_COMMAND = "kit tools";

/**
 * @typedef {{ repo: string; tag: string; checksums: string; binary: string; assets: Record<string, string> }} ReleaseSpec
 * @typedef {{ pin: string; command: string[]; why: string; release?: ReleaseSpec; install?: string; package?: string; manual?: string; knownIssues?: string[] }} ToolSpec
 * @typedef {{ found: boolean; version: string | null }} Probe
 * @typedef {{ name: string; action: "keep" | "release" | "install" | "manual"; now: string; pin: string; detail: string }} ToolStep
 */

/** @returns {Record<string, ToolSpec>} */
export function readTools(file = TOOLS_FILE) {
  return JSON.parse(readFileSync(file, "utf8")).tools;
}

/** `~` or `~/…` to the home folder. @param {string} path */
export function expandHome(path) {
  if (path === "~") return homedir();
  return path.startsWith("~/") || path.startsWith(`~${sep}`) ? join(homedir(), path.slice(2)) : path;
}

/** Dotted versions compared numerically; missing parts count as zero. Pure. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The release asset for a tool's pin on `platform`/`arch`, or null when it has none. Pure.
 * @param {ToolSpec} spec @param {string} [platform] @param {string} [arch]
 */
export function releaseAsset(spec, platform = process.platform, arch = process.arch) {
  const asset = spec.release?.assets[`${platform}-${arch}`];
  if (!spec.release || !asset) return null;
  const base = `https://github.com/${spec.release.repo}/releases/download/${spec.release.tag.replaceAll("{pin}", spec.pin)}`;
  return {
    asset,
    url: `${base}/${asset}`,
    checksumsUrl: `${base}/${spec.release.checksums}`,
    binary: platform === "win32" ? `${spec.release.binary}.exe` : spec.release.binary,
  };
}

/** `sha256  name` lines of a checksums file, by asset name. Pure. @param {string} text */
export function parseChecksums(text) {
  /** @type {Map<string, string>} */
  const sums = new Map();
  for (const match of text.matchAll(/^([0-9a-f]{64})\s+\*?(\S+)\s*$/gim)) sums.set(match[2], match[1].toLowerCase());
  return sums;
}

/**
 * Every copy of `name` on PATH, in the order the shell tries them. On Windows each entry is tried
 * with each PATHEXT suffix (what cmd and PowerShell run), then the extensionless sh shim npm and
 * pnpm also write. Pure apart from `exists`.
 * @param {string} name
 * @param {{ pathValue?: string; platform?: string; pathExt?: string; exists?: (file: string) => boolean }} [options]
 */
export function findOnPath(name, options = {}) {
  const windows = (options.platform ?? process.platform) === "win32";
  const pathValue = options.pathValue ?? process.env.PATH ?? process.env.Path ?? "";
  const exists = options.exists ?? existsSync;
  const suffixes = windows ? [...(options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""] : [""];
  /** @type {string[]} */
  const found = [];
  const seen = new Set();
  for (const dir of pathValue.split(windows ? ";" : ":").filter(Boolean)) {
    const key = windows ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = windows ? `${dir.replace(/[\\/]+$/, "")}\\${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
    const hit = suffixes.map((suffix) => base + suffix).find((file) => exists(file));
    if (hit) found.push(hit);
  }
  return found;
}

/**
 * The package-manager command that removes the copy of a tool at `binaryPath`, or null for a
 * plain file no package manager owns. Pure.
 * @param {string} binaryPath @param {string} name @param {ToolSpec} spec
 * @returns {{ command: string; fromHome: boolean } | null}
 */
export function uninstallCommand(binaryPath, name, spec) {
  const at = binaryPath.replaceAll("\\", "/").toLowerCase();
  const pkg = spec.package ?? name;
  // pnpm's global folder: run from the home folder, so a repo's packageManager pin cannot switch
  // pnpm to a major that keeps its globals elsewhere.
  if (/\/pnpm\//.test(at)) return { command: `pnpm remove -g ${pkg}`, fromHome: true };
  if (/\/appdata\/roaming\/npm\//.test(at) || /\/lib\/node_modules\//.test(at) || /\/\.npm-global\//.test(at)) return { command: `npm uninstall -g ${pkg}`, fromHome: false };
  if (/\/\.cargo\/bin\//.test(at)) return { command: `cargo uninstall ${name}`, fromHome: false };
  if (/^\/opt\/homebrew\//.test(at) || /\/cellar\//.test(at) || /^\/home\/linuxbrew\//.test(at)) return { command: `brew uninstall ${name}`, fromHome: false };
  if (/\/scoop\/shims\//.test(at)) return { command: `scoop uninstall ${name}`, fromHome: false };
  return null;
}

/** How to remove a copy: its package command, or "delete <path>". Pure. @param {string} binaryPath @param {string} name @param {ToolSpec} spec */
export function uninstallHint(binaryPath, name, spec) {
  const command = uninstallCommand(binaryPath, name, spec);
  if (!command) return `delete ${binaryPath}`;
  return command.fromHome ? `${command.command} (run it from your home folder)` : command.command;
}

/**
 * The copies off the pin, once some copy on PATH is at it; none while no copy is, so a failed
 * install never loses the only working copy. Pure.
 * @param {ToolSpec} spec @param {{ path: string; version: string | null }[]} copies in PATH order
 */
export function staleCopies(spec, copies) {
  const atPin = (/** @type {{ version: string | null }} */ copy) => copy.version !== null && compareVersions(copy.version, spec.pin) === 0;
  if (!copies.some(atPin)) return [];
  return copies.filter((copy) => !atPin(copy));
}

/**
 * Files an install left beside a binary: the `.old` copy a swap moved aside and hand-made backups.
 * Only names that start with the binary's name, then `.` or `-`, and end in `.old` or `.bak`. Pure.
 * @param {string[]} names @param {string} binary
 */
export function leftoverFiles(names, binary) {
  const prefix = binary.toLowerCase();
  return names.filter((name) => {
    const lower = name.toLowerCase();
    return (lower.endsWith(".old") || lower.endsWith(".bak")) && (lower.startsWith(`${prefix}.`) || lower.startsWith(`${prefix}-`));
  });
}

/**
 * When the copy the shell runs is off the pin and a later PATH copy is at it: the install landed
 * behind an older copy. Pure.
 * @param {string} name @param {ToolSpec} spec @param {{ path: string; version: string | null }[]} copies
 */
export function shadowedVerdict(name, spec, copies) {
  const [first, ...rest] = copies;
  if (!first || (first.version && compareVersions(first.version, spec.pin) === 0)) return null;
  const good = rest.find((copy) => copy.version && compareVersions(copy.version, spec.pin) === 0);
  if (!good) return null;
  return {
    message: `${first.path} (${first.version ?? "unknown version"}) comes first on PATH and hides ${good.path} (${good.version})`,
    fix: uninstallHint(first.path, name, spec),
  };
}

/** The tool's version banner, or not found. `.cmd` shims need a shell on Windows. @param {string[]} command @returns {Probe} */
export function probeVersion(command) {
  const [binary, ...args] = command;
  try {
    const raw =
      process.platform === "win32"
        ? execSync([binary, ...args].join(" "), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 })
        : execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    return { found: true, version: raw.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null };
  } catch {
    return { found: false, version: null };
  }
}

/** Probe one copy by path. @param {string} path @param {string[]} command */
function probeCopy(path, command) {
  return probeVersion([process.platform === "win32" ? `"${path}"` : path, ...command.slice(1)]);
}

/**
 * What each tool needs: keep (at its pin), a release download, its package command, or a manual
 * step. Pure apart from `probe`.
 * @param {Record<string, ToolSpec>} tools @param {(command: string[]) => Probe} probe
 * @param {string} [platform] @param {string} [arch]
 * @returns {ToolStep[]}
 */
export function planTools(tools, probe, platform = process.platform, arch = process.arch) {
  return Object.entries(tools).map(([name, spec]) => {
    const { found, version } = probe(spec.command);
    const now = found ? (version ?? "unknown version") : "missing";
    const pin = spec.pin;
    if (found && version && compareVersions(version, pin) === 0) return { name, action: "keep", now, pin, detail: `${version} is the pin` };
    const release = releaseAsset(spec, platform, arch);
    if (release) return { name, action: "release", now, pin, detail: `${now} -> ${pin}: download ${release.asset}, sha256-checked` };
    if (spec.install) return { name, action: "install", now, pin, detail: `${now} -> ${pin}: ${spec.install.replaceAll("{pin}", pin)}` };
    return { name, action: "manual", now, pin, detail: `${now} -> ${pin}: ${(spec.manual ?? "no install recipe").replaceAll("{pin}", pin)}` };
  });
}

/**
 * The one-line note for the session start: the tools that are missing or off their pin, and the
 * command that installs them; "" when all are at their pins. Pure.
 * @param {ToolStep[]} steps
 */
export function toolsNote(steps) {
  const off = steps.filter((step) => step.action !== "keep");
  if (off.length === 0) return "";
  const list = off.map((step) => `${step.name} (${step.now === "missing" ? "missing" : `${step.now}, pin ${step.pin}`})`).join(", ");
  return `## agent-kit tools\n\nOff the kit's pins: ${list}. Offer \`/core:kit-tools\` once; kit.json \`hooks.off: ["tools-check"]\` silences it.`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `toolsNote` for the session start, probed at most once a day: three version probes cost up to a
 * second on Windows. The cache is keyed by the pins, so a kit update that moves one probes again,
 * and `kit tools` drops it after installing.
 * @param {{ cacheFile: string | null; tools?: Record<string, ToolSpec>; probe?: (command: string[]) => Probe; now?: number }} options
 */
export function cachedToolsNote({ cacheFile, tools = readTools(), probe = probeVersion, now = Date.now() }) {
  const key = JSON.stringify(Object.entries(tools).map(([name, spec]) => [name, spec.pin]));
  if (cacheFile) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (cached.key === key && now - cached.at < DAY_MS && typeof cached.note === "string") return cached.note;
    } catch {
      // no cache yet, or a broken one: probe
    }
  }
  const note = toolsNote(planTools(tools, probe));
  if (cacheFile) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ key, at: now, note }));
    } catch {
      // a read-only data folder only costs the next session another probe
    }
  }
  return note;
}

/** Where the session-start note is cached: beside the update check's cache, or null. @param {string | null} updateCacheFile */
export function toolsCacheFile(updateCacheFile) {
  return updateCacheFile ? join(dirname(updateCacheFile), "tools-check.json") : null;
}

/** @typedef {{ yes: boolean; check: boolean; dryRun: boolean; index: boolean | null; only: string[] | null; help?: boolean; error?: string }} ToolsOptions */

export const TOOLS_USAGE = `Usage: kit tools [--yes] [--check] [--dry-run] [--only rtk,codegraph] [--index | --no-index]

Install rtk, CodeGraph and Fallow at the kit's pins, asking before each (Y by default; --yes for
all), clear old copies of them and stale plugin copies, and offer codegraph init for the repo.
--check only reports tools off their pin; --dry-run prints the plan and changes nothing.`;

/** @param {string[]} args @returns {ToolsOptions} */
export function parseToolsArgs(args) {
  /** @type {ToolsOptions} */
  const options = { yes: false, check: false, dryRun: false, index: null, only: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--index") options.index = true;
    else if (arg === "--no-index") options.index = false;
    else if (arg === "--only") {
      const value = args[++i];
      if (!value) return { ...options, error: "--only needs a list such as rtk,codegraph" };
      options.only = value.split(",").map((name) => name.trim()).filter(Boolean);
    } else return { ...options, error: `unknown option ${arg}` };
  }
  return options;
}

/**
 * Ask a yes/no question with Y as the default, on a terminal only.
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function askYes(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * `kit tools [--yes] [--check] [--dry-run] [--only a,b] [--index | --no-index]`.
 * @param {string[]} args
 * @param {{ root?: string | null; tools?: Record<string, ToolSpec>; interactive?: boolean; ask?: (q: string) => Promise<boolean>; print?: (line: string) => void }} [deps]
 * @returns {Promise<number>}
 */
export async function runTools(args, deps = {}) {
  const options = parseToolsArgs(args);
  const print = deps.print ?? console.log;
  if (options.error) {
    console.error(`kit tools: ${options.error}\n\n${TOOLS_USAGE}`);
    return 1;
  }
  if (options.help) {
    print(TOOLS_USAGE);
    return 0;
  }
  const all = deps.tools ?? readTools();
  const unknown = (options.only ?? []).filter((name) => !Object.hasOwn(all, name));
  if (unknown.length > 0) {
    console.error(`kit tools: no tool named ${unknown.join(", ")} (known: ${Object.keys(all).join(", ")})`);
    return 1;
  }
  const tools = Object.fromEntries(Object.entries(all).filter(([name]) => !options.only || options.only.includes(name)));
  const steps = planTools(tools, probeVersion);

  if (options.check) {
    const off = steps.filter((step) => step.action !== "keep");
    for (const step of off) print(`kit tools: ${step.name} ${step.now} -> ${step.pin}`);
    if (off.length > 0) print(`kit tools: run \`${TOOLS_COMMAND}\` to install the pinned versions`);
    return 0;
  }

  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ask = deps.ask ?? askYes;
  print(`kit tools · ${process.platform}-${process.arch}${options.dryRun ? " · dry run" : ""}`);
  for (const step of steps) print(`  ${step.action.padEnd(7)} ${step.name} — ${step.detail}`);
  const wanted = steps.filter((step) => step.action === "release" || step.action === "install");
  if (!options.dryRun && !options.yes && !interactive && wanted.length > 0) {
    print(`No terminal to ask on: run \`${TOOLS_COMMAND} --yes\` (or \`--only ${wanted.map((s) => s.name).join(",")} --yes\`) to install.`);
    return 0;
  }

  let failed = 0;
  /** @type {string[]} */
  const touched = [];
  if (!options.dryRun) {
    for (const step of wanted) {
      const spec = tools[step.name];
      if (!options.yes && !(await ask(`Install ${step.name} ${spec.pin}? (${spec.why})`))) {
        print(`  skip    ${step.name}`);
        continue;
      }
      const ok = step.action === "release" ? await installRelease(step.name, spec, print) : runCommand(spec.install?.replaceAll("{pin}", spec.pin) ?? "", false);
      if (ok) touched.push(step.name);
      else {
        console.error(`  failed  ${step.name}`);
        for (const issue of spec.knownIssues ?? []) console.error(`          ${issue}`);
        failed++;
      }
    }
  }
  for (const [name, spec] of Object.entries(tools)) cleanupTool(name, spec, options.dryRun, print);
  if (!options.dryRun) for (const name of touched) if (!verifyTool(name, tools[name], print)) failed++;
  if (Object.hasOwn(tools, "rtk")) silenceRtkHookWarning(deps.root ?? null, options.dryRun, print);
  if (!options.only) runInstalls(options.dryRun ? [] : ["--clean"], { print: (line) => print(`  plugins ${line}`) });
  if (!options.dryRun) {
    await offerIndex(deps.root ?? null, options, interactive, ask, print);
    const cache = toolsCacheFile(defaultCacheFile());
    if (cache) rmSync(cache, { force: true });
  }
  return failed > 0 ? 1 : 0;
}

/** The rtk setting that stops its "No hook installed" warning, under `[hooks]` in its config.toml. */
export const RTK_HOOK_WARNING_LINE = "suppress_hook_warning = true";

/**
 * rtk's config text with `[hooks] suppress_hook_warning = true`, or null when it already says so.
 * Changes only that key: sets it in an existing `[hooks]` table, else adds the table at the end.
 * Pure. @param {string} text
 */
export function withHookWarningOff(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let section = null;
  let hooksAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) {
      section = header[1];
      if (section === "hooks" && hooksAt < 0) hooksAt = i;
      continue;
    }
    if (section !== "hooks" || !/^\s*suppress_hook_warning\s*=/.test(lines[i])) continue;
    if (/^\s*suppress_hook_warning\s*=\s*true\s*(#.*)?$/.test(lines[i])) return null;
    lines[i] = RTK_HOOK_WARNING_LINE;
    return lines.join(eol);
  }
  if (hooksAt >= 0) {
    lines.splice(hooksAt + 1, 0, RTK_HOOK_WARNING_LINE);
    return lines.join(eol);
  }
  const body = text === "" || text.endsWith("\n") ? text : `${text}${eol}`;
  return `${body}${body ? eol : ""}[hooks]${eol}${RTK_HOOK_WARNING_LINE}${eol}`;
}

/** The config file `rtk config` names (`Config: <path>`), or null. */
function rtkConfigFile() {
  const result = spawnSync("rtk", ["config"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.match(/^Config:\s*(.+?)\s*$/m)?.[1] ?? null;
}

/**
 * Core's `rtk-rewrite` hook runs RTK's hook once the user deletes `rtk hook claude` from their
 * settings, after which rtk warns on every command that no hook is installed (and `rtk init -g`
 * would write the old Bash-only entry back). So, with that duty on and rtk on PATH, set rtk's own
 * switch for the warning, or name the line to add when the config file cannot be found or written.
 * @param {string | null} root @param {boolean} dryRun @param {(line: string) => void} print
 */
function silenceRtkHookWarning(root, dryRun, print) {
  if (root && hookOff(RTK_HOOK_ID, readKit(root))) return;
  if (!probeVersion(["rtk", "--version"]).found) return;
  const by = `add \`${RTK_HOOK_WARNING_LINE}\` under \`[hooks]\` in rtk's config.toml (\`rtk config\` names it)`;
  const file = rtkConfigFile();
  if (!file) return print(`  rtk     ${by}, so rtk stops warning that no hook is installed`);
  let text = "";
  try {
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch (error) {
    return print(`  rtk     cannot read ${file} (${error.message}); ${by}`);
  }
  const next = withHookWarningOff(text);
  if (next === null) return;
  if (dryRun) return print(`  rtk     would set [hooks] ${RTK_HOOK_WARNING_LINE} in ${file}`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
    print(`  rtk     set [hooks] ${RTK_HOOK_WARNING_LINE} in ${file}: core runs RTK's hook, so rtk need not warn that none is installed`);
  } catch (error) {
    print(`  rtk     cannot write ${file} (${error.message}); ${by}`);
  }
}

/**
 * Offer `codegraph init` for the current repo when CodeGraph runs here and the repo has no index.
 * @param {string | null} root @param {ToolsOptions} options @param {boolean} interactive
 * @param {(q: string) => Promise<boolean>} ask @param {(line: string) => void} print
 */
async function offerIndex(root, options, interactive, ask, print) {
  if (!root || options.index === false || existsSync(join(root, ".codegraph"))) return;
  if (!probeVersion(["codegraph", "--version"]).found) return;
  const yes = options.index === true || (interactive && (await ask(`Index this repo with CodeGraph (codegraph init in ${root})?`)));
  if (!yes) {
    if (!interactive && options.index === null) print(`  codegraph: this repo has no index; \`${TOOLS_COMMAND} --index\` (or \`codegraph init\`) builds one.`);
    return;
  }
  print(`  index   codegraph init`);
  if (!runCommand("codegraph init", false, root)) console.error("          codegraph init failed; run it by hand");
}

/** Run a command line through the shell; true on exit 0. @param {string} command @param {boolean} fromHome @param {string} [cwd] */
function runCommand(command, fromHome, cwd) {
  if (!command) return false;
  return spawnSync(command, { stdio: "inherit", shell: true, cwd: fromHome ? homedir() : cwd }).status === 0;
}

/**
 * Clear what earlier installs left: `.old`/`.bak` files beside each copy (and in ~/.local/bin),
 * then each copy off the pin that a package manager owns, once a pinned copy is on PATH. A plain
 * file the kit did not put there, or a package command that would also remove the pinned copy,
 * is only named.
 * @param {string} name @param {ToolSpec} spec @param {boolean} dryRun @param {(line: string) => void} print
 */
function cleanupTool(name, spec, dryRun, print) {
  const binary = spec.command[0];
  const onPath = findOnPath(binary);
  for (const dir of new Set([...onPath.map((path) => dirname(path)), expandHome("~/.local/bin")])) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of leftoverFiles(names, binary)) {
      const path = join(dir, file);
      if (dryRun) {
        print(`  plan    ${name} — remove ${path}`);
        continue;
      }
      try {
        rmSync(path, { force: true });
        print(`  clean   ${name} — removed ${path}`);
      } catch {
        print(`  clean   ${name} — ${path} is still in use; the next run removes it`);
      }
    }
  }
  const copies = onPath.map((path) => ({ path, version: probeCopy(path, spec.command).version }));
  const stale = staleCopies(spec, copies);
  if (stale.length === 0) return;
  const pinned = copies.find((copy) => !stale.includes(copy));
  const pinnedCommand = pinned ? uninstallCommand(pinned.path, name, spec)?.command : undefined;
  for (const copy of stale) {
    const command = uninstallCommand(copy.path, name, spec);
    const label = `${copy.path} (${copy.version ?? "unknown version"})`;
    if (!command || command.command === pinnedCommand) {
      print(`  stale   ${name} — ${label}; remove it: ${uninstallHint(copy.path, name, spec)}`);
    } else if (dryRun) {
      print(`  plan    ${name} — remove ${label}: ${command.command}`);
    } else {
      print(`  clean   ${name} — removing ${label}: ${command.command}`);
      if (!runCommand(command.command, command.fromHome)) console.error("          failed; run it by hand");
    }
  }
}

/** After an install the shell must run the pinned copy; else name the copy in front. @param {string} name @param {ToolSpec} spec @param {(line: string) => void} print */
function verifyTool(name, spec, print) {
  const { version } = probeVersion(spec.command);
  if (version && compareVersions(version, spec.pin) === 0) {
    print(`  ok      ${name} — ${version}`);
    return true;
  }
  const copies = findOnPath(spec.command[0]).map((path) => ({ path, version: probeCopy(path, spec.command).version }));
  const shadow = shadowedVerdict(name, spec, copies);
  console.error(`  FAIL    ${name} — the shell still runs ${version ?? "no version"}, not ${spec.pin}`);
  if (shadow) console.error(`          ${shadow.message}\n          fix: ${shadow.fix}`);
  else console.error(`          copies on PATH: ${copies.map((c) => `${c.path} (${c.version ?? "?"})`).join(", ") || "none"}; open a new shell if it was just added`);
  return false;
}

/**
 * Download the release asset, check its sha256, unpack it and put the binary where the shell
 * finds it: over a plain-file copy already first on PATH, else in ~/.local/bin.
 * @param {string} name @param {ToolSpec} spec @param {(line: string) => void} print
 */
async function installRelease(name, spec, print) {
  const release = /** @type {NonNullable<ReturnType<typeof releaseAsset>>} */ (releaseAsset(spec));
  const work = mkdtempSync(join(tmpdir(), `kit-${name}-`));
  try {
    const [archive, sums] = await Promise.all([download(release.url), download(release.checksumsUrl)]);
    const expected = parseChecksums(sums.toString("utf8")).get(release.asset);
    const actual = createHash("sha256").update(archive).digest("hex");
    if (!expected || expected !== actual) {
      console.error(`  ${release.asset}: sha256 ${actual} does not match the release's ${expected ?? "(no entry)"}`);
      return false;
    }
    const archivePath = join(work, release.asset);
    writeFileSync(archivePath, archive);
    if (spawnSync(tarCommand(), ["-xf", archivePath, "-C", work], { stdio: "inherit" }).status !== 0) return false;
    const binary = findFile(work, release.binary);
    if (!binary) {
      console.error(`  ${release.asset} holds no ${release.binary}`);
      return false;
    }
    const first = findOnPath(spec.command[0])[0];
    const dir = first && !uninstallCommand(first, name, spec) ? dirname(first) : expandHome("~/.local/bin");
    const target = join(dir, release.binary);
    placeBinary(binary, target);
    print(`          ${target}`);
    if (!findOnPath(spec.command[0]).length) console.error(`          ${dir} is not on PATH: add it, then open a new shell`);
    return true;
  } catch (error) {
    console.error(`  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The `tar` that unpacks the asset. On Windows, the system's bsdtar by full path: Git Bash's GNU
 * tar may come first on PATH, and it reads `C:\…` as a remote host and fails. Exported for tests.
 * @param {string} [platform] @param {NodeJS.ProcessEnv} [env] @param {(path: string) => boolean} [exists]
 */
export function tarCommand(platform = process.platform, env = process.env, exists = existsSync) {
  if (platform !== "win32") return "tar";
  const system = join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "tar.exe");
  return exists(system) ? system : "tar";
}

/** @param {string} url */
async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** @param {string} dir @param {string} file @returns {string | null} */
function findFile(dir, file) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, file);
      if (hit) return hit;
    } else if (entry.name === file) return full;
  }
  return null;
}

/**
 * Windows keeps a running .exe locked against overwrite but lets it be renamed (a hook may be
 * running this very binary), so the old copy moves aside first; the next run's clean-up removes it.
 * @param {string} source @param {string} target
 */
function placeBinary(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    const aside = `${target}.old`;
    try {
      rmSync(aside, { force: true });
    } catch {
      // still locked by a process from an earlier swap
    }
    renameSync(target, existsSync(aside) ? `${target}.${Date.now()}.old` : aside);
  }
  copyFileSync(source, target);
  if (process.platform !== "win32") chmodSync(target, 0o755);
}
