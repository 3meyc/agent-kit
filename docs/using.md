# Using the kit

**English** · [Українська](using.uk.md)

## 1. Install

Install the kit plugins once per machine, at user scope. A project only declares the marketplace
and enables the plugins in its committed `.claude/settings.json`; it installs nothing.

| ID | Part | Where | Who |
| --- | --- | --- | --- |
| 1 | The installed plugins | User scope (`~/.claude/plugins`) | Each user, once per machine |
| 2 | The marketplace and the enabled plugins | `.claude/settings.json` of the project (commit it) | The project, once: `/core:kit-adopt` writes both |

```bash
claude plugin marketplace add 3meyc/agent-kit#stable
```

```bash
claude plugin install core@agent-kit --scope user
```

Repeat the install for each plugin you want (`sdlc`, `session`, `svelte`, `python`).

Why user scope only ([spikes](spikes.md) S11, tried with Claude Code 2.1.300 and 2.1.321):

1. A session loads the first install record in `~/.claude/plugins/installed_plugins.json` that
   applies to its folder. A user record always applies; a project record applies in every worktree
   of the repository it was made in. New records go to the end, so whichever came first wins, not
   the folder's own copy and not the newest one.
2. `claude plugin update` without `--scope` updates a project-scope copy when there is one, and
   `--scope project` updates the first copy of the repository, which may belong to another worktree.
   An update can report "already at the latest version" while the copy that runs is old.
3. Uninstalling a project-scope copy also removes the plugin from that folder's
   `.claude/settings.json`, a tracked file.
4. Claude Code still writes a project-scope record by itself in each folder whose settings enable
   the plugin, every worktree included, at the version the session there loaded (seen with the
   CLI the desktop app ships, 2.1.321). That is harmless while the user copy is current and comes
   first; `kit installs` lists the copies that differ (§ 3).

## 2. Configure the project

