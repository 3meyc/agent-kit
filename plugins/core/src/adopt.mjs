// `kit adopt`: puts a project on the kit. Dry run by default; `--write` applies it.
//
// 1. A starter kit.json, only when there is none: project name, base branch, the check, lint,
//    test and build commands its package.json defines, and the dev server port from
//    .claude/launch.json.
// 2. .claude/settings.json: the marketplaces in `extraKnownMarketplaces` (the base, plus any
//    overlay, both needed for overlay dependencies, docs/spikes.md S3a) and the plugins in
//    `enabledPlugins`. Only adds keys; never changes or removes one the file has.
// 3. Lists the local files the kit now supplies. Deletes nothing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BASE_MARKETPLACE } from "./doctor.mjs";
import { KIT_FILE } from "../lib/kit-config.mjs";
import { findKitCopies } from "./kit-owned.mjs";

export const SCHEMA_URL = "https://raw.githubusercontent.com/3meyc/agent-kit/stable/schema/kit.schema.json";
export const BASE_SOURCE = "3meyc/agent-kit#stable";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** `owner/repo#ref` → a GitHub marketplace source. */
export function githubSource(spec) {
  const [repo, ref] = spec.split("#");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not an owner/repo: ${spec}`);
  return ref ? { source: "github", repo, ref } : { source: "github", repo };
}

function packageRunner(projectDir) {
  if (existsSync(join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectDir, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectDir, "bun.lockb")) || existsSync(join(projectDir, "bun.lock"))) return "bun";
  return "npm";
}

function baseBranch(projectDir) {
  const head = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: projectDir, encoding: "utf8" });
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, "");
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectDir, encoding: "utf8" });
  return branch.status === 0 && branch.stdout.trim() && branch.stdout.trim() !== "HEAD" ? branch.stdout.trim() : "main";
}

/**
 * The repo's own name: the `origin` repository, else the main checkout's folder. Never the
 * folder itself first, which in a linked worktree is the worktree's generated name.
 */
export function repoName(projectDir) {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "";
  };
  const remote = git("remote", "get-url", "origin").replace(/\/+$/, "").replace(/\.git$/, "");
  if (remote) return basename(remote.replace(/:/g, "/"));
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common && basename(common) === ".git") return basename(dirname(common));
  return basename(projectDir);
}

/** A starter kit.json drawn from what the project already declares. */
export function starterKitJson(projectDir) {
  const project = repoName(projectDir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "my-app";
  const kit = { $schema: SCHEMA_URL, project, baseBranch: baseBranch(projectDir), ledger: false };
  const scripts = readJson(join(projectDir, "package.json"))?.scripts ?? {};
  const runner = packageRunner(projectDir);
  const commands = {};
  const pick = (name, candidates) => {
    const script = candidates.find((candidate) => typeof scripts[candidate] === "string");
    if (script) commands[name] = runner === "npm" && script !== "test" ? `npm run ${script}` : `${runner} ${script === "test" ? "test" : `run ${script}`}`;
  };
  pick("check", ["check", "typecheck"]);
  pick("lint", ["lint:check", "lint"]);
  pick("test", ["test"]);
  pick("build", ["build"]);
  if (Object.keys(commands).length > 0) kit.commands = commands;
  const port = readJson(join(projectDir, ".claude", "launch.json"))?.configurations?.find((entry) => Number.isInteger(entry?.port))?.port;
  if (port) kit.devServer = { port };
  return kit;
}

/**
 * The settings.json after adoption, and what changed.
 * @param {Record<string, any>} settings
 * @param {{ marketplaces: Record<string, object>, plugins: string[] }} wanted
 */
export function mergeSettings(settings, wanted) {
  const next = structuredClone(settings);
  const changes = [];
  next.extraKnownMarketplaces ??= {};
  for (const [name, source] of Object.entries(wanted.marketplaces)) {
    if (next.extraKnownMarketplaces[name]) continue;
    next.extraKnownMarketplaces[name] = { source };
    changes.push(`extraKnownMarketplaces.${name} = ${source.repo}${source.ref ? `#${source.ref}` : ""}`);
  }
  next.enabledPlugins ??= {};
  for (const id of wanted.plugins) {
    if (id in next.enabledPlugins) {
      if (next.enabledPlugins[id] !== true) changes.push(`left as is: enabledPlugins.${id} = ${JSON.stringify(next.enabledPlugins[id])}`);
      continue;
    }
    next.enabledPlugins[id] = true;
    changes.push(`enabledPlugins.${id} = true`);
  }
  return { settings: next, changes };
}

/**
 * Parse `adopt` arguments.
 * @param {string[]} args
 */
export function parseAdoptArgs(args) {
  const options = { write: false, base: BASE_SOURCE, plugins: ["core"], overlays: {}, overlayPlugins: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = () => {
      if (args[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return args[i];
    };
    if (arg === "--write") options.write = true;
    else if (arg === "--base") options.base = value();
    else if (arg === "--plugins") options.plugins = value().split(",").map((name) => name.trim()).filter(Boolean);
    else if (arg === "--overlay") {
      const [name, spec] = value().split("=");
      if (!name || !spec) throw new Error("--overlay takes name=owner/repo[#ref]");
      options.overlays[name] = spec;
    } else if (arg === "--overlay-plugin") options.overlayPlugins.push(value());
    else throw new Error(`unknown option ${arg}`);
  }
  if (!options.plugins.includes("core")) options.plugins.unshift("core");
  return options;
}

export function runAdopt(projectDir, args, print = console.log) {
  const options = parseAdoptArgs(args);
  const verb = options.write ? "" : "would ";
  let step = 0;
  const heading = (text) => print(`${(step += 1)}. ${text}`);

  const kitPath = join(projectDir, KIT_FILE);
  heading(KIT_FILE);
  if (existsSync(kitPath)) print(`   kept: ${KIT_FILE} exists; \`kit doctor\` checks it`);
  else {
    const kit = starterKitJson(projectDir);
    if (options.write) writeFileSync(kitPath, `${JSON.stringify(kit, null, 2)}\n`);
    print(`   ${verb}write a starter ${KIT_FILE}:`);
    for (const line of JSON.stringify(kit, null, 2).split("\n")) print(`     ${line}`);
  }

  heading(".claude/settings.json");
  const settingsPath = join(projectDir, ".claude", "settings.json");
  const current = existsSync(settingsPath) ? readJson(settingsPath) : {};
  if (current === null) {
    print("   FAIL .claude/settings.json does not parse; fix it, then run adopt again");
    return 1;
  }
  const marketplaces = { [BASE_MARKETPLACE]: githubSource(options.base) };
  for (const [name, spec] of Object.entries(options.overlays)) marketplaces[name] = githubSource(spec);
  const plugins = [...options.plugins.map((name) => (name.includes("@") ? name : `${name}@${BASE_MARKETPLACE}`)), ...options.overlayPlugins];
  const { settings, changes } = mergeSettings(current, { marketplaces, plugins });
  if (changes.length === 0) print("   kept: already declares these marketplaces and plugins");
  else {
    for (const change of changes) print(`   ${change.startsWith("left") ? "" : verb}${change}`);
    if (options.write) {
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  }

  heading("Local files the kit now supplies (nothing deleted)");
  const copies = findKitCopies(projectDir);
  if (copies.length === 0) print("   none");
  for (const copy of copies) print(`   - ${copy.path} — ${copy.plugin}${copy.note ? ` (${copy.note})` : ""}`);
  if (!options.write) print("\nDry run: nothing written. Run again with --write to apply.");
  else print("\nWritten. Commit kit.json and .claude/settings.json; teammates are asked to install the plugins on their next session.");
  return 0;
}
