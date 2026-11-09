# agent-kit: notes for Claude sessions

This repo is the public base marketplace `agent-kit`: plugins `core`, `sdlc`, `session`,
`svelte`, `python` under `plugins/`. Read `README.md`, `docs/architecture.md` and
`docs/changing.md` before changing structure; they are the agreed design.

## Rules

1. **Public repo, neutral names.** Never write names, links or notes of a private project,
   employer or work ecosystem: not in files, file names, commit messages, branch names, PR text or
   issues. Use neutral examples (`my-app`, `APP-123`). Generic parts land here; specifics go to a
   private overlay kit or the project's `kit.json`.
2. **Run the naming guard before every commit**: `node scripts/naming-guard.mjs` (or
   `npm run check`, which also runs the schema check, the vendored-copy check and the tests).
   The term list is read from `~/.config/agent-kit/naming-guard.txt`; never commit it, never paste
   its terms into anything tracked.
3. **No `version` in `plugin.json`.** The `stable` git tag is the release; each commit counts as a
   new version. CI rejects a manifest that sets one. `claude plugin validate` warns about the
   missing field; that warning is expected.
4. **Bilingual human docs.** Every human-facing page is English `name.md` with a Ukrainian mirror
   `name.uk.md`. Both carry the language-switch line under the title and the same headings,
   tables, diagrams and numbered items. Change both in the same commit.
5. **Shared code lives in `shared/`.** Edit it there and run `npm run vendor` to refresh each
   plugin's `lib/` copy; never edit `plugins/*/lib/` by hand. CI fails on a stale copy.
6. **Mark unverified Claude Code behaviour as unverified** rather than guessing; check the docs
   at https://code.claude.com/docs/en/plugins-reference first.
7. **Git identity**: commit with the repo-local identity already configured; never change git
   identity config.

## Checks

```bash
npm ci
npm run check
claude plugin validate .
```