1. Add `kit.json` at the repo root ([example](architecture.md#kitjson)), or run `/core:kit-adopt`:
   it drafts one, declares the marketplaces and plugins in `.claude/settings.json`, and lists the
   local files the kit now supplies (it deletes nothing).
2. Set `ledger: false` if the project keeps no session ledger; `session` then skips its ledger hooks.
3. Run `/core:kit-doctor` (or `kit doctor` from a Claude session's shell): it checks `kit.json`,
   the enabled plugins and declared marketplaces, that each enabled plugin is installed on this
   machine, that no kit-owned file (or a test of one) is copied into the repo, and whether an
   installed plugin the project uses lags its channel. In a worktree under another checkout's
   `.claude/worktrees/` it warns when that checkout's `.claude/` differs from the worktree's:
   sessions there read the outer one (seen with the desktop app).
4. For git hooks outside Claude, where plugin commands are not on PATH, add the kit as a dev
   dependency and call its `agent-kit` command, for example `agent-kit ledger-scan-secrets` in the
   pre-commit hook:

```bash
pnpm add -D github:3meyc/agent-kit#stable
```

5. Keep copies out with CI: with that dev dependency, a CI step runs `kit doctor` in strict mode,
   which needs no Claude Code and no installed plugin. It judges the repo, not the machine: it
   fails on a copy of a kit-owned file (or a test of one), on a `kit.json` that fails the schema,
   and on a needed plugin or a marketplace missing from the shared `.claude/settings.json`;
   `settings.local.json` and the user's settings don't count, and installed versions and install
   scopes never fail it. It reads ownership from the plugin folders in the `agent-kit` package;
   for an overlay's plugins, add `--plugin-root <path>` (a plugin folder, or a folder of them,
   relative to the working directory; repeatable). `--offline` skips the remote version check.
   Exit codes: 0 passed, 1 a finding failed, 2 a usage error (an unknown flag, a root with no
   plugin in it).

```bash
pnpm exec agent-kit doctor --strict --offline
```

```bash
pnpm exec agent-kit doctor --strict --offline --plugin-root node_modules/my-overlay-tools/plugins
```

6. Keep an evolution log (optional, `session`): two pages in `paths.evolution` (default
   `docs/evolution`) draw how the project grew, one Mermaid flowchart each with a Sources table,
   a `version:` and a `last_verified:`. `process-evolution.md` takes each change to the way of
   working (agent rules, skills, hooks, CI, `kit.json`), stage by stage; `features-evolution.md`
   takes each shipped feature, release by release. Start them from a Claude session's shell; it
   adds a mirror per language the repo already keeps `*.<lang>.md` pages in (`--lang`,
   `--no-mirror` to choose). Then replace the first boxes with the real history and commit.
   From then on the pages are brought up to date once per release, not per session:
   `evolution status --since-release` lists the changelog's `## Unreleased` lines (or
   `## [Unreleased]`, the Keep a Changelog form; already triaged: each was worth a line) and the commits since the last release tag that changed the
   way of working, and the `evolution` skill turns them into a few boxes. The `kit release` dry
   run names a page not changed since the last release, so nobody has to remember; a project with
   its own release flow runs the skill before it. With a renderer for
   a printable version, set `commands.evolutionRender` (`{page}` is the page path); `evolution
   bump` runs it. `evolution check` fits a `checks` suite.

```bash
evolution init
```

7. Branch the same way in every repo: personal, work and kit repos alike. A repo that has a
   reason to differ sets `baseBranch` in `kit.json`.

| ID | Branch | Role |
| --- | --- | --- |
| 1 | `dev` | The integration branch, and the `baseBranch` default. Feature and session branches are cut from it and land back on it |
| 2 | `main` | Releases only. It moves forward from `dev` when a release is cut |
| 3 | `feat/<slug>-<ITEM-ID>`, `claude/…` | One piece of work each, cut from `dev` |

   Land by merge, not by pull request. In the branch's own worktree, merge `dev` into the
   branch, so the session that made the change resolves any conflict there. Run the checks. Then
   `worktree-flow land` fast-forwards `dev` to the branch; it never merges and never pushes.
   `/close-out` runs these steps. Push `dev` on the user's word. `/core:kit-adopt` picks `dev`
   (or `develop`, `development`) when the repo has one. `worktree-flow` prefers them when it guesses
   a base. Setting the forge's default branch to `dev`, so new clones and pull requests start
   there, is the repo owner's call.

   A merged branch that was pushed stays on `origin` until someone deletes it.
   `worktree-flow stale-remote [--base <b>] [<branch>…]` lists the ones `origin/<base>` already
   holds, or whose PR was merged into the base (a squash merge, checked with `gh`), and the ones
   it keeps with the reason; it deletes nothing. `/close-siblings` offers to delete the
   sub-sessions' stale branches, and `/close-out` this session's own, in the same question as
   the landing; the deletion is one `git push origin --delete …` on the user's word.

## 3. Take updates

Update explicitly, at user scope. A new `stable` takes two commands, then a new session:

```bash
claude plugin marketplace update agent-kit
```

```bash
claude plugin update core@agent-kit --scope user
```

1. Run the second command for each kit plugin you installed (`sdlc`, `session`, …). The first one
   only moves the catalog; the installed plugin stays where it was until the second
   ([spikes](spikes.md) S8). Always pass `--scope user`: without it the command picks a
   project-scope copy (§ 1).
2. The `core` plugin checks for you: at session start it says when the copy the session loads, or
   the user copy, lags its channel, and prints these commands for it. `/core:kit-doctor` reports
   the same, plus every project-scope copy of this repository that differs.
3. Auto-update can't be relied on: the desktop app turns it off, headless runs never update, and an
   interactive session applies an update only at the next launch (S8). Turning it on
   (`/plugin` → Marketplaces → `agent-kit`) is optional and doesn't replace the commands above.
4. Plugins install from the ref this machine registered the marketplace at, not from the ref the
   project declares. When your own `~/.claude/settings.json` `extraKnownMarketplaces` declares
   `agent-kit` without a `ref`, the marketplace tracks `HEAD`, and
   `claude plugin marketplace add 3meyc/agent-kit#stable` is refused because its source doesn't
   match that entry. Add `"ref": "stable"` to the user entry, then run the `add` command again.
   `/core:kit-doctor` warns about both cases (observed with one Claude Code version; the message
   may differ).
5. Project-scope copies from earlier installs, or written by Claude Code itself, stay at their old
   version. Claude Code has no command that updates or removes one folder's copy reliably (§ 1), so
   the kit clears them. After the user-scope update, from a Claude session's shell (`kit` is on
   its PATH), list them and clear them, then start a new session:

```bash
kit installs
```

```bash
kit installs --clean
```

