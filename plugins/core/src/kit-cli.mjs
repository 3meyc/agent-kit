// `kit <command>`: the core plugin's command line, on the Bash PATH through bin/kit. Skills call
// it as `node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" …`, which needs no PATH.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectRun, projectRoot } from "../lib/hook-utils.mjs";
import { runAdopt } from "./adopt.mjs";
import { runDoctor } from "./doctor.mjs";
import { runInventory } from "./inventory.mjs";
import { readKit } from "../lib/kit-config.mjs";
import { checkUpdates, defaultCacheFile, updateCommands } from "./update-check.mjs";

const USAGE = `Usage: kit <command>

  doctor [--offline] [--plugin-dir <path>]...
                       Check kit.json, enabled and --plugin-dir plugins, marketplaces, kit-owned copies
                       and their tests, installed versions (KIT_PLUGIN_DIRS adds plugin folders too)
  update-check         Installed kit plugins against their marketplace ref, with the update commands
  adopt [--write] [--plugins core,session] [--base owner/repo#ref]
        [--overlay name=owner/repo#ref] [--overlay-plugin plugin@marketplace]
                       Starter kit.json, marketplaces and plugins in .claude/settings.json, kit-owned files (dry run unless --write)
  inventory [--out dir] [--config file]
                       Agent tooling across the repos in ~/.config/agent-kit/inventory.json
  drift [--out dir] [--config file]
                       Changed lines of drifting copies against the reference repo
  commands             The project's kit.json commands and check suites
  dev                  The dev server port and the matching .claude/launch.json configuration`;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function printCommands(root, print = console.log) {
  const kit = readKit(root);
  if (kit.error) {
    print(`${kit.error}: fix it before running project commands (\`kit doctor\` shows what is wrong).`);
    return 0;
  }
  if (!kit.found) {
    print("No kit.json at the repo root: there are no project commands to run. `/kit-adopt` writes a starter.");
    return 0;
  }
  const commands = Object.entries(kit.commands);
  const suites = Object.entries(kit.checks);
  if (commands.length === 0 && suites.length === 0) {
    print("kit.json defines no commands and no check suites.");
    return 0;
  }
  if (commands.length === 0) print("kit.json defines no commands.");
  commands.forEach(([name, value], index) => print(`${index + 1}. ${name}: \`${value}\``));
  if (suites.length === 0) return 0;
  print("");
  print("Check suites (kit.json checks), each run in order by `/core:check <suite>`:");
  suites.forEach(([name, list], index) => {
    print(`${index + 1}. ${name}:`);
    list.forEach((command, n) => print(`   ${index + 1}.${n + 1}. \`${command}\``));
  });
  return 0;
}

export function printDev(root, print = console.log) {
  const kit = readKit(root);
  const port = kit.devServer?.port;
  const launch = readJson(join(root, ".claude", "launch.json"));
  const configurations = Array.isArray(launch?.configurations) ? launch.configurations : [];
  if (kit.commands.dev) print(`commands.dev: \`${kit.commands.dev}\``);
  if (!Number.isInteger(port)) {
    print("kit.json sets no devServer.port.");
    if (configurations.length > 0) {
      print(`.claude/launch.json configurations: ${configurations.map((entry) => `${entry.name} (port ${entry.port ?? "?"})`).join(", ")}`);
    }
    return 0;
  }
  const match = configurations.find((entry) => entry?.port === port);
  if (match) {
    const command = [match.runtimeExecutable, ...(match.runtimeArgs ?? [])].filter(Boolean).join(" ");
    print(`devServer.port: ${port}`);
    print(`launch configuration: name "${match.name}"${command ? `, command \`${command}\`` : ""}`);
  } else {
    print(`devServer.port: ${port}`);
    print(`No .claude/launch.json configuration has port ${port}.`);
  }
  return 0;
}

function printUpdates(root, print = console.log) {
  const { lagging, checked } = checkUpdates({ root, cacheFile: defaultCacheFile(), fresh: true });
  if (checked.length === 0) {
    print("No kit plugins installed from a git marketplace for this project.");
    return 0;
  }
  const unread = checked.filter((item) => item.from !== "remote");
  if (unread.length > 0) {
    print(`Could not read the remote for ${[...new Set(unread.map((item) => item.marketplace))].join(", ")}; those results ${unread.some((item) => item.from === "cache") ? "come from the cache" : "are missing"}.`);
  }
  if (lagging.length === 0) {
    print(`All ${checked.length - unread.filter((item) => item.latest === null).length} checked kit plugin install(s) match their channel's ref.`);
    return 0;
  }
  for (const item of lagging) {
    print(`${item.plugin}@${item.marketplace} (${item.scope}): installed ${item.installed.slice(0, 12)}, ${item.ref} is ${item.latest.slice(0, 12)}${item.from === "cache" ? " (cached)" : ""}`);
    for (const command of updateCommands(item)) print(`  ${command}`);
  }
  return 0;
}

/** Every value of a repeatable `--flag <value>` or `--flag=<value>`. @param {string[]} args @param {string} flag */
export function optionValues(args, flag) {
  const values = [];
  args.forEach((arg, index) => {
    if (arg === flag && args[index + 1]) values.push(args[index + 1]);
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  });
  return values;
}

/** @param {string[]} argv */
export function main(argv) {
  const [command, ...args] = argv;
  const root = projectRoot();
  switch (command) {
    case "doctor":
      return runDoctor(root, { offline: args.includes("--offline"), pluginDirs: optionValues(args, "--plugin-dir") });
    case "update-check":
      return printUpdates(root);
    case "adopt":
      return runAdopt(root, args);
    case "inventory":
    case "drift":
      return runInventory(command, args);
    case "commands":
      return printCommands(root);
    case "dev":
      return printDev(root);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    default:
      console.error(`kit: unknown command ${command}\n\n${USAGE}`);
      return 1;
  }
}

// Run directly (`node src/kit-cli.mjs …`), as the skills do; bin/kit imports `main` instead.
if (isDirectRun(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
