# Changelog

Each `stable` release gets one entry: date, the commit it points at, and what changed per plugin. Work merged after a release goes under `## Unreleased` until the next one.

## Unreleased

- core: `lint-edited-file` takes its root from the checkout that holds the edited file, so a worktree nested under the main checkout (`.claude/worktrees/…`) is linted against its own `kit.json` and globs.
- core: `/check` can be called by the agent as well as the user, and `/check`, `/dev` and the `codegraph` skill pre-allow the `node` command their preamble runs, which the permission check refused before.

## 2026-11-10 — first `stable`

`stable` points at the commit that adds this entry. Pilot: one full SDLC item ran on the kit in a real project with no local overrides.

- Skeleton: marketplace `agent-kit` with plugins `core`, `sdlc`, `session`, `svelte`, `python` (manifests only), `kit.json` v1 schema, shared hook helpers vendored into each plugin, naming guard in CI.
- Docs: architecture, usage, change flow and evolution pages.
- sdlc: `/sdlc-intent`, `/sdlc-plan`, `/sdlc-build`, `/sdlc-finish`, `/sdlc-status`, `sdlc-simplifier` and `sdlc-verifier` agents, `sdlc-kit` helper; paths and commands from `kit.json`, recipe and glossary checks, `sdlc-ext-*` extension points, `session` plugin used when enabled.
- session: ledger hooks (`ledger-stop`, `ledger-brief`, `ledger-shell-deletions`, `ledger-summarize`), `worktree-setup` hook, `git-commit-session` with `commands.commitAudit`, `worktree-flow`, `/handoff`, `/close-out`, `/close-siblings`, `/git` with the `git-ops` agent; paths and branches from `kit.json`.
- core: always-on chat, shell and tooling-limit rules from a SessionStart hook; `check-runner` and `repo-sweep` agents; `/check`, `/dev`, `/kit-doctor`, `/kit-adopt`, `/kit-inventory` and a `codegraph` skill; `lint-edited-file`, `shell-deletions`, `codegraph-sync` and `update-check` hooks, each switchable with `hooks.off`; `count-lines`, `git-branch-context`, `kit` and `kit-docs-parity` commands (docs parity now runs in `npm run check`).
- svelte, python: path-scoped convention skills — `svelte-runes`, `svelte-a11y`, `vitest`, `tailwind-styling`; `python-code`, `python-tests` — with `kit-owned.json` naming the project rule copies they replace.
- Integration: one `kit.json` reader (`shared/kit-config.mjs`, schema defaults and `hooks.off`) and the shell-command parser (`shared/shell-edits.mjs`) vendored into `core`, `sdlc` and `session`; `npm run vendor` also copies the schema into `core`. Schema: `lintOnEdit`, `commands.dev`, `commands.install` (used by `lint-edited-file`, `/core:dev` and the worktree set-up). `session` ships a `kit-owned.json`. Usage docs lead with the explicit update commands.
- Pilot fixes: `lintOnEdit` takes a list of `{ command, match }` rules (one object still works); `kit.json` `checks` adds named suites for `/core:check <suite>`; `session` brings back `/git commit --review` and counts skipped optional steps from `kit.json` `preflight` (`preflight` command); `commands.commitAudit` gets the committed paths through `{files}` as well as `KIT_COMMIT_PATHS`; `kit doctor` lists tests of kit-owned scripts, reads plugins loaded with `--plugin-dir` and checks each loaded plugin's `dependencies`; `session` `kit-owned.json` names `scripts/hooks/worktree-setup-hook.mjs`; `svelte` no longer claims `ui-styling.md`; the root package has an `agent-kit` bin (`agent-kit ledger-scan-secrets`) for git hooks; a test keeps each SessionStart hook's output under the measured 10,000-character cap (spikes S10).
