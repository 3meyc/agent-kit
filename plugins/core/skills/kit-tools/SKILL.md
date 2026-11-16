---
name: kit-tools
description: Install and set up the machine tools the kit's hooks use — rtk, CodeGraph, Fallow — at the kit's pinned versions, clear old copies of them, and offer a CodeGraph index for the repo. Use when the session-start note says a tool is missing or off its pin, or when the user asks to install or update rtk, CodeGraph or Fallow.
---

1. See what is missing or off its pin (installs nothing):

   ```bash
   kit tools --check
   ```

   No output means every tool is at its pin: say so and stop.

2. Ask the user which to install, with one multi-select question listing each tool the check
   named, every one selected by default, each with its one-line purpose from the plan below.
   Installing is their call: never install without that answer.

   | Tool | What it does for the kit |
   | --- | --- |
   | rtk | Compresses shell output before it reaches the agent (core's `rtk-rewrite` hook) |
   | codegraph | Code graph for symbol and impact questions (core's codegraph hooks and skill) |
   | fallow | Dead-code, duplication and doc-freshness audits for JavaScript and TypeScript |

   If CodeGraph will be installed or is already there and the repo has no `.codegraph/` folder,
   ask in the same question whether to index this repo (`codegraph init`), selected by default.

3. Run one command with their answer (`--index` only when they chose to index):

   ```bash
   kit tools --yes --only rtk,codegraph --index
   ```

   It downloads rtk's release asset and checks its sha256, runs `npm install -g` for CodeGraph and
   Fallow, removes old `.old`/`.bak` copies and stale package-manager copies, clears stale
   project-scope plugin copies, and checks that the shell runs each pinned copy.

4. Report each tool's last line (`ok`, `skip` or `FAIL`), quoting a `FAIL` with its fix. A tool
   placed in a folder that is not on PATH needs a new shell after the user adds it; say so. Where
   `~/.claude/settings.json` still runs `rtk hook claude` or `codegraph prompt-hook` itself, tell
   the user core runs both now and the entries can go (editing that file is the user's step).

(`kit` is on the Bash PATH while the plugin is enabled; outside a session the same command is
`node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" tools`, or `npx github:3meyc/agent-kit#stable tools` in a
plain terminal, where it asks before each install itself.)
