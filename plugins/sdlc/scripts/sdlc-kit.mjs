// sdlc-kit: what the sdlc skills need to know about the project, read-only.
//   sdlc-kit [config] [--json]   resolved kit.json values with defaults, and which paths exist
//   sdlc-kit items [--json]      active and archived work items with their lifecycle state
//   sdlc-kit show <document>     a document bundled with the plugin (workflow, templates, contracts)
// Called through bin/sdlc-kit (on the Bash PATH while the plugin is enabled). Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../lib/hook-utils.mjs";
import { KIT_COMMANDS, KIT_DEFAULTS, KIT_FILE } from "../lib/kit-config.mjs";

// The schema defaults and command names, from the shared kit.json reader. The stages never set up
// a checkout or start a dev server, so `install` and `dev` are not listed.
export const DEFAULT_PATHS = KIT_DEFAULTS.paths;
export const COMMANDS = KIT_COMMANDS.filter((name) => name !== "install" && name !== "dev");
export const ARCHIVE_DIR = "archive";
const LIFECYCLE_DOCS = ["intent.md", "spec.md", "plan.md"];

/** kit.json at the root: `{ found, data, error }`. A missing file is not an error. */
export function readKit(root) {
  const file = join(root, KIT_FILE);
  if (!existsSync(file)) return { found: false, data: {}, error: null };
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { found: true, data: {}, error: "kit.json is not a JSON object" };
    }
    return { found: true, data, error: null };
  } catch (err) {
    return { found: true, data: {}, error: `kit.json does not parse: ${err.message}` };
  }
}

function git(root, args) {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return res.status === 0 ? res.stdout : null;
}

