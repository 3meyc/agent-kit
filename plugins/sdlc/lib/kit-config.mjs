// GENERATED from shared/kit-config.mjs by scripts/vendor-shared.mjs. Edit shared/kit-config.mjs and run `npm run vendor`.
// The project's `kit.json` as every kit plugin reads it: schema defaults filled in, the `hooks.off`
// test, and the checkout a hook or a command works on. Node built-ins only. Never throws: a missing
// or broken kit.json means "defaults", because a hook that throws must not block the tool call it
// runs beside.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { projectRoot } from "./hook-utils.mjs";

/** The file name at the repo root. */
export const KIT_FILE = "kit.json";

/** The `commands` keys schema v1 defines, in the order tools list them. A `checks` suite may not reuse one. */
export const KIT_COMMANDS = Object.freeze(["install", "dev", "check", "lint", "test", "build", "commit", "land", "commitAudit", "commitMessage"]);

/** Defaults for the fields the plugins read; they match `schema/kit.schema.json`. */
export const KIT_DEFAULTS = Object.freeze({
  baseBranch: "main",
  itemPrefix: null,
  ledger: false,
  paths: Object.freeze({
    docs: "docs",
    decisions: "docs/decisions",
    sdlc: "docs/sdlc",
    glossary: "docs/glossary.md",
    recipes: "docs/recipes",
    ledger: ".claude/ledger",
  }),
  commands: Object.freeze({}),
  lintOnEdit: Object.freeze([]),
  checks: Object.freeze({}),
  preflight: Object.freeze({}),
  hooks: Object.freeze({ off: Object.freeze([]) }),
  devServer: null,
});

/**
 * The top of the git checkout containing `dir`, or null outside git. A linked worktree is its own
 * checkout: its records, its `kit.json` and its dirty files are not the main checkout's.
 * @param {unknown} dir
 */
export function checkoutRoot(dir) {
  if (typeof dir !== "string" || dir === "" || !existsSync(dir)) return null;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  return top.status === 0 && top.stdout.trim() ? resolve(top.stdout.trim()) : null;
}

/**
 * The checkout a hook or a command works on: the one containing `cwd` (a hook payload's `cwd`, or
 * the process's), else `projectRoot()`. The payload comes first because the app may start a
 * worktree session's hooks with `CLAUDE_PROJECT_DIR` naming the main checkout.
 * @param {unknown} [cwd]
 */
export function rootFor(cwd = process.cwd()) {
  return checkoutRoot(cwd) || projectRoot();
}

/**
 * A repo-relative path from `kit.json` that is safe to join to the root: forward slashes, not
 * absolute, no `..` segment (the schema's `relPath`). Anything else falls back to the default.
 * @param {unknown} value @param {string} fallback
 */
function relPath(value, fallback) {
  if (typeof value !== "string" || value === "" || isAbsolute(value) || value.includes("\\")) return fallback;
  if (value.split("/").includes("..")) return fallback;
  return value.replace(/\/+$/, "");
}

/** String items of a list, or an empty list. @param {unknown} list */
function strings(list) {
  return Array.isArray(list) ? list.filter((item) => typeof item === "string" && item !== "") : [];
}

/**
 * `lintOnEdit` as a list of `{ command, match }` rules, empty when there is none. The file may hold
 * one rule object or a list of them; a rule without a usable command is dropped. `match` holds
 * globs over the repo-relative path; empty means every file. Takes a raw or a read kit.
 * @param {unknown} kit
 * @returns {Array<{ command: string, match: string[] }>}
 */
export function lintOnEdit(kit) {
  const entry = /** @type {any} */ (kit)?.lintOnEdit;
  const rules = Array.isArray(entry) ? entry : entry && typeof entry === "object" ? [entry] : [];
  return rules
    .filter((rule) => rule && typeof rule === "object" && typeof rule.command === "string" && rule.command.trim() !== "")
    .map((rule) => ({ command: rule.command, match: strings(rule.match) }));
}

/**
 * `checks`: named suites of commands for `/core:check <name>`, each a non-empty list of command
 * lines. Takes a raw or a read kit.
 * @param {unknown} kit
 * @returns {Record<string, string[]>}
 */
export function checkSuites(kit) {
  const entry = /** @type {any} */ (kit)?.checks;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  return Object.fromEntries(
    Object.entries(entry)
      .map(([name, list]) => [name, strings(list).filter((command) => command.trim() !== "")])
      .filter(([, list]) => list.length > 0),
  );
}

/**
 * `preflight`: optional steps whose skips the session plugin counts, as
 * `{ id: { description, command, match, remindAfter } }`. A step without a description is dropped.
 * Takes a raw or a read kit.
 * @param {unknown} kit
 * @returns {Record<string, { description: string, command: string | null, match: string[], remindAfter: number }>}
 */
