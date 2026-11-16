// `kit dotfiles`: keep your user-global Claude Code layer (settings, global instructions, user
// skills, agents, commands, output styles) in a private folder you push as a git repo of your own,
// and link it back onto each machine. ../dotfiles.json names what travels and what never may.
//
// `init` seeds the folder from this machine, `apply` links each path from the folder onto this
// machine (a real file it replaces is kept as `<name>.backup-<time>`; where a link cannot be made,
// as for files on Windows without Developer Mode, it copies), and `check` reports each path and
// scans the folder for secrets and machine-local paths. The folder is `--dir`, else KIT_DOTFILES,
// else ~/.claude-dotfiles. Creating and pushing the private repo is the user's step: nothing here
// runs git or talks to GitHub.
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DOTFILES_FILE = fileURLToPath(new URL("../dotfiles.json", import.meta.url));

export const DOTFILES_USAGE = `Usage: kit dotfiles <init | apply | check> [--dir <folder>] [--dry-run] [--copy]

Keep ~/.claude settings, CLAUDE.md, your skills, agents, commands and output styles in a private
folder you push as your own git repo, and link it onto each machine.
  init    seed the folder from this machine, write its .gitignore, scan it for secrets
  apply   link (--copy: copy) each path from the folder onto this machine; real files are kept
          as <name>.backup-<time>
  check   each path's state, and secrets, machine paths or never-sync files inside the folder
The folder is --dir, else KIT_DOTFILES, else ~/.claude-dotfiles. --dry-run prints the plan only.`;

/**
 * @typedef {{ path: string; what: string; exclude?: string[]; excludeWhy?: string }} PortablePath
 * @typedef {{ portable: PortablePath[]; neverSync: { path: string; why: string }[] }} DotfilesManifest
 * @typedef {{ action?: string; dir: string | null; dryRun: boolean; copy: boolean; help?: boolean; error?: string }} DotfilesOptions
 * @typedef {{ file: string; line: number; kind: "token" | "secret value" | "machine path" }} Finding
 */

/** @returns {DotfilesManifest} */
export function readDotfilesManifest(file = DOTFILES_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** `~` or `~/…` under `home`. @param {string} path @param {string} home */
export function underHome(path, home) {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, ...path.slice(2).split("/")) : path;
}

/** The dotfiles folder: KIT_DOTFILES, else ~/.claude-dotfiles. @param {NodeJS.ProcessEnv} [env] */
export function dotfilesDir(env = process.env, home = homedir()) {
  return env.KIT_DOTFILES ? resolve(underHome(env.KIT_DOTFILES, home)) : join(home, ".claude-dotfiles");
}

/** @param {string[]} args @returns {DotfilesOptions} */
export function parseDotfilesArgs(args) {
  const [action, ...rest] = args;
  /** @type {DotfilesOptions} */
  const options = { action, dir: null, dryRun: false, copy: false };
  if (action === undefined) return { ...options, error: "name an action: init, apply or check" };
  if (action === "--help" || action === "-h") return { ...options, help: true };
  if (!["init", "apply", "check"].includes(action)) return { ...options, error: `unknown action ${action}` };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--copy") options.copy = true;
    else if (arg === "--dir") {
      const value = rest[++i];
      if (!value) return { ...options, error: "--dir needs a folder" };
      options.dir = value;
    } else return { ...options, error: `unknown option ${arg}` };
  }
  return options;
}

/** The folder's `.gitignore` lines: each portable folder's excluded entries. @param {DotfilesManifest} manifest */
export function ignoreLines(manifest) {
  return manifest.portable.flatMap((item) => (item.exclude ?? []).map((name) => `${basename(item.path)}/${name}/`));
}

const TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/;
const SECRET_VALUE = /"[^"\n]*(token|secret|password|passwd|api[_-]?key)[^"\n]*"\s*:\s*"[^"\n]{8,}"/i;
const MACHINE_PATH = /(\/Users\/[^/\s"'`]+\/|\/home\/[^/\s"'`]+\/|[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"'`]+)/;

/**
 * Secret-shaped and machine-local lines in a text, by line number; the matched text is never
 * returned, so a report cannot leak it. Pure. @param {string} text
 * @returns {{ line: number; kind: Finding["kind"] }[]}
 */
export function scanText(text) {
  /** @type {{ line: number; kind: Finding["kind"] }[]} */
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (TOKEN.test(line)) found.push({ line: index + 1, kind: "token" });
    else if (SECRET_VALUE.test(line)) found.push({ line: index + 1, kind: "secret value" });
    if (MACHINE_PATH.test(line)) found.push({ line: index + 1, kind: "machine path" });
  });
  return found;
}

/** Every text file under `dir` (no .git, nothing over 1 MB, no binary) with its findings. @param {string} dir */
export function scanDir(dir) {
  /** @type {Finding[]} */
  const findings = [];
  /** @param {string} folder */
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && statSync(path).size <= 1_000_000) {
        const text = readFileSync(path, "utf8");
        if (text.includes("\0")) continue;
        for (const hit of scanText(text)) findings.push({ file: relative(dir, path).split("\\").join("/"), ...hit });
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return findings;
}

/** Whether `path` is a link to `target`. @param {string} path @param {string} target */
function linksTo(path, target) {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === resolve(target);
  } catch {
    return false;
  }
}

/** Same bytes in two files. @param {string} a @param {string} b */
function sameFile(a, b) {
  try {
    return statSync(a).isFile() && statSync(b).isFile() && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Every file under `root` by its relative path, leaving out excluded top-level names. @param {string} root @param {string[]} exclude */
function filesUnder(root, exclude) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} folder @param {string} prefix */
  const walk = (folder, prefix) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (prefix === "" && exclude.includes(entry.name)) continue;
      const path = join(folder, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (statSync(path).isDirectory()) walk(path, name);
      else files.push(name);
    }
  };
  walk(root, "");
  return files.sort();
}

/** The same files with the same bytes in two folders, excluded names aside. @param {string} a @param {string} b @param {string[]} exclude */
function sameTree(a, b, exclude) {
  try {
    if (!statSync(a).isDirectory() || !statSync(b).isDirectory()) return false;
    const left = filesUnder(a, exclude);
    const right = filesUnder(b, exclude);
    return left.length === right.length && left.every((name, index) => name === right[index] && sameFile(join(a, name), join(b, name)));
  } catch {
    return false;
  }
}

/**
 * One portable path's state on this machine against the folder: linked, copy (same bytes),
 * differs, only-here, only-in-folder or absent.
 * @param {PortablePath} item @param {string} dir @param {string} home
 */
export function pathState(item, dir, home) {
  const here = underHome(item.path, home);
  const kept = join(dir, basename(item.path));
  const inFolder = existsSync(kept);
  if (linksTo(here, kept)) return "linked";
  if (!existsSync(here)) return inFolder ? "only-in-folder" : "absent";
  if (!inFolder) return "only-here";
  if (sameFile(here, kept) || sameTree(here, kept, item.exclude ?? [])) return "copy";
  return "differs";
}

/** @param {string} source @param {string} destination @param {string[]} exclude top-level names left out */
function copyInto(source, destination, exclude) {
  if (!statSync(source).isDirectory()) {
    copyFileSync(source, destination);
    return;
  }
  const skipped = exclude.map((name) => join(source, name));
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => !skipped.some((skip) => path === skip || path.startsWith(`${skip}/`) || path.startsWith(`${skip}\\`)),
  });
}

/** Link `destination` to `source`, or copy where a link cannot be made. @returns {"link" | "copy"} */
function linkOrCopy(/** @type {string} */ source, /** @type {string} */ destination, /** @type {boolean} */ preferCopy) {
  const isDirectory = statSync(source).isDirectory();
  if (!preferCopy) {
    try {
      symlinkSync(source, destination, isDirectory ? (process.platform === "win32" ? "junction" : "dir") : "file");
      return "link";
    } catch {
      // Windows refuses file links without Developer Mode: a copy keeps the machine usable.
    }
  }
  copyInto(source, destination, []);
  return "copy";
}

/** @param {DotfilesManifest} manifest @param {string} dir @param {string} home @param {DotfilesOptions} options @param {(line: string) => void} print */
function init(manifest, dir, home, options, print) {
  print(`kit dotfiles init · ${dir}${options.dryRun ? " · dry run" : ""}`);
  if (!options.dryRun) mkdirSync(dir, { recursive: true });
  for (const item of manifest.portable) {
    const here = underHome(item.path, home);
    const kept = join(dir, basename(item.path));
    if (!existsSync(here)) print(`  skip  ${item.path}: not on this machine`);
    else if (existsSync(kept)) print(`  skip  ${item.path}: already in the folder`);
    else {
      if (!options.dryRun) copyInto(here, kept, item.exclude ?? []);
      print(`  copy  ${item.path}`);
      for (const name of item.exclude ?? []) print(`  leave ${item.path}/${name}: ${item.excludeWhy}`);
    }
  }
  const ignore = join(dir, ".gitignore");
  const present = existsSync(ignore) ? readFileSync(ignore, "utf8").split(/\r?\n/).filter(Boolean) : [];
  const missing = ignoreLines(manifest).filter((line) => !present.includes(line));
  if (missing.length > 0) {
    if (!options.dryRun) writeFileSync(ignore, `${[...present, ...missing].join("\n")}\n`);
    print(`  ignore ${missing.join(", ")}`);
  }
  const findings = options.dryRun ? [] : scanDir(dir);
  reportFindings(findings, print);
  print("");
  print("Next, once nothing above needs fixing: make the folder a private repo of your own and push it.");
  print(`  git -C "${dir}" init; git -C "${dir}" add .; git -C "${dir}" commit -m "chore: seed dotfiles"; gh repo create <you>/claude-dotfiles --private --source "${dir}" --push`);
  print("Then, on this machine and each other one: kit dotfiles apply (after cloning the repo to the same folder).");
  return findings.some((finding) => finding.kind !== "machine path") ? 1 : 0;
}

/** @param {Finding[]} findings @param {(line: string) => void} print */
function reportFindings(findings, print) {
  for (const finding of findings) {
    const fix = finding.kind === "machine path"
      ? "another machine will not have it: use a path every machine shares, or keep the setting out of the folder"
      : "remove it before you push; keep the value outside the folder";
    print(`  ${finding.kind === "machine path" ? "warn" : "FAIL"}  ${finding.file}:${finding.line}: ${finding.kind} (${fix})`);
  }
}

/** @param {DotfilesManifest} manifest @param {string} dir @param {string} home @param {DotfilesOptions} options @param {(line: string) => void} print */
function apply(manifest, dir, home, options, print) {
  if (!existsSync(dir)) {
    print(`kit dotfiles: ${dir} does not exist. Clone your dotfiles repo there, or run \`kit dotfiles init\` on a machine that is set up.`);
    return 1;
  }
  print(`kit dotfiles apply · ${dir}${options.dryRun ? " · dry run" : ""}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const item of manifest.portable) {
    const here = underHome(item.path, home);
    const kept = join(dir, basename(item.path));
    const state = pathState(item, dir, home);
    if (state === "absent" || state === "only-here") {
      print(`  skip  ${item.path}: not in the folder`);
      continue;
    }
    if (state === "linked") {
      print(`  ok    ${item.path}: already linked`);
      continue;
    }
    if (existsSync(here) || isLink(here)) {
      if (isLink(here)) {
        if (!options.dryRun) rmSync(here, { force: true });
      } else {
        const backup = `${here}.backup-${stamp}`;
        if (!options.dryRun) renameSync(here, backup);
        print(`  keep  ${item.path} as ${basename(backup)}`);
      }
    }
    if (options.dryRun) {
      print(`  plan  ${item.path} <- ${kept}`);
      continue;
    }
    mkdirSync(dirname(here), { recursive: true });
    const how = linkOrCopy(kept, here, options.copy);
    print(`  ${how}  ${item.path} <- ${kept}${how === "copy" && !options.copy ? " (no link allowed here: run apply again after each pull)" : ""}`);
  }
  return 0;
}

/** @param {string} path */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const STATE_LINES = {
  linked: ["ok", "linked to the folder"],
  copy: ["ok", "a copy, the same as the folder's (run apply again after each pull)"],
  differs: ["warn", "differs from the folder's copy: run apply, or copy your change into the folder"],
  "only-here": ["warn", "only on this machine: init adds it to the folder"],
  "only-in-folder": ["warn", "in the folder, not on this machine: run apply"],
  absent: ["ok", "on neither"],
};

/** @param {DotfilesManifest} manifest @param {string} dir @param {string} home @param {(line: string) => void} print */
function check(manifest, dir, home, print) {
  if (!existsSync(dir)) {
    print(`kit dotfiles: ${dir} does not exist. \`kit dotfiles init\` seeds it.`);
    return 1;
  }
  print(`kit dotfiles check · ${dir}`);
  let failed = false;
  for (const item of manifest.portable) {
    const [level, text] = STATE_LINES[pathState(item, dir, home)];
    print(`  ${level.padEnd(4)}  ${item.path}: ${text}`);
  }
  for (const item of manifest.neverSync) {
    if (existsSync(join(dir, basename(item.path)))) {
      failed = true;
      print(`  FAIL  ${basename(item.path)} is in the folder: ${item.why}. Remove it from the folder and from the repo's history.`);
    }
  }
  const ignore = join(dir, ".gitignore");
  const present = existsSync(ignore) ? readFileSync(ignore, "utf8").split(/\r?\n/) : [];
  const missing = ignoreLines(manifest).filter((line) => !present.includes(line));
  if (missing.length > 0) print(`  warn  .gitignore lacks ${missing.join(", ")}: \`kit dotfiles init\` adds it`);
  const findings = scanDir(dir);
  reportFindings(findings, print);
  if (findings.some((finding) => finding.kind !== "machine path")) failed = true;
  return failed ? 1 : 0;
}

/**
 * `kit dotfiles <init | apply | check>`. @param {string[]} args
 * @param {{ home?: string; env?: NodeJS.ProcessEnv; manifest?: DotfilesManifest; print?: (line: string) => void }} [deps]
 * @returns {number}
 */
export function runDotfiles(args, deps = {}) {
  const options = parseDotfilesArgs(args);
  const print = deps.print ?? console.log;
  if (options.error) {
    console.error(`kit dotfiles: ${options.error}\n\n${DOTFILES_USAGE}`);
    return 1;
  }
  if (options.help) {
    print(DOTFILES_USAGE);
    return 0;
  }
  const home = deps.home ?? homedir();
  const manifest = deps.manifest ?? readDotfilesManifest();
  const dir = options.dir ? resolve(underHome(options.dir, home)) : dotfilesDir(deps.env ?? process.env, home);
  if (options.action === "init") return init(manifest, dir, home, options, print);
  if (options.action === "apply") return apply(manifest, dir, home, options, print);
  return check(manifest, dir, home, print);
}
