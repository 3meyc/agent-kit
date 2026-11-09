#!/usr/bin/env node
// `agent-kit <command>`: the kit commands a git hook or CI job needs where Claude Code's plugin
// `bin/` folders are not on PATH. A project adds this repo as a dev dependency
// (`github:3meyc/agent-kit#<ref>`) and calls, for example, `agent-kit ledger-scan-secrets` from
// lefthook. Each command runs the same script the plugin ships, so both stay one implementation.
import { main as scanLedgerSecrets } from "../plugins/session/scripts/scan-ledger-secrets.mjs";

const USAGE = `Usage: agent-kit <command>

  ledger-scan-secrets [<path>...]
        Fail when a staged ledger record holds secret-shaped text (session plugin's scanner).
        Without paths: the staged files in kit.json paths.ledger.`;

/** @type {Record<string, (args: string[]) => number>} */
export const COMMANDS = {
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
