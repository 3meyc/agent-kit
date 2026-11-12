// `kit inventory` and `kit drift`: agent tooling across several local repos, for planning what
// moves into a kit and spotting copies that drifted apart.
//
// The repo list is user configuration, never code: `inventory.json` in the agent-kit config
// folder (`$XDG_CONFIG_HOME/agent-kit/`, else `~/.config/agent-kit/`), or `--config <file>`:
//
//   { "repos": { "app": "~/code/my-app", "api": "~/code/my-api" },
//     "reference": "app", "extraRoots": ["tools"], "extraFiles": ["lefthook.yml"] }
//
// `reference` is the copy drift is measured against (default: the first repo). `roots` replaces
// the default folders; `extraRoots` and `extraFiles` add to them.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ownedBy, pluginRoots } from "./kit-owned.mjs";

/** Folders walked recursively, except `scripts`, whose top level only is read. */
export const DEFAULT_ROOTS = [
  ".claude/rules",
  ".claude/skills",
  ".claude/agents",
  ".claude/commands",
  ".claude/output-styles",
  "scripts/hooks",
  "scripts",
];
export const DEFAULT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "kit.json",
  ".claude/settings.json",
  ".claude/launch.json",
  ".claude/README.md",
  ".mcp.json",
];
const SKIP = new Set([".DS_Store", "node_modules", "ledger", "worktrees", ".git"]);

export function configDir() {
  const base = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config");
  return join(base, "agent-kit");
}

const expandHome = (path) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

/**
 * The inventory configuration, or an error message saying where to put it.
 * @param {string | null} file
 * @returns {{ repos: Record<string, string>, reference: string, roots: string[], files: string[] } | { error: string }}
 */
export function loadInventoryConfig(file = null) {
  const path = file ?? join(configDir(), "inventory.json");
  if (!existsSync(path)) {
    return {
      error: `no repo list at ${path}. Create it with {"repos": {"<name>": "<path>", ...}} (at least two repos); see the core plugin README.`,
    };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { error: `${path} does not parse: ${error instanceof Error ? error.message : error}` };
  }
  const repos = {};
  for (const [name, dir] of Object.entries(raw?.repos ?? {})) {
    if (typeof dir === "string") repos[name] = resolve(expandHome(dir));
  }
  const names = Object.keys(repos);
  if (names.length === 0) return { error: `${path} lists no repos under "repos"` };
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  return {
    repos,
    reference: names.includes(raw.reference) ? raw.reference : names[0],
    roots: [...(Array.isArray(raw.roots) ? strings(raw.roots) : DEFAULT_ROOTS), ...strings(raw.extraRoots)],
    files: [...DEFAULT_FILES, ...strings(raw.extraFiles)],
  };
}

function walk(dir, topLevelOnly) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!topLevelOnly) out.push(...walk(path, false));
    } else out.push(path);
  }
  return out;
}

/** `skill:<name>` for anything inside a skill folder, else the path itself. */
export function groupOf(rel) {
  const skill = rel.match(/^\.claude\/skills\/([^/]+)/);
  return skill ? `skill:${skill[1]}` : rel;
}

/**
 * Every tracked agent-tooling file per repo: hash, line count and last commit date.
 * @param {ReturnType<typeof loadInventoryConfig> & { repos: Record<string, string> }} config
 */
export function collectInventory(config) {
  const files = {};
  for (const [name, root] of Object.entries(config.repos)) {
    const list = [];
    for (const dir of config.roots) list.push(...walk(join(root, dir), dir === "scripts"));
    for (const file of config.files) if (existsSync(join(root, file))) list.push(join(root, file));
    for (const abs of new Set(list)) {
      const rel = relative(root, abs).split("\\").join("/");
      if (/\.test\.(m?[jt]s)$/.test(rel)) continue;
      const buffer = readFileSync(abs);
      let date = "";
      try {
        date = execFileSync("git", ["-C", root, "log", "-1", "--format=%cs", "--", rel], { encoding: "utf8" }).trim();
      } catch {
        // Not a git repo, or git missing: the file counts as untracked.
      }
      (files[rel] ??= {})[name] = {
        hash: createHash("sha1").update(buffer).digest("hex").slice(0, 8),
        lines: buffer.toString("utf8").split("\n").length,
        date: date || "untracked",
      };
    }
  }
  const owners = new Map();
  for (const plugin of pluginRoots(null)) {
    for (const { path } of ownedBy(plugin).files) owners.set(path, plugin.name);
  }
  const ownerOf = (rel) => owners.get(rel) ?? owners.get(rel.match(/^\.claude\/skills\/[^/]+/)?.[0]) ?? null;
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, by]) => {
      const names = Object.keys(by);
      const hashes = new Set(names.map((name) => by[name].hash));
      const status = names.length === 1 ? "single" : hashes.size === 1 ? "same" : `drift(${hashes.size})`;
      const newest = names.length > 1 ? names.reduce((a, b) => (by[a].date >= by[b].date ? a : b)) : "";
      return { rel, status, newest, kit: ownerOf(rel), by };
    });
}

