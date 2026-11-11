# session plugin

**English** · [Українська](README.uk.md)

The session side of the kit: a ledger record per Claude Code session, hand-off and close-out
commands, commits that take only one session's files in a shared working tree, and the worktree
flow from set-up to landing. Depends on `core`.

## What it does

| ID | Part | What it does |
| --- | --- | --- |
| 1 | Session ledger | At every Stop, writes one Markdown record per session (intent, decisions, next, files touched) into the ledger folder and rebuilds its `INDEX.md`. At session start, puts a short brief of recent records and owed work into context, leaving out owed items that an auto-close rule settled ([using § 6](../../docs/using.md#6-keep-the-ledgers-next-list-short)) |
| 2 | Commit script | `git-commit-session` commits only this session's paths with `git commit --only`, stops when another session claims a path, adds a `Session-Id` trailer, runs the project's commit audit on the committed paths, and counts the project's skipped optional steps (`preflight`) |
| 3 | Worktree flow | `worktree-flow` shows every worktree's base and verdict, predicts conflicts, lands a branch on its base by fast-forward only, and removes merged worktrees. A SessionStart hook prepares each new linked worktree |
| 4 | Commands | `/handoff` writes the record mid-task; `/close-out` sorts the work, lands it and writes the session resume; `/close-siblings` lands the side sessions' work; `/git` runs git chores in the `git-ops` agent, and `/git commit --review` reviews the diff before committing |
| 5 | Evolution pages | `process-evolution.md` and `features-evolution.md` in `paths.evolution`: one Mermaid flowchart each of how the way of working and the features grew, with a Sources table. `evolution` starts, lists what is missing, bumps and checks them. They are brought up to date once per release, from the changelog's `## Unreleased` lines and the process commits since the last release tag, through the `evolution` skill; core's `kit release` dry run names a page the release has not updated |

Commands are namespaced by Claude Code as `/session:handoff`, `/session:close-out`,
`/session:close-siblings` and `/session:git`; the agent is `session:git-ops`. The short form
(`/handoff`) works while no other command has the same name.

A project adds its own close-out steps (a status check of its clones, rows in its own log) as a
skill named `session-ext-close-out` or `session-ext-close-out-<name>`: `/close-out` and
`/close-siblings` load every such skill listed in the session, in name order, before landing.

## Hook ids

Claude Code cannot switch off one hook of a plugin, so every hook here reads `kit.json`
`hooks.off` and exits 0 without doing anything when its id is listed. The ledger hooks also stay
quiet unless `kit.json` sets `"ledger": true`.

| ID | Hook id | Event | Needs `"ledger": true` | What it does |
| --- | --- | --- | --- | --- |
| 1 | `ledger-stop` | Stop | yes | Writes the session's record and `INDEX.md` |
| 2 | `ledger-brief` | SessionStart | yes | Prints the brief of recent records into the session's context, then the record rules (also with an empty ledger) |
| 3 | `ledger-shell-deletions` | PreToolUse, PostToolUse (Bash, PowerShell) | yes | Snapshots tracked files a script deletes, so the record credits the deletion |
| 4 | `ledger-summarize` | (spawned by `ledger-stop`) | yes | Fills a record nobody wrote with a cheap model through `claude -p`. Spends tokens; list it to turn it off, or set `LEDGER_NO_SUMMARY=1` |
| 5 | `worktree-setup` | SessionStart | no | In a new linked worktree: installs dependencies (`commands.install`, else pnpm or npm from the lockfile), builds a CodeGraph index when the main checkout has one, trusts RTK filters already trusted elsewhere. Each step is skipped when its tool is not installed |

```json
{ "hooks": { "off": ["ledger-summarize", "worktree-setup"] } }
```

## kit.json fields it reads

| ID | Field | Default | Used by |
| --- | --- | --- | --- |
| 1 | `ledger` | `false` | Every ledger hook; `session-ledger` writes no record without it |
| 2 | `paths.ledger` | `.claude/ledger` | Where records, `INDEX.md` and `archive/` live |
| 3 | `paths.sdlc` | `docs/sdlc` | `worktree-flow` reads an item's `base:` from `<item>/intent.md`; `git-commit-session --worktree` accepts renames inside it as the session's |
| 4 | `paths.recipes` | `docs/recipes` | `/close-out` and `/handoff` name areas by recipe |
| 5 | `baseBranch` | `main` | `worktree-flow` prefers it when guessing a base; `/git branch` cuts from it |
| 6 | `itemPrefix` | none | `/git branch <ITEM-ID>` and commit footers |
| 7 | `commands.commitAudit` | none | Run after each commit that holds code; its output is shown, never its exit code. `{files}` in it becomes the committed paths, quoted; they are also in `KIT_COMMIT_PATHS`, one per line, so the audit can report only findings in them |
| 8 | `commands.check`, `lint`, `test`, `build` | none | The checks `/close-out` and `/close-siblings` run before landing |
| 9 | `devServer.port` | none | The closing line of the worktree set-up |
| 10 | `commands.commitMessage` | none | Checks a new commit message before `git-commit-session` commits; `{file}` becomes the quoted path of a file with the message (appended without it); a non-zero exit refuses the commit (exit 9) |
| 10 | `hooks.off` | `[]` | The hook ids above |
| 11 | `commands.install` | lockfile guess | The worktree set-up's install step, run through the shell when a known lockfile is newer than the last install |
| 12 | `preflight` | none | Optional steps to run now and then before committing; each commit they touch counts a skip, shown once it reaches `remindAfter` |
| 13 | `paths.evolution` | `docs/evolution` | Where `evolution` and `kit release` find the evolution pages; none there means the project keeps none |
| 14 | `commands.evolutionRender` | none | Renders a page's printable version after `evolution bump`; `{page}` becomes the quoted page path (appended without it) |
| 15 | `ledgerAutoClose.questionDays` | `7` | Days after a record was last active before its `Open question at Stop` item counts as closed: hidden from the brief, listed apart by `--owed`, marked by `--sweep` |

`preflight` names a project's optional steps, never a tool the kit knows: each has a
`description`, an optional `command`, optional `match` globs (left out: any commit outside the
ledger) and `remindAfter` (default 1). The counts live in the repository's common git folder, shared
by its worktrees. `preflight run <id>` runs the command and clears the count on success;
`preflight done <id>` clears a step that ran another way, such as a skill.

```json
{
  "commands": { "commitAudit": "npx some-audit --base HEAD~1 --only {files}" },
  "preflight": {
    "docs-review": { "description": "Docs review: the project's docs-review skill", "match": ["docs/**", "*.md"], "remindAfter": 3 },
    "audit": { "description": "Dead-code and dependency audit", "command": "pnpm run audit" }
  }
}
```

The checkout comes from the hook payload's `cwd` (or the shell's working directory), so a worktree
session works on the worktree's own `kit.json`, ledger and files.

## Commands on the Bash PATH

The plugin's `bin/` is on the Bash tool's PATH in a session. Agents and commands call these;
a project may allow them in `.claude/settings.json` (`Bash(session-ledger --files:*)` and so on).

| ID | Command | What it does |
| --- | --- | --- |
| 1 | `session-ledger` | `--files`, `--record`, `--refresh`, `--conflicts`, `--owed`, `--done`, `--sweep`, `--archive`, `--backfill`; `--help` lists them |
| 2 | `git-commit-session` | Commit by path; `--help` lists flags and exit codes |
| 3 | `worktree-flow` | `status`, `resolve`, `base`, `adopt`, `conflicts`, `land`, `remove` |
| 4 | `worktree-setup` | The set-up the `worktree-setup` hook runs |
| 5 | `git-branch-context` | Branch, upstream, base branch and item prefix as JSON, for `/git` |
| 6 | `ledger-export` | Renders a record as a hand-off file outside the repo (`/handoff --export`) |
| 7 | `scan-ledger-secrets` | Pre-commit backstop: fails on secret-shaped text in staged records (without paths: the staged files in the ledger folder) |
| 8 | `preflight` | `status`, `run <id>`, `done <id>` for the `kit.json` `preflight` steps |
| 9 | `evolution` | `status [--since-release [<tag>] \| --base <ref>]`, `init`, `bump <page>`, `check` for the evolution pages; `--help` lists them |

Outside a session (a shell, a git hook), plugin commands are not on PATH. For the secret scan in a
git hook, add this repo as a dev dependency (`github:3meyc/agent-kit#<ref>`) and call
`agent-kit ledger-scan-secrets` (for example from lefthook's `pre-commit`); anything else runs
directly as `node <plugin>/scripts/<name>.mjs`.
