# Using the kit

**English** · [Українська](using.uk.md)

## 1. Install

Pick a scope:

| ID | Scope | Effect | Command adds |
| --- | --- | --- | --- |
| 1 | User | Every project on this machine | `~/.claude/settings.json` |
| 2 | Project | Everyone who opens the repo is asked to install it | `.claude/settings.json` (commit it) |

```bash
claude plugin marketplace add 3meyc/agent-kit#stable --scope project
```

```bash
claude plugin install sdlc@agent-kit --scope project
```

Repeat the install for each plugin you want (`core`, `session`, `svelte`, `python`).

## 2. Configure the project

1. Add `kit.json` at the repo root ([example](architecture.md#kitjson)), or run `/core:kit-adopt`:
   it drafts one, declares the marketplaces and plugins in `.claude/settings.json`, and lists the
   local files the kit now supplies (it deletes nothing).
2. Set `ledger: false` if the project keeps no session ledger; `session` then skips its ledger hooks.
3. Run `/core:kit-doctor` (or `kit doctor` from a Claude session's shell): it checks `kit.json`,
   the enabled plugins and declared marketplaces, that no kit-owned file (or a test of one) is
   copied into the repo, and whether an installed plugin lags its channel.
4. For git hooks outside Claude, where plugin commands are not on PATH, add the kit as a dev
   dependency and call its `agent-kit` command, for example `agent-kit ledger-scan-secrets` in the
   pre-commit hook:

```bash
pnpm add -D github:3meyc/agent-kit#stable
```

## 3. Take updates

Update explicitly. A new `stable` takes two commands, then a new session:

```bash
claude plugin marketplace update agent-kit
```

```bash
claude plugin update core@agent-kit
```

1. Run the second command for each kit plugin you installed (`sdlc`, `session`, …). The first one
   only moves the catalog; the installed plugin stays where it was until the second
   ([spikes](spikes.md) S8).
2. The `core` plugin checks for you: at session start it says when an installed kit plugin lags its
   channel, and prints these two commands for it. `/core:kit-doctor` reports the same.
3. Auto-update can't be relied on: the desktop app turns it off, headless runs never update, and an
   interactive session applies an update only at the next launch (S8). Turning it on
   (`/plugin` → Marketplaces → `agent-kit`) is optional and doesn't replace the commands above.

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

## Troubleshooting

| ID | Symptom | Check |
| --- | --- | --- |
| 1 | A skill or command is missing | `/plugin` lists the plugin as enabled for this project |
| 2 | An old behaviour persists | `claude plugin marketplace update agent-kit`, `claude plugin update <plugin>@agent-kit`, then a new session |
| 3 | A rule seems ignored | `/core:kit-doctor`; a project copy of a kit file shadows the kit |
