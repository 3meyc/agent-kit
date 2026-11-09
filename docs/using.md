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

1. Add `kit.json` at the repo root ([example](architecture.md#kitjson)).
2. Set `ledger: false` if the project keeps no session ledger; `session` then skips its ledger hooks.
3. Run `kit doctor` _(planned)_: it checks `kit.json`, the enabled plugins, and that no
   kit-owned file is copied into the repo.

## 3. Take updates

Auto-update is **off by default** for third-party marketplaces.

1. Turn it on once per machine: `/plugin` → Marketplaces → `agent-kit` → enable auto-update.
2. With it on, a new `stable` arrives at the next session start.
3. Without it: `claude plugin marketplace update agent-kit`.

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
| 2 | An old behaviour persists | `claude plugin marketplace update agent-kit`, then a new session |
| 3 | A rule seems ignored | `kit doctor` _(planned)_; a project copy of a kit file shadows the kit |
