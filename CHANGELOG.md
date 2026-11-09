# Changelog

Each `stable` release gets one entry: date, the commit it points at, and what changed per plugin.

## Unreleased

- Skeleton: marketplace `agent-kit` with plugins `core`, `sdlc`, `session`, `svelte`, `python` (manifests only), `kit.json` v1 schema, shared hook helpers vendored into each plugin, naming guard in CI.
- Docs: architecture, usage, change flow and evolution pages.
- core: always-on chat, shell and tooling-limit rules from a SessionStart hook; `check-runner` and `repo-sweep` agents; `/check`, `/dev`, `/kit-doctor`, `/kit-adopt`, `/kit-inventory` and a `codegraph` skill; `lint-edited-file`, `shell-deletions`, `codegraph-sync` and `update-check` hooks, each switchable with `hooks.off`; `count-lines`, `git-branch-context`, `kit` and `kit-docs-parity` commands (docs parity now runs in `npm run check`).
