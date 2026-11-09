# Changelog

Each `stable` release gets one entry: date, the commit it points at, and what changed per plugin.

## Unreleased

- Skeleton: marketplace `agent-kit` with plugins `core`, `sdlc`, `session`, `svelte`, `python` (manifests only), `kit.json` v1 schema, shared hook helpers vendored into each plugin, naming guard in CI.
- Docs: architecture, usage, change flow and evolution pages.
- sdlc: `/sdlc-intent`, `/sdlc-plan`, `/sdlc-build`, `/sdlc-finish`, `/sdlc-status`, `sdlc-simplifier` and `sdlc-verifier` agents, `sdlc-kit` helper; paths and commands from `kit.json`, recipe and glossary checks, `sdlc-ext-*` extension points, `session` plugin used when enabled.
- session: ledger hooks (`ledger-stop`, `ledger-brief`, `ledger-shell-deletions`, `ledger-summarize`), `worktree-setup` hook, `git-commit-session` with `commands.commitAudit`, `worktree-flow`, `/handoff`, `/close-out`, `/close-siblings`, `/git` with the `git-ops` agent; paths and branches from `kit.json`.
- core: always-on chat, shell and tooling-limit rules from a SessionStart hook; `check-runner` and `repo-sweep` agents; `/check`, `/dev`, `/kit-doctor`, `/kit-adopt`, `/kit-inventory` and a `codegraph` skill; `lint-edited-file`, `shell-deletions`, `codegraph-sync` and `update-check` hooks, each switchable with `hooks.off`; `count-lines`, `git-branch-context`, `kit` and `kit-docs-parity` commands (docs parity now runs in `npm run check`).
- svelte, python: path-scoped convention skills — `svelte-runes`, `svelte-a11y`, `vitest`, `tailwind-styling`; `python-code`, `python-tests` — with `kit-owned.json` naming the project rule copies they replace.
- Integration: one `kit.json` reader (`shared/kit-config.mjs`, schema defaults and `hooks.off`) and the shell-command parser (`shared/shell-edits.mjs`) vendored into `core`, `sdlc` and `session`; `npm run vendor` also copies the schema into `core`. Schema: `lintOnEdit`, `commands.dev`, `commands.install` (used by `lint-edited-file`, `/core:dev` and the worktree set-up). `session` ships a `kit-owned.json`. Usage docs lead with the explicit update commands.
