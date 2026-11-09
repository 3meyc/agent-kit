# Contributing

**English** · [Українська](CONTRIBUTING.uk.md)

## Where a change goes and how it ships

The change flow, release and rollback are described in [Changing the kit](docs/changing.md):
which layer a change belongs to, how to try a plugin from a project before merging, and how
moving the `stable` tag releases it.

## Before you open a pull request

| ID | Check | Command |
| --- | --- | --- |
| 1 | Install the repo tooling | `npm ci` |
| 2 | Schema, vendored copies, tests, naming guard | `npm run check` |
| 3 | Plugin and marketplace manifests | `claude plugin validate .` |

1. **Neutral names only.** This repo is public. No names, links or notes from private projects or
   employers in files, commits, branch names or pull requests. Use `my-app`, `APP-123`.
2. **No `version` in `plugin.json`.** The `stable` tag is the release.
3. **Shared code** is edited in `shared/` and copied into each plugin with `npm run vendor`.
4. **Docs come in pairs**: `name.md` and `name.uk.md`, with the same structure.

## The naming guard

`scripts/naming-guard.mjs` fails on banned terms in tracked files, commit messages, author lines
and the branch name. The term list is never committed: CI reads the `NAMING_GUARD_WORDS` secret,
and a local run reads `~/.config/agent-kit/naming-guard.txt` (one term per line; syntax in the
script header). Pull requests from forks get no secrets, so the guard fails there until a
maintainer re-runs it.
