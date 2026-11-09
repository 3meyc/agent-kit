# Changelog

Each `stable` release gets one entry: date, the commit it points at, and what changed per plugin.

## Unreleased

- Skeleton: marketplace `agent-kit` with plugins `core`, `sdlc`, `session`, `svelte`, `python` (manifests only), `kit.json` v1 schema, shared hook helpers vendored into each plugin, naming guard in CI.
- Docs: architecture, usage, change flow and evolution pages.
- session: ledger hooks (`ledger-stop`, `ledger-brief`, `ledger-shell-deletions`, `ledger-summarize`), `worktree-setup` hook, `git-commit-session` with `commands.commitAudit`, `worktree-flow`, `/handoff`, `/close-out`, `/close-siblings`, `/git` with the `git-ops` agent; paths and branches from `kit.json`.