6. `--clean` leaves a copy whose plugin has no user-scope install, or whose user copy lags the
   channel, and says which command to run first. For each other stale copy it runs
   `claude plugin uninstall <plugin>@agent-kit --scope project` from that copy's folder and then
   writes the folder's `.claude/settings.json` and `settings.local.json` back as they were; for a
   folder that no longer exists, it creates the folder for the call and removes it again. By hand,
   do the same: run the uninstall from the folder, then restore `.claude/settings.json`
   (`git checkout -- .claude/settings.json` when it had no local edits).

## 4. Private overlay kits

An overlay kit in a private repo is cloned with this machine's git credentials:

```bash
gh auth login
```

```bash
gh auth setup-git
```

With several GitHub accounts on one machine, check that the account that can read the overlay is
the one git uses for it.

## 5. Check your repos for drift

The kit schedules no check: keeping each repo in step with the kit is the developer's job. Run the
inventory by hand, for example after taking a new `stable` or before moving files into a kit.

1. **Set up once.** List your local clones in `~/.config/agent-kit/inventory.json` (or under
   `$XDG_CONFIG_HOME`). The list is your configuration and never goes into the kit. `reference` is
   the copy drift is measured against; `extraRoots` and `extraFiles` add folders and files to scan
   ([core README](../plugins/core/README.md), "Inventory repo list").

```json
{ "repos": { "app": "~/code/my-app", "api": "~/code/my-api" }, "reference": "app" }
```

2. **Run it.** Pull each repo's default branch first: the inventory reads every clone as it is.
   In a Claude session run `/core:kit-inventory`, or from its shell (`--out <dir>` writes the full
   report to files):

```bash
kit inventory
```

```bash
kit drift
```

3. **Act on the result.** Each file group is `same`, `drift(n)` or `single` across the repos:
   1. Marked `kit:<plugin>`: a copy the kit now supplies. Retire it in that repo; `/core:kit-doctor`
      there lists it ([core README](../plugins/core/README.md), "Retiring project copies").
   2. `drift`: copies that differ. `kit drift` gives the changed lines per repo; large drift means a
      merge, not a copy.
   3. `single`: in one repo only, project-specific unless you decide otherwise.
4. **Check each repo against `stable`.** The inventory does not compare a repo with `stable`. In
   each repo, `/core:kit-doctor` reports kit-owned copies and plugins that lag their channel; take
   updates as in § 3. CI with `kit doctor --strict` (§ 2) keeps copies out on every push.
5. **Keep it current.** Edit `inventory.json` when you add, move or retire a repo. The commands
   themselves update with the `core` plugin (§ 3).

## 6. Keep the ledger's Next list short

With `"ledger": true`, every session record ends with a `## Next` list, and its open items come
back in each new session's brief until `session-ledger --done <id8> <n>` marks them. In a busy
project most of them are settled long before anyone marks them, so the `session` plugin closes an
item on its own when one of these rules says it is settled:

