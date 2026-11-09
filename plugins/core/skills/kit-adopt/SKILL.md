---
name: kit-adopt
description: Put the current project on agent-kit — a starter kit.json, the kit marketplaces and plugins in .claude/settings.json, and a list of local files the kit now supplies. Dry run first; writes only after the user agrees, and deletes nothing.
argument-hint: "[--plugins core,session,sdlc] [--overlay name=owner/repo#ref --overlay-plugin plugin@name]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

1. Dry run from the repo root, passing the arguments through:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" adopt $ARGUMENTS
   ```

2. Show the user what it would write (the starter `kit.json`, the settings keys it adds) and the kit-owned local files it lists. Point out guesses they should check: `project`, `baseBranch`, the commands taken from `package.json`, `ledger: false`.
3. Ask before writing. On their yes, run the same command with `--write` added.
4. After writing: run `node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" doctor --offline` and report what is still open. The listed kit-owned files stay in place: retiring each one (and any project hook entry that runs a kit-owned script) is a separate change the user decides on, after checking that the kit version covers what the local copy did.

An overlay kit needs both marketplaces declared (`--overlay name=owner/repo#ref` adds the overlay next to the base) and its plugins named with `--overlay-plugin plugin@name`.