/** One line per group: repos, same/drift/single counts, which copy is newest, last dates. */
export function summarize(rows, repoOrder) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupOf(row.rel);
    if (!groups.has(key)) groups.set(key, { repos: new Set(), same: 0, drift: 0, single: 0, newest: {}, dates: {}, kit: row.kit });
    const group = groups.get(key);
    for (const name of Object.keys(row.by)) {
      group.repos.add(name);
      if (!group.dates[name] || row.by[name].date > group.dates[name]) group.dates[name] = row.by[name].date;
    }
    if (row.status === "single") group.single += 1;
    else if (row.status === "same") group.same += 1;
    else {
      group.drift += 1;
      group.newest[row.newest] = (group.newest[row.newest] ?? 0) + 1;
    }
  }
  return [...groups].map(([key, group]) => {
    const order = repoOrder.filter((name) => group.repos.has(name));
    return [
      key,
      order.join(","),
      `same=${group.same}`,
      `drift=${group.drift}`,
      `single=${group.single}`,
      `newest=${Object.entries(group.newest).map(([name, count]) => `${name}:${count}`).join(" ")}`,
      order.map((name) => `${name}@${group.dates[name]}`).join(" "),
      group.kit ? `kit:${group.kit}` : "",
    ]
      .join(" | ")
      .replace(/ \| $/, "");
  });
}

/**
 * Changed lines of every drifting copy against the reference repo's copy (or the first repo that
 * has the file), per path and per group.
 */
export function measureDrift(rows, config) {
  const perPath = [];
  const perGroup = {};
  for (const row of rows) {
    if (!row.status.startsWith("drift")) continue;
    const names = Object.keys(row.by);
    const ref = names.includes(config.reference) ? config.reference : names[0];
    const parts = [];
    for (const name of names) {
      if (name === ref) continue;
      const result = spawnSync(
        "git",
        ["diff", "--no-index", "--numstat", join(config.repos[ref], row.rel), join(config.repos[name], row.rel)],
        { encoding: "utf8" },
      );
      const [added, deleted] = (result.stdout ?? "").trim().split("\t").map(Number);
      parts.push(`${name}:+${added || 0}/-${deleted || 0}(of ${row.by[ref].lines})`);
      const key = groupOf(row.rel);
      perGroup[key] ??= {};
      perGroup[key][name] = (perGroup[key][name] ?? 0) + (added || 0) + (deleted || 0);
    }
    perPath.push(`${row.rel} | ref=${ref} | ${parts.join(" ")}`);
  }
  const groups = Object.entries(perGroup).map(
    ([key, counts]) => `${key}: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(" ")}`,
  );
  return { perPath, groups };
}

function parseArgs(args) {
  const options = { out: null, config: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out" && args[i + 1]) options.out = resolve(args[(i += 1)]);
    else if (args[i] === "--config" && args[i + 1]) options.config = resolve(args[(i += 1)]);
    else throw new Error(`unknown option ${args[i]} (use --out <dir>, --config <file>)`);
  }
  return options;
}

/** `kit inventory [--out dir] [--config file]` and `kit drift [--out dir] [--config file]`. */
export function runInventory(mode, args, print = console.log) {
  const options = parseArgs(args);
  const config = loadInventoryConfig(options.config);
  if ("error" in config) {
    console.error(`kit ${mode}: ${config.error}`);
    return 1;
  }
  const missing = Object.entries(config.repos).filter(([, dir]) => !existsSync(dir));
  for (const [name, dir] of missing) console.error(`kit ${mode}: repo ${name} not found at ${dir}; skipped`);
  for (const [name] of missing) delete config.repos[name];
  const rows = collectInventory(config);
  const order = Object.keys(config.repos);
  const write = (name, text) => {
    if (!options.out) return;
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, name), text);
  };
  if (mode === "inventory") {
    const lines = summarize(rows, order);
    write("inventory.json", JSON.stringify(rows, null, 1));
    write("summary.txt", `${lines.join("\n")}\n`);
    print(`repos=${order.join(",")} files=${rows.length} groups=${lines.length}`);
    for (const line of lines) print(line);
  } else {
    const drift = measureDrift(rows, config);
    write("diffsize.txt", `${drift.perPath.join("\n")}\n`);
    write("diffgroup.txt", `${drift.groups.join("\n")}\n`);
    print(`reference=${config.reference} drifting paths=${drift.perPath.length}`);
    for (const line of drift.groups) print(line);
  }
  if (options.out) print(`written to ${options.out}`);
  return 0;
}