export function preflightSteps(kit) {
  const entry = /** @type {any} */ (kit)?.preflight;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  const steps = {};
  for (const [id, step] of Object.entries(entry)) {
    if (!step || typeof step !== "object" || typeof step.description !== "string" || step.description === "") continue;
    steps[id] = {
      description: step.description,
      command: typeof step.command === "string" && step.command.trim() !== "" ? step.command : null,
      match: strings(step.match),
      remindAfter: Number.isInteger(step.remindAfter) && step.remindAfter >= 1 ? step.remindAfter : 1,
    };
  }
  return steps;
}

/**
 * @typedef {{ found: boolean, error: string | null, project: string | null, baseBranch: string,
 *   itemPrefix: string | null, ledger: boolean, paths: Record<string, string>,
 *   commands: Record<string, string>, lintOnEdit: Array<{ command: string, match: string[] }>,
 *   checks: Record<string, string[]>, preflight: ReturnType<typeof preflightSteps>,
 *   hooks: { off: string[] }, devServer: { port?: number } | null, raw: Record<string, any> | null }} Kit
 */

/**
 * A parsed `kit.json` object merged over `KIT_DEFAULTS`. Wrong-typed values fall back to the
 * default; empty commands are dropped. `raw` keeps the parsed object (null when there is none).
 * @param {Record<string, any> | null} raw @param {string | null} [error]
 * @returns {Kit}
 */
export function normalizeKit(raw, error = null) {
  const kit = raw ?? {};
  const paths = Object.fromEntries(
    Object.entries(KIT_DEFAULTS.paths).map(([key, fallback]) => [key, relPath(kit.paths?.[key], fallback)]),
  );
  const commands = Object.fromEntries(
    Object.entries(kit.commands && typeof kit.commands === "object" ? kit.commands : {}).filter(
      ([, value]) => typeof value === "string" && value.trim() !== "",
    ),
  );
  const off = Array.isArray(kit.hooks?.off) ? kit.hooks.off.filter((id) => typeof id === "string") : [];
  return {
    found: raw !== null,
    error,
    project: typeof kit.project === "string" ? kit.project : null,
    baseBranch: typeof kit.baseBranch === "string" && kit.baseBranch ? kit.baseBranch : KIT_DEFAULTS.baseBranch,
    itemPrefix: typeof kit.itemPrefix === "string" && kit.itemPrefix ? kit.itemPrefix : null,
    ledger: kit.ledger === true,
    paths,
    commands,
    lintOnEdit: lintOnEdit(kit),
    checks: checkSuites(kit),
    preflight: preflightSteps(kit),
    hooks: { off },
    devServer: kit.devServer && typeof kit.devServer === "object" ? kit.devServer : null,
    // The parsed file as written, for a caller that must tell "set" from "defaulted".
    raw,
  };
}

/**
 * `kit.json` at `root`, read and merged over `KIT_DEFAULTS`. A missing file gives the defaults with
 * `found: false`; a broken one does too, with `error` set, so a hook can stay quiet and a command
 * can say why.
 * @param {string} root
 * @returns {Kit}
 */
export function readKit(root) {
  const file = join(root, KIT_FILE);
  if (!existsSync(file)) return normalizeKit(null);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object");
    return normalizeKit(raw);
  } catch (cause) {
    return normalizeKit(null, `${KIT_FILE}: ${cause instanceof Error ? cause.message : cause}`);
  }
}

/**
 * Whether a project switched this hook off (`kit.json` `hooks.off`). Plugins cannot be switched off
 * hook by hook (docs/spikes.md S5), so every kit hook asks this first and exits 0 when listed.
 * @param {string} id The hook's stable id, as the plugin README names it.
 * @param {{ hooks?: { off?: unknown } } | null | undefined} kit A read or a raw kit.
 */
export function hookOff(id, kit) {
  const off = kit?.hooks?.off;
  return Array.isArray(off) && off.includes(id);
}

/**
 * Whether a ledger hook should run: the project keeps a ledger and did not switch the hook off.
 * @param {string} id @param {{ ledger?: unknown, hooks?: { off?: unknown } } | null | undefined} kit
 */
export function ledgerHookOn(id, kit) {
  return kit?.ledger === true && !hookOff(id, kit);
}

/** `commands.<name>` as a non-empty string, or null. @param {unknown} kit @param {string} name */
export function kitCommand(kit, name) {
  const value = /** @type {any} */ (kit)?.commands?.[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The ledger folder, absolute. @param {string} root @param {{ paths: { ledger: string } }} kit */
export function ledgerDir(root, kit) {
  return join(root, ...kit.paths.ledger.split("/"));
}

/**
 * Whether a repo-relative POSIX path lies in the ledger folder (records, `INDEX.md`, `archive/`).
 * @param {string} path @param {{ paths: { ledger: string } }} kit
 */
export function inLedger(path, kit) {
  return path === kit.paths.ledger || path.startsWith(`${kit.paths.ledger}/`);
}

/** A string for use inside a RegExp source. @param {string} text */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
