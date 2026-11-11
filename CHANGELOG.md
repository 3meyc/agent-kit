# Changelog

Each `stable` release gets one entry: date, the commit it points at, and what changed per plugin. Work merged after a release goes under `## Unreleased` until the next one.

## Unreleased

- core: `kit doctor --strict` judges the repo, not the machine, and fails on a copy of a kit-owned file (or a test of one), a `kit.json` that fails the schema, or a needed plugin or marketplace missing from the shared `.claude/settings.json`; `settings.local.json` and the user's settings don't count there, and installed versions, install scopes and this session's plugins never fail it. `--plugin-root <path>` (repeatable; a plugin folder or a folder of them) adds plugin folders to read ownership from, such as an overlay's. An unknown flag, or a root with no plugin in it, exits 2.
- root package: `agent-kit doctor [--strict] [--offline] [--plugin-root <path>]...` runs it outside Claude Code, so CI can keep kit-owned copies out with no installed plugins: ownership comes from the plugin folders in the package (docs/using.md § 2).

## 2026-11-11 — fifth `stable`

`stable` points at the commit that adds this entry. A false "behind" report for plugins with a source of their own.

- core: the version check follows a plugin's own repository and ref when its catalog entry names one (a `github` or `url` source), and a commit the entry pins with `sha`. It compared such plugins with the marketplace repository's ref, so `kit doctor` and the SessionStart note reported a current plugin as behind.

## 2026-11-11 — fourth `stable`

`stable` points at the commit that adds this entry. Project-scope installs that ran old kit copies (F46).

- core: kit plugins are installed at user scope only; a project declares the marketplace and enables the plugins (F46). A session loads the first install record that applies to its folder, a project-scope record applies in every worktree of its repository, and Claude Code 2.1.321 writes such a record per folder by itself, so an old project copy could run, or take the update, while the user copy stayed behind (docs/spikes.md S11). The SessionStart note and `kit doctor` now name the copy a session loads, update commands say `--scope user`, and `kit doctor` reports each project-scope copy of the repository that differs from the user copy or the channel, and counts those elsewhere. New `kit installs [--clean]` lists the stale project-scope copies on the machine and uninstalls them from their folders, putting each folder's `.claude/settings.json` back as it was (the CLI's uninstall drops the plugin from it). `docs/using.md` § 1 and § 3 and `/kit-adopt` say how to install and update, and why.

## 2026-11-11 — third `stable`

`stable` points at the commit that adds this entry. Gaps from the rollout after the second `stable`.

- core: `kit doctor` and `kit update-check` read each marketplace's ref from the remote every time instead of trusting the six-hour cache, which had reported plugins behind `stable` as current; a result that could only come from the cache says so and is a warning. Outside a hook the cache now lives in `plugins/data/core-agent-kit/`, the folder the SessionStart check uses (it was `agent-kit-core/`, so the two disagreed).
- core: the version check compares against the ref the project declares in `extraKnownMarketplaces` (else the registered one), and `kit doctor` (so also `/kit-adopt`) warns when this machine registered the marketplace, or the user's own `settings.json` declares it, at another ref, with the fix. The SessionStart notice says when the update commands alone won't reach the declared ref.
- docs: `using.md` § 3 explains the refused `marketplace add …#stable` when the user's settings declare the marketplace without a `ref`, and that each plugin then needs `claude plugin update` at user scope and per project-scope install.
- sdlc: `/sdlc-status` is read-only, so the agent may run it too (a delegated session could not).
- session: the ledger brief's "Left owed" items lead with their record id (`a5a5a5a5 #2`), so items of several records no longer read as one list whose numbering restarts.
- session: `git-commit-session` prints a `session record:` line for the record it commits, new or updated, and `session-ledger --record` says where a missing record comes from; `git-ops` counts the staged files from the commit, record included.
- core: the chat-output rules ask for a plain-words summary of what changed and why, and for runnable commands in fenced blocks rather than inline backticks.

## 2026-11-10 — second `stable`

`stable` points at the commit that adds this entry. Fixes from the pilot's review and from the first rollout to three more projects.

- core: `lint-edited-file` takes its root from the checkout that holds the edited file, so a worktree nested under the main checkout (`.claude/worktrees/…`) is linted against its own `kit.json` and globs.
- core: `/check` can be called by the agent as well as the user, and `/check`, `/dev` and the `codegraph` skill pre-allow the `node` command their preamble runs, which the permission check refused before.
- core: `/sweep <question>` answers a read-only question across many files in the `repo-sweep` agent and returns a verdict.
- core, session: a package binary run through `npx`, `pnpx`, `bunx`, `pnpm exec`/`dlx` or `yarn dlx` with no handler that knows it counts as opaque, so the ledger credits the files it writes by the run window (before, a generated file such as an RTK filter file stayed unattributed and `git-commit-session --worktree` refused).
- core: a `kit-owned.json` entry `<file>#<key.path>` claims one key of a JSON file (`.mcp.json#mcpServers.<name>`), so `kit doctor` no longer flags a project file that holds only the project's own keys.
- core: `kit doctor` and `/kit-adopt` count an installed or sibling plugin's files only when the project enables that plugin or one that depends on it (before, the `python` plugin claimed `.claude/rules/python.md` in projects that never enabled it).
- core: `/kit-adopt` names the project after its `origin` repository, else the main checkout's folder, not a linked worktree's generated folder name.
- core: the chat-language rule yields to a reply language the project's `CLAUDE.md` or `AGENTS.md` sets.
- session: `/close-out` and `/close-siblings` run the project's `session-ext-close-out` skills before landing; `/close-siblings` offers to delete the merged sub-session branches with `git branch -d`.
- session, schema: `commands.commitMessage` checks a new commit message before `git-commit-session` commits; a non-zero exit refuses it with exit 9.

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
