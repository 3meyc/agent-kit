---
name: kit-inventory
description: Inventory agent tooling (rules, skills, agents, commands, hook scripts) across the local repos listed in ~/.config/agent-kit/inventory.json and measure how far copies drifted apart. Use when planning what moves into a kit or checking drift between projects.
argument-hint: "[--out <dir>]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

1. Run the inventory, then the drift measure, from any folder (pass `--out <dir>` from the arguments to both when given; it writes `inventory.json`, `summary.txt`, `diffsize.txt` and `diffgroup.txt` there):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" inventory
   ```

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" drift
   ```

2. If the first says there is no repo list, show the user where it goes and its shape, and stop. The list is the user's configuration; never write it without their say-so, and never put repo names or paths into the kit:

   ```json
   { "repos": { "app": "~/code/my-app", "api": "~/code/my-api" }, "reference": "app" }
   ```

3. Report, numbered:
   1. Groups present in every repo and identical: candidates to move into a kit as they are.
   2. Groups that drifted: which copy is newest, and the changed-line size per repo from the drift run. Large drift means a merge, not a copy.
   3. Groups found in one repo only: project-specific unless the user says otherwise.
   4. Groups already marked `kit:<plugin>`: copies a kit now supplies, to retire after `kit doctor`.

Do not paste the raw summary; quote at most three lines of it.
