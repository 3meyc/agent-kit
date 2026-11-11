#!/usr/bin/env node
// `agent-kit <command>`: the kit commands a git hook or CI job needs where Claude Code's plugin
// `bin/` folders are not on PATH. A project adds this repo as a dev dependency
// (`github:3meyc/agent-kit#<ref>`) and calls, for example, `agent-kit ledger-scan-secrets` from
// lefthook. Each command runs the same script the plugin ships, so both stay one implementation.
// `agent-kit doctor --strict` runs in CI with no Claude Code and no installed plugins: it reads
// ownership from the plugin folders in this package and from each `--plugin-root`.
import { doctorCommand } from "../plugins/core/src/kit-cli.mjs";
import { main as scanLedgerSecrets } from "../plugins/session/scripts/scan-ledger-secrets.mjs";

const USAGE = `Usage: agent-kit <command>

  doctor [--strict] [--offline] [--plugin-root <path>]... [--plugin-dir <path>]...
        The core plugin's \`kit doctor\` for the repo at the current git top level. --strict judges
        repo state only (kit.json against the schema, the needed plugins enabled and their
        marketplaces declared in .claude/settings.json, no copy of a kit-owned file) and exits 1
        on a finding; installed versions and install scopes never fail it. --offline skips the
        remote version check. --plugin-root adds a plugin folder, or a folder of plugin folders,
        to read kit-owned files from (an overlay's plugins); repeatable.
  ledger-scan-secrets [<path>...]
        Fail when a staged ledger record holds secret-shaped text (session plugin's scanner).
        Without paths: the staged files in kit.json paths.ledger.`;

/** @type {Record<string, (args: string[]) => number>} */
export const COMMANDS = {
  doctor: (args) => doctorCommand(args),
  "ledger-scan-secrets": (args) => scanLedgerSecrets(args),
};

const [command, ...args] = process.argv.slice(2);
if (command && Object.hasOwn(COMMANDS, command)) {
  process.exitCode = COMMANDS[command](args);
} else if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exitCode = command === undefined ? 1 : 0;
} else {
  console.error(`agent-kit: unknown command ${command}\n\n${USAGE}`);
  process.exitCode = 1;
}
