# core

**English** · [Українська](README.uk.md)

The base plugin every other agent-kit plugin depends on: always-on chat and shell rules, the check
and sweep agents, edit and shell hooks, and the commands that put a project on the kit and keep it
there. Everything is read from the project's `kit.json`; nothing project-specific lives here.

## Always-on rules

A `SessionStart` hook prints [rules/always-on.md](rules/always-on.md), which Claude Code renders
into the session as context (no copy in the project). It holds:

1. **Chat output**: length, formatting, runnable command blocks, reporting what was not verified.
2. **Shell per OS**: detect the shell first, PowerShell pitfalls, the kit's portable `count-lines`
   and `git-branch-context`.
3. **Tooling limits**: what to do when a tool refuses, plus the generic limits (desktop-app base
   sync, auto-mode classifier, kit hooks, machine tools, CI). A project keeps its own limits in a
   rule of its own.

## Hooks

Plugins can't be switched off hook by hook, so each hook reads `kit.json` `hooks.off` and exits
quietly when its id is listed.

| ID | Hook id | Event | Does | Does nothing when |
| --- | --- | --- | --- | --- |
| 1 | `rules` | SessionStart | Prints the always-on rules | listed in `hooks.off` |
| 2 | `update-check` | SessionStart | One short note when the kit plugin copy this session loads, or the user-scope copy, differs from its channel (the project's declared marketplace ref, else the registered one; for a plugin whose catalog entry names its own repository, that repository's ref), with the update commands at `--scope user` and, for a project-scope copy, `kit installs --clean`; remote SHAs cached for six hours (`kit doctor` and `kit update-check` read the remote every time) | nothing lags, the remote is unreachable, or the session restarted after a compaction |
| 3 | `lint-edited-file` | PostToolUse Edit, Write, MultiEdit | Runs every `lintOnEdit` rule whose globs match the edited file, in order; any failure is shown to the agent (exit 2) without undoing the edit | no `lintOnEdit`, or the file matches no rule |
| 4 | `shell-deletions` | PreToolUse and PostToolUse Bash, PowerShell | Snapshots tracked files a script-running command deletes, for the session ledger | `ledger` is not `true`, or the command runs no script |
| 5 | `codegraph-sync` | PreToolUse Bash, PowerShell, CodeGraph MCP tools | Syncs a linked worktree's own CodeGraph index before a query reads it | no `.codegraph/codegraph.db` in the worktree, or no `codegraph` CLI |

Hooks 4 and 5 share one PreToolUse process for shell calls (`hooks/shell-pre.mjs`), so a shell
call starts one `node`, not two. No hook ever blocks a tool call; a failure is one stderr line.

## Commands

| ID | Command | Does |
| --- | --- | --- |
| 1 | `/core:check [<command> \| all]` | Runs `kit.json` `commands.*` in the Haiku agent `check-runner`, which reports only failures. Empty: `check`, `lint`, `test` |
| 2 | `/core:dev` | Starts the dev server on `devServer.port` through the matching `.claude/launch.json` entry, in the desktop app's Browser pane |
| 3 | `/core:kit-doctor` | Checks `kit.json` against the schema, the needed plugins, both marketplaces declared and registered at the declared ref, enabled plugins installed on this machine, a nested worktree whose outer checkout's `.claude/` differs, kit-owned copies, the installed versions of the project's plugins against the remote |
| 4 | `/core:kit-adopt` | Drafts `kit.json`, declares marketplaces and plugins in `.claude/settings.json`, lists local files the kit now supplies; dry run first, deletes nothing |
| 5 | `/core:kit-inventory [--out <dir>]` | Inventories agent tooling across your local repos and measures drift between copies |
| 6 | `/core:sweep <question>` | Answers a read-only question across many files in the Haiku agent `repo-sweep` and returns a verdict, not excerpts |
| 7 | `codegraph` skill | How to use the CodeGraph CLI (impact before changing a shared symbol; grep members read as `obj.prop`). Applies only where `.codegraph/` exists |

