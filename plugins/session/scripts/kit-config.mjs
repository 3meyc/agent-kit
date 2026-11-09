// The project's `kit.json` as the session plugin reads it: defaults filled in, `hooks.off`, the
// ledger folder, and the checkout a hook or a command works on. Node built-ins only.
//
// Candidate for `shared/`: every kit plugin needs the same reader and the same `hooks.off` test.
// Until it moves there, it lives here so this plugin stays self-contained.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { projectRoot } from "../lib/hook-utils.mjs";

/** The file name at the repo root. */
export const KIT_FILE = "kit.json";

/** Defaults for the fields this plugin reads; they match `schema/kit.schema.json`. */
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
  hooks: Object.freeze({ off: Object.freeze([]) }),
  devServer: null,
});

/**
 * The top of the git checkout containing `dir`, or null outside git. A linked worktree is its own
 * checkout: its records, its `kit.json` and its dirty files are not the main checkout's.
 * @param {string} dir
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
  return (typeof cwd === "string" && checkoutRoot(cwd)) || projectRoot();
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

/**
 * `kit.json` parsed and merged over `KIT_DEFAULTS`. A missing file gives the defaults with
 * `found: false`; a broken one does too, with `error` set, so a hook can stay quiet and a command
 * can say why. Never throws.
 * @param {string} root
 * @returns {{ found: boolean, error: string | null, project: string | null, baseBranch: string,
 *   itemPrefix: string | null, ledger: boolean, paths: Record<string, string>,
 *   commands: Record<string, string>, hooks: { off: string[] }, devServer: { port?: number } | null }}
 */
export function readKit(root) {
  const file = join(root, KIT_FILE);
  let raw = null;
  let error = null;
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object");
    } catch (cause) {
      error = `${KIT_FILE}: ${cause instanceof Error ? cause.message : cause}`;
      raw = null;
    }
  }
  const kit = raw ?? {};
  const paths = Object.fromEntries(
    Object.entries(KIT_DEFAULTS.paths).map(([key, fallback]) => [key, relPath(kit.paths?.[key], fallback)]),
  );
  const commands = Object.fromEntries(
    Object.entries(kit.commands ?? {}).filter(([, value]) => typeof value === "string" && value.trim() !== ""),
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
    hooks: { off },
    devServer: kit.devServer && typeof kit.devServer === "object" ? kit.devServer : null,
  };
}

/**
 * Whether a project switched this hook off (`kit.json` `hooks.off`). Plugins cannot be switched off
 * hook by hook, so every kit hook asks this first and exits 0 when it is listed.
 * @param {string} id The hook's stable id, as the plugin README names it.
 * @param {{ hooks: { off: string[] } }} kit
 */
export function hookOff(id, kit) {
  return kit.hooks.off.includes(id);
}

/**
 * Whether a ledger hook should run: the project keeps a ledger and did not switch the hook off.
 * @param {string} id @param {ReturnType<typeof readKit>} kit
 */
export function ledgerHookOn(id, kit) {
  return kit.ledger && !hookOff(id, kit);
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
