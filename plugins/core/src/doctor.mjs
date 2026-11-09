// `kit doctor`: checks one project's kit set-up and prints a numbered report.
//
// 1. kit.json against the schema shipped with this plugin.
// 2. The plugins the project needs are enabled, and the marketplaces they come from are declared
//    in the project's `extraKnownMarketplaces`: an overlay's dependencies on the base kit resolve
//    only when both are declared (docs/spikes.md S3a).
// 3. Copies of kit-owned files in the repo, which shadow or duplicate the kit.
// 4. Installed kit plugins against their marketplace ref (S8), with the update commands.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_ROOT, findKitCopies } from "./kit-owned.mjs";
import { KIT_FILE } from "../lib/kit-config.mjs";
import { validate } from "./schema-check.mjs";
import { checkUpdates, claudeDir, defaultCacheFile, updateCommands } from "./update-check.mjs";

export const BASE_MARKETPLACE = "agent-kit";

function readJson(file) {
  if (!existsSync(file)) return { missing: true };
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function loadSchema() {
  return JSON.parse(readFileSync(join(CORE_ROOT, "schema", "kit.schema.json"), "utf8"));
}

/** Findings for kit.json: `{ level: "ok" | "warn" | "fail", text }`. */
export function checkKitJson(projectDir, schema = loadSchema()) {
  const file = readJson(join(projectDir, KIT_FILE));
  if (file.missing) return { config: null, findings: [{ level: "fail", text: `no ${KIT_FILE} at the repo root; \`/kit-adopt\` writes a starter` }] };
  if (file.error) return { config: null, findings: [{ level: "fail", text: `${KIT_FILE} does not parse: ${file.error}` }] };
  const findings = [];
  for (const error of validate(file.value, schema)) {
    findings.push({ level: "fail", text: `${KIT_FILE} ${error.path}: ${error.message}` });
  }
  if (findings.every((finding) => finding.level !== "fail")) findings.unshift({ level: "ok", text: `${KIT_FILE} matches the schema` });
  return { config: file.value, findings };
}

/** The plugins this project needs from the base kit, with the reason. */
export function neededPlugins(config) {
  const needed = [{ id: `core@${BASE_MARKETPLACE}`, why: "always" }];
  if (config?.ledger === true) needed.push({ id: `session@${BASE_MARKETPLACE}`, why: "kit.json ledger: true" });
  return needed;
}

/**
 * Findings for enabled plugins and declared marketplaces.
 * @param {string} projectDir @param {Record<string, any> | null} config @param {string} [userDir]
 */
export function checkSettings(projectDir, config, userDir = claudeDir()) {
  const findings = [];
  const shared = readJson(join(projectDir, ".claude", "settings.json"));
  if (shared.error) return [{ level: "fail", text: `.claude/settings.json does not parse: ${shared.error}` }];
  const project = shared.value ?? {};
  const local = readJson(join(projectDir, ".claude", "settings.local.json")).value ?? {};
  const user = readJson(join(userDir, "settings.json")).value ?? {};
  const declared = new Set(Object.keys(project.extraKnownMarketplaces ?? {}));
  const enabledIn = (settings, id) => settings.enabledPlugins?.[id] === true;

  for (const { id, why } of neededPlugins(config)) {
    if (enabledIn(project, id)) findings.push({ level: "ok", text: `${id} enabled in .claude/settings.json` });
    else if (enabledIn(local, id) || enabledIn(user, id)) {
      findings.push({ level: "warn", text: `${id} (${why}) is enabled only for you (${enabledIn(local, id) ? "settings.local.json" : "user settings"}); add it to .claude/settings.json so the project gets it` });
    } else findings.push({ level: "fail", text: `${id} (${why}) is not enabled; add it to enabledPlugins in .claude/settings.json` });
    if (local.enabledPlugins?.[id] === false) {
      findings.push({ level: "warn", text: `${id} is switched off in settings.local.json` });
    }
  }

  const marketplaces = new Set(
    Object.entries(project.enabledPlugins ?? {})
      .filter(([, on]) => on === true)
      .map(([id]) => id.slice(id.lastIndexOf("@") + 1))
      .filter(Boolean),
  );
  marketplaces.add(BASE_MARKETPLACE);
  const overlays = [...marketplaces].filter((name) => name !== BASE_MARKETPLACE);
  for (const name of [...marketplaces].sort()) {
    if (declared.has(name)) findings.push({ level: "ok", text: `marketplace ${name} declared in extraKnownMarketplaces` });
    else {
      const why = name === BASE_MARKETPLACE && overlays.length > 0 ? `; overlay dependencies (${overlays.join(", ")}) resolve only with it (S3a)` : "";
      findings.push({ level: "fail", text: `marketplace ${name} is not declared in .claude/settings.json extraKnownMarketplaces${why}` });
    }
  }
  return findings;
}

export function checkCopies(projectDir) {
  const copies = findKitCopies(projectDir);
  if (copies.length === 0) return [{ level: "ok", text: "no copies of kit-owned files" }];
  return copies.map((copy) => ({
    level: "warn",
    text: `${copy.path} — supplied by ${copy.plugin}${copy.note ? ` (${copy.note})` : ""}`,
  }));
}

export function checkVersions(projectDir, options = {}) {
  const { lagging, checked } = checkUpdates({ root: projectDir, cacheFile: defaultCacheFile(), ...options });
  if (checked.length === 0) return [{ level: "ok", text: "no kit plugins installed from a git marketplace (a --plugin-dir copy is not checked)" }];
  const findings = [];
  for (const item of checked) {
    if (item.latest === null) findings.push({ level: "warn", text: `${item.plugin}@${item.marketplace}: could not read ${item.ref} from the remote` });
    else if (item.latest === item.installed) findings.push({ level: "ok", text: `${item.plugin}@${item.marketplace} (${item.scope}) is at ${item.ref} ${item.installed.slice(0, 12)}` });
  }
  for (const item of lagging) {
    findings.push({
      level: "warn",
      text: `${item.plugin}@${item.marketplace} (${item.scope}): installed ${item.installed.slice(0, 12)}, ${item.ref} is ${item.latest.slice(0, 12)}; run \`${updateCommands(item).join("` then `")}\`, then start a new session`,
    });
  }
  return findings;
}

const MARK = { ok: "ok  ", warn: "WARN", fail: "FAIL" };

/** Run every check and print the report; exit code 1 when anything failed. */
export function runDoctor(projectDir, { offline = false, print = console.log } = {}) {
  const { config, findings: kit } = checkKitJson(projectDir);
  const sections = [
    ["kit.json", kit],
    ["Plugins and marketplaces", checkSettings(projectDir, config)],
    ["Kit-owned files in the repo", checkCopies(projectDir)],
    ["Installed versions", offline ? [{ level: "ok", text: "skipped (--offline)" }] : checkVersions(projectDir)],
  ];
  let failed = false;
  sections.forEach(([title, findings], index) => {
    print(`${index + 1}. ${title}`);
    findings.forEach((finding, n) => {
      if (finding.level === "fail") failed = true;
      print(`   ${index + 1}.${n + 1}. ${MARK[finding.level]} ${finding.text}`);
    });
  });
  return failed ? 1 : 0;
}
