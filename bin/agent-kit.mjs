#!/usr/bin/env node
// `agent-kit <command>`: the kit commands a git hook or CI job needs where Claude Code's plugin
// `bin/` folders are not on PATH. A project adds this repo as a dev dependency
// (`github:3meyc/agent-kit#<ref>`) and calls, for example, `agent-kit ledger-scan-secrets` from
// lefthook. Each command runs the same script the plugin ships, so both stay one implementation.
// `agent-kit doctor --strict` runs in CI with no Claude Code and no installed plugins: it reads
// ownership from the plugin folders in this package and from each `--plugin-root`.
import { runFleet } from "../plugins/core/src/fleet.mjs";
import { devCommand, doctorCommand, releaseCommand } from "../plugins/core/src/kit-cli.mjs";
import { main as scanLedgerSecrets } from "../plugins/session/scripts/scan-ledger-secrets.mjs";

const USAGE = `Usage: agent-kit <command>

  doctor [--strict] [--offline] [--plugin-root <path>]... [--plugin-dir <path>]...
        The core plugin's \`kit doctor\` for the repo at the current git top level. --strict judges
        repo state only (kit.json against the schema, the needed plugins enabled and their
        marketplaces declared in .claude/settings.json, no copy of a kit-owned file) and exits 1
        on a finding; installed versions and install scopes never fail it. --offline skips the
        remote version check. --plugin-root adds a plugin folder, or a folder of plugin folders,
        to read kit-owned files from (an overlay's plugins); repeatable.
  release [--yes] [--summary <text>] [--summary-<lang> <text>]
        The core plugin's \`kit release\` for a kit repo (the git checkout holding the current
        directory): moves ## Unreleased (or adds a release-table row), runs the check, commits
        chore(release): <nth> stable release, pushes, moves the stable tag and reads the remote
        back. A dry run unless --yes. kit.json release sets the notes, the check and an overlay's
        base-kit release (docs/changing.md, Releasing).
  dev [--checkout <marketplace>=<path>]... [--config <file>] [--run] [-- <claude args>]
        The core plugin's \`kit dev\` for the project at the current git top level: prints the
        \`claude --plugin-dir …\` command that loads its enabled kit plugins, and their
        dependencies, from local kit checkouts (~/.config/agent-kit/checkouts.json, or
        --checkout); --run starts it. Warns on a dirty checkout, one off its base branch, and a
        plugin with no checkout (docs/changing.md, step 3).
  fleet --source github --list <file> [--repo [name=]owner/repo[#branch]]... [--kit owner/repo[#ref]]...
        [--out <dir>] [--json]
        The core plugin's \`kit fleet\`: reads each listed repo (default branch, or the branch its
        entry names) and each kit at its stable ref through the GitHub API, with the token in
        KIT_FLEET_TOKEN, GH_TOKEN or GITHUB_TOKEN (KIT_FLEET_TOKENS: owner=token lines). Reports kit-owned copies, kit marketplace refs,
        lockfile pins against each kit's stable commit and drift of shared agent-tooling files, as
        Markdown (--json for JSON; --out writes both). Exit 1 on findings, 2 on a usage error.
        The reusable workflow .github/workflows/kit-fleet.yml runs it weekly (docs/using.md § 5).
  ledger-scan-secrets [<path>...]
        Fail when a staged ledger record holds secret-shaped text (session plugin's scanner).
        Without paths: the staged files in kit.json paths.ledger.`;

/** @type {Record<string, (args: string[]) => number | Promise<number>>} */
export const COMMANDS = {
  doctor: (args) => doctorCommand(args),
  release: (args) => releaseCommand(args),
  dev: (args) => devCommand(args),
  fleet: (args) => runFleet(args),
  "ledger-scan-secrets": (args) => scanLedgerSecrets(args),
};

const [command, ...args] = process.argv.slice(2);
if (command && Object.hasOwn(COMMANDS, command)) {
  Promise.resolve(COMMANDS[command](args)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`agent-kit ${command}: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 2;
    },
  );
} else if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exitCode = command === undefined ? 1 : 0;
} else {
  console.error(`agent-kit: unknown command ${command}\n\n${USAGE}`);
  process.exitCode = 1;
}