| ID | Rule | Closes an item when |
| --- | --- | --- |
| 1 | Expired question | It opens with `Open question at Stop:` (the recap's unanswered question) and the record was last active more than `ledgerAutoClose.questionDays` days ago (default 7) |
| 2 | Until date | It carries `(until YYYY-MM-DD)` and that day has passed |
| 3 | Merged PR | It names a PR (`PR #12`, `pull request 12`, `owner/repo#12`, a `…/pull/12` link) that merged on or after the record's day. Merge subjects on the integration branches answer offline; `gh pr view` answers the rest, only for `--owed` and `--sweep` and only when `gh` is installed, cached in the git common dir. Without `gh` the item stays open |
| 4 | Landed branch | It is about landing, merging or pushing, and names a branch that landed in its base since the record's day began. The base is the one `worktree-flow base` recorded, else any integration branch for a `claude/…` session branch, else `baseBranch`. A deleted branch counts through its sessions' `Session-Id` commits or a merge subject. A branch named in a condition (`once`, `when`, `after`, `until`, `before`, `if` just before it) does not count: that item becomes due, not done |
| 5 | Pushed branch | It says push and names a branch other than the base whose remote-tracking ref holds what the branch held at the end of the record's day |

1. The brief hides closed items and says in one line how many there are.
2. `session-ledger --owed` lists the open items, then the auto-closed ones under their own
   heading, each with its reason.
3. `session-ledger --sweep` writes the done marks into the records, as
   `(done <date> <id8> auto: <reason>)`, signed with `--as`, the session id, or `sweep` outside a
   session; `--dry-run` only lists them. Nothing is deleted. `session-ledger --archive` then moves
   the records that owe nothing.
4. Give an item that matters only for a while an end date: `watch the error rate (until 2026-12-01)`.
5. Auto-close settles items; triage decides the rest. `/backlog triage` shows the open items as
   one table (What, Why, Source, a proposed verdict) and carries out your answer
   (`F1 keep, F5–F7 drop`): a Keep becomes a session whose charter is that item, a Defer becomes a
   row of `<paths.sdlc>/backlog.md` with an Until date 14 days out, a Drop is only marked done.
   Each item leaves the list either way. `/close-out` and `/close-siblings` run the same triage on
   the follow-ups of the work they land, so `## Next` stays an inbox, not a backlog. `/backlog`
   shows the backlog, `/backlog pick B3 B7` starts a session with those rows as its charter, and
   `/backlog expire` removes rows past their date. Each `## Next` item ends with `— why: <who is
   hurt if it is left undone>`; the triage reads it.
6. Change the question window in `kit.json`:

```json
{ "ledgerAutoClose": { "questionDays": 14 } }
```

```bash
session-ledger --sweep --dry-run
```

## 7. Try a kit change in a project

Installed plugins are read-only copies in Claude Code's plugin cache. To try a change to the base
kit or an overlay in a real project before it is released, start Claude Code there with the plugin
folders of your local checkouts (`--plugin-dir`, [changing](changing.md) step 3). `kit dev` builds
that command, so you don't list every plugin folder by hand.

1. Once per machine, map each marketplace name (the part after `@` in `enabledPlugins`) to its
   checkout in `~/.config/agent-kit/checkouts.json` (`$XDG_CONFIG_HOME/agent-kit/` when that is
   set). A path may start with `~/`; a relative one is read from that file's folder.
2. In the project, from a terminal, run the command below. Outside Claude Code `kit` is not on the
   PATH: `agent-kit dev` does the same where the root package is installed, and `kit dev` in a
   Claude session's shell prints the report too.
3. It reads `enabledPlugins` from `.claude/settings.json` (`settings.local.json` switches one on or
   off), finds each plugin in its marketplace's checkout through `.claude-plugin/marketplace.json`,
   adds the plugins they name in `dependencies`, and prints a numbered report: each plugin and the
   folder it loads from, the warnings, the `claude --plugin-dir …` command and the check.
4. It warns when a checkout has uncommitted files, is not on its base branch (`kit.json`
   `baseBranch`, else `dev`), is missing or holds no marketplace, and when an enabled plugin has
   no checkout: that one stays on the installed copy.
5. `--checkout <marketplace>=<path>` (repeatable) overrides the file for one run, for example to
   load the worktree where the change is; `--config <file>` reads another file.
6. `--run` starts the command in the project folder, with any arguments after `--` passed to
   `claude`. Run it from a terminal, not from inside a Claude session.
7. A `--plugin-dir` copy replaces the installed plugin of the same name silently, and
   `claude plugin list` still shows the installed one. In the new session, `/core:kit-doctor`
   lists each plugin "loaded for this session with --plugin-dir"; one it doesn't list runs from
   the installed copy.

```json
{ "agent-kit": "~/src/agent-kit", "my-overlay": "~/src/my-overlay" }
```

```bash
node ~/src/agent-kit/plugins/core/src/kit-cli.mjs dev
```

```bash
node ~/src/agent-kit/plugins/core/src/kit-cli.mjs dev --checkout agent-kit=~/src/agent-kit/.claude/worktrees/my-change --run
```

## Troubleshooting

| ID | Symptom | Check |
| --- | --- | --- |
| 1 | A skill or command is missing | `/plugin` lists the plugin as enabled for this project |
| 2 | An old behaviour persists | `claude plugin marketplace update agent-kit`, `claude plugin update <plugin>@agent-kit --scope user`, then a new session |
| 3 | A rule seems ignored | `/core:kit-doctor`; a project copy of a kit file shadows the kit |
| 4 | `marketplace add …#stable` is refused: its source doesn't match its `extraKnownMarketplaces` entry | Add `"ref": "stable"` to that marketplace in `~/.claude/settings.json`, run `add` again, then `claude plugin update <plugin>@agent-kit --scope user` per plugin (§ 3) |
| 5 | An update reports "already at the latest version", or a new session still runs the old kit | `kit installs`: a project-scope copy loads before the user copy or took the update; update at user scope, then `kit installs --clean` (§ 3) |
