---
name: codegraph
description: How to use the CodeGraph CLI in a repo that has a .codegraph/ index — impact checks before changing a shared symbol, and orienting by symbol or file name. Use before renaming or changing the signature of a symbol used across files, when a .codegraph/ folder exists at the repo root.
---

Index here: !`node "${CLAUDE_PLUGIN_ROOT}/src/codegraph-present.mjs"`

Applies only where the repo root has a `.codegraph/` folder and the `codegraph` CLI is installed (a machine install, not part of the kit). When the line above says either is missing, stop here: use grep and reads, and do not mention CodeGraph to the user.

The core plugin's `codegraph-sync` hook syncs a linked worktree's own index before each reading `codegraph` command, so a query in a worktree sees the session's edits. Do not run `codegraph sync` or `codegraph status` yourself for that.

1. **Before changing a shared symbol** (rename, signature, a helper used across features): run `codegraph impact <symbol>`; it lists transitive dependents, which grep cannot. It does **not** see a member read as `obj.prop` (a store or class member, in code or in template markup): for a member, also grep `\.<member>\b`, and record both results.
2. **Orienting:** `codegraph explore` with symbol or file names, not a sentence. For a name you already know, grep or `codegraph callers <symbol>` is cheaper.
3. If a query answers with unrelated symbols, the index may be stale or built for another tree: say so and fall back to grep rather than trusting it.