/** Base branch: kit.json, else origin/HEAD, else a local main or master. */
export function resolveBase(root, kit, run = git) {
  if (typeof kit.baseBranch === "string" && kit.baseBranch) return { name: kit.baseBranch, source: "kit.json" };
  const head = run(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head && head.trim()) return { name: head.trim().replace(/^origin\//, ""), source: "origin/HEAD" };
  for (const name of ["main", "master"]) {
    if (run(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) !== null) {
      return { name, source: "local branch" };
    }
  }
  return { name: null, source: "unknown" };
}

/** The recipe index inside the recipes folder, if any. */
export function recipeIndex(root, recipesPath) {
  for (const name of ["README.md", "index.md"]) {
    const rel = `${recipesPath}/${name}`;
    if (existsSync(join(root, rel))) return rel;
  }
  return null;
}

export function resolveConfig(root, kitResult, run = git) {
  const kit = kitResult.data;
  const paths = { ...DEFAULT_PATHS, ...(kit.paths && typeof kit.paths === "object" ? kit.paths : {}) };
  const commands = {};
  for (const name of COMMANDS) commands[name] = typeof kit.commands?.[name] === "string" ? kit.commands[name] : null;
  return {
    root,
    kitJson: kitResult.found ? (kitResult.error ? "invalid" : "found") : "missing",
    kitError: kitResult.error,
    project: kit.project ?? null,
    baseBranch: resolveBase(root, kit, run),
    itemPrefix: kit.itemPrefix ?? null,
    ledger: kit.ledger === true,
    paths,
    exists: Object.fromEntries(Object.entries(paths).map(([key, rel]) => [key, existsSync(join(root, rel))])),
    recipeIndex: recipeIndex(root, paths.recipes),
    commands,
    hooksOff: Array.isArray(kit.hooks?.off) ? kit.hooks.off : [],
    codegraph: existsSync(join(root, ".codegraph")),
  };
}

/** `key: value` pairs of a leading `---` front-matter block. */
export function frontMatter(text) {
  if (typeof text !== "string") return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/**
 * Checkbox steps of a plan, outside fenced code blocks and HTML comments (template comments and
 * copied examples are not steps).
 */
export function countSteps(text) {
  if (typeof text !== "string") return null;
  let done = 0;
  let total = 0;
  let fence = false;
  let comment = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    if (!comment && /^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (comment) {
      const end = line.indexOf("-->");
      if (end === -1) continue;
      comment = false;
      line = line.slice(end + 3);
    }
    line = line.replace(/<!--[\s\S]*?-->/g, "");
    const open = line.indexOf("<!--");
    if (open !== -1) {
      comment = true;
      line = line.slice(0, open);
    }
    const box = /^\s*[-*]\s+\[([ xX])\]\s/.exec(line);
    if (!box) continue;
    total += 1;
    if (box[1] !== " ") done += 1;
  }
  return { done, total };
}

function committed(root, rel, run) {
  return run(root, ["show", `HEAD:${rel}`]);
}

function readMaybe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function docState(root, rel, run) {
  const working = readMaybe(join(root, rel));
  const head = committed(root, rel, run);
  if (working === null && head === null) return null;
  return {
    committed: head === null ? null : frontMatter(head).status ?? "none",
    working: working === null ? null : frontMatter(working).status ?? "none",
    dirty: working !== head,
    committedSteps: rel.endsWith("plan.md") ? countSteps(head) : undefined,
    workingSteps: rel.endsWith("plan.md") ? countSteps(working) : undefined,
  };
}

function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && statSync(join(dir, name)).isDirectory())
    .sort();
}

export function listItems(root, sdlcPath, run = git) {
  const base = join(root, sdlcPath);
  const active = subdirs(base)
    .filter((name) => name !== ARCHIVE_DIR)
    .map((slug) => {
      const docs = {};
      for (const doc of LIFECYCLE_DOCS) {
        const state = docState(root, `${sdlcPath}/${slug}/${doc}`, run);
        if (state) docs[doc] = state;
      }
      const intent = frontMatter(readMaybe(join(base, slug, "intent.md"))) ?? {};
      return { slug, branch: intent.branch ?? null, base: intent.base ?? null, ticket: intent.ticket ?? null, docs };
    });
  const archived = subdirs(join(base, ARCHIVE_DIR));
  return { root: sdlcPath, active, archived };
}

function fmtState(name, s) {
  if (!s) return null;
  let out = `${name} ${s.committed ?? "uncommitted"}`;
  if (s.dirty) out += ` (working: ${s.working ?? "deleted"})`;
  if (s.committedSteps) out += ` · steps ${s.committedSteps.done}/${s.committedSteps.total} committed`;
  if (s.dirty && s.workingSteps) out += `, ${s.workingSteps.done}/${s.workingSteps.total} in working tree`;
  return out;
}

export function formatConfig(c) {
  const lines = [`root: ${c.root}`];
  lines.push(
    c.kitJson === "found"
      ? "kit.json: found"
      : c.kitJson === "missing"
        ? "kit.json: missing (defaults below)"
        : `kit.json: INVALID (${c.kitError}); defaults below`,
  );
  lines.push(`project: ${c.project ?? "(not set)"}`);
  lines.push(`baseBranch: ${c.baseBranch.name ?? "(unknown: ask the user)"} [${c.baseBranch.source}]`);
  lines.push(`itemPrefix: ${c.itemPrefix ?? "(none)"}`);
  lines.push(`ledger: ${c.ledger}`);
  lines.push("paths:");
  for (const [key, rel] of Object.entries(c.paths)) lines.push(`  ${key}: ${rel} (${c.exists[key] ? "exists" : "missing"})`);
  lines.push(`recipe index: ${c.recipeIndex ?? "(none)"}`);
  lines.push("commands:");
  for (const [key, cmd] of Object.entries(c.commands)) lines.push(`  ${key}: ${cmd ?? "(none: skip this step)"}`);
  if (c.hooksOff.length) lines.push(`hooks.off: ${c.hooksOff.join(", ")}`);
  lines.push(`codegraph index: ${c.codegraph ? "yes" : "no (impact check by grep)"}`);
  return lines.join("\n");
}

export function formatItems(r) {
  const lines = [`items under ${r.root}:`];
  if (!r.active.length) lines.push("  (no active items)");
  for (const item of r.active) {
    const parts = Object.entries(item.docs).map(([doc, s]) => fmtState(doc.replace(/\.md$/, ""), s));
    const meta = [item.ticket && item.ticket !== "none" ? item.ticket : null, item.branch && item.branch !== "none" ? `branch ${item.branch}` : null]
      .filter(Boolean)
      .join(", ");
    lines.push(`  ${item.slug}${meta ? ` [${meta}]` : ""}: ${parts.length ? parts.join(" · ") : "no lifecycle documents"}`);
  }
  lines.push(`archived: ${r.archived.length}${r.archived.length ? ` (latest: ${r.archived.at(-1)})` : ""}`);
  return lines.join("\n");
}

/**
 * Documents bundled with the plugin, printed by `sdlc-kit show <name>`. Skills read them through
 * this command because the plugin folder lies outside the project, where a file read asks for
 * permission each time.
 */
export const BUNDLED = {
  workflow: "references/workflow.md",
  simplification: "references/simplification.md",
  verification: "references/verification.md",
  "intent-template": "skills/sdlc-intent/assets/template.md",
  "plan-template": "skills/sdlc-plan/assets/template.md",
};
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function show(name, pluginRoot = PLUGIN_ROOT) {
  const rel = BUNDLED[name];
  if (!rel) return null;
  return readFileSync(join(pluginRoot, rel), "utf8");
}

const USAGE = `Use: sdlc-kit [config|items] [--json] | sdlc-kit show <${Object.keys(BUNDLED).join("|")}>`;

export function main(argv, { root = projectRoot(), out = console.log } = {}) {
  const json = argv.includes("--json");
  const words = argv.filter((a) => !a.startsWith("-"));
  const cmd = words[0] ?? "config";
  if (cmd === "show") {
    const text = show(words[1]);
    if (text === null) {
      out(`sdlc-kit: unknown document "${words[1] ?? ""}". ${USAGE}`);
      return 2;
    }
    out(text.trimEnd());
    return 0;
  }
  const config = resolveConfig(root, readKit(root));
  if (cmd === "config") {
    out(json ? JSON.stringify(config, null, 2) : formatConfig(config));
    return 0;
  }
  if (cmd === "items") {
    const items = listItems(root, config.paths.sdlc);
    out(json ? JSON.stringify(items, null, 2) : formatItems(items));
    return 0;
  }
  out(`sdlc-kit: unknown command "${cmd}". ${USAGE}`);
  return 2;
}