The docs say the bare names (`/check`, `/dev`, …) work too while no other command has them
_(unverified here)_. Agents:
`check-runner` (runs check commands, reports failures only) and `repo-sweep` (multi-file
read-only sweeps that return a verdict).

## Shell commands

On the Bash tool's PATH while the plugin is enabled:

| ID | Command | Does |
| --- | --- | --- |
| 1 | `count-lines <file>...` | Line counts, the same on every OS |
| 2 | `git-branch-context` | Branch, upstream, default base and `kit.json` `baseBranch` as JSON |
| 3 | `kit doctor \| adopt \| inventory \| drift \| update-check \| installs \| commands \| dev` | The commands behind the skills above; `kit installs [--clean]` lists the project-scope copies of kit plugins that differ from the user copy or the channel, and clears them ([using](../../docs/using.md) § 3) |
| 4 | `kit-docs-parity [path...]` | Checks that each `name.md` / `name.uk.md` pair keeps the same headings, tables, Mermaid blocks, command blocks and numbered items |

Skills call `node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" …`, which needs no PATH.

## kit.json fields read

| ID | Field | Read by |
| --- | --- | --- |
| 1 | `commands.check`, `lint`, `test`, `build`, and the `checks` suites | `/core:check` (never `commit`, `land` or `commitAudit`); `/core:check <suite>` runs one suite |
| 2 | `devServer.port`, `commands.dev` | `/core:dev` |
| 3 | `hooks.off` | every hook (ids above) |
| 4 | `ledger` | `shell-deletions` (runs only when `true`); `kit doctor` (then expects `session`) |
| 5 | `baseBranch` | `git-branch-context` |
| 6 | `lintOnEdit` | `lint-edited-file` |
| 7 | the whole file | `kit doctor` validates it against the schema shipped in `schema/` |

`lintOnEdit` takes one rule, or a list of rules so different files get different checks. A rule
is a command and optional globs; `{file}` is replaced by the quoted repo-relative path, or the path
is appended. A glob without `/` matches the file name anywhere. Every rule that matches runs, and
one failing does not stop the next. `checks` names suites of commands for `/core:check <suite>`;
a suite name may not repeat a `commands` key or `all`, and `/core:check` with no name runs `check`,
`lint` and `test` as before.

```json
{
  "lintOnEdit": [
    { "command": "pnpm exec eslint --no-warn-ignored {file}", "match": ["src/**/*.ts", "src/**/*.svelte"] },
    { "command": "pnpm run i18n:check", "match": ["src/locales/*.json"] }
  ],
  "checks": { "i18n": ["pnpm run i18n:check", "pnpm run i18n:parity"], "docs": ["pnpm run docs:check"] }
}
```

## Inventory repo list

`/core:kit-inventory` reads the repos from your own configuration, never from the kit:
`~/.config/agent-kit/inventory.json` (or under `$XDG_CONFIG_HOME`). `reference` is the copy drift
is measured against; `extraRoots` and `extraFiles` add folders and files to scan.

```json
{ "repos": { "app": "~/code/my-app", "api": "~/code/my-api" }, "reference": "app", "extraFiles": ["lefthook.yml"] }
```

## Retiring project copies

A project that had its own copies of these files keeps them until someone retires them: `kit
doctor` and `/core:kit-adopt` list each one. Kit-owned files are named in
[kit-owned.json](kit-owned.json), plus every agent and skill of the plugin. Another plugin or an
overlay can ship its own `kit-owned.json`. An entry `<file>#<key.path>` claims one key of a JSON
file (`.mcp.json#mcpServers.<name>`), so the project keeps its own keys there. Doctor also lists the tests of kit-owned scripts, so they
go with the script: a `*.test.*` or `*.spec.*` file beside a listed script with the same name, or
one that imports it, even after the script itself is gone. It reads ownership from the plugins
installed for the project and from those this session loaded with `--plugin-dir` (read from the
running `claude` command line, _unverified_ beyond macOS and Linux; `KIT_PLUGIN_DIRS` or `kit doctor
--plugin-dir <path>` name them by hand), and warns when an enabled or loaded plugin's
`dependencies` are neither enabled nor loaded.
