---
status: approved
---

# Plan: /backlog rows removed by pick or expire stay removed after a merge

Intent: [intent.md](intent.md).

## Design notes

- Recipe: none matched (no `docs/recipes` in this repo). Glossary: none in this repo; no new
  term beyond `/backlog` § The file's own (row, Source).
- Owning module: the `session` plugin. The row merge is a pure module beside `worktree-flow`;
  `worktree-flow regenerate` (Q1) calls it for a conflicted `<paths.sdlc>/backlog.md` before the
  `kit.json` `regenerate` rules, so the landing flows keep one command for conflicted files.
- Row merge (pure): split each side into head (lines up to the table's separator row), rows
  (`|` lines after it, keyed by the first cell, Source) and tail. Head and tail merge three-way
  as whole blocks: equal sides, or one side equal to base, take the other; both changed
  differently is a refusal (C4). Rows: ours in order, minus Sources base had and theirs lacks,
  plus theirs' rows whose Source is in neither base nor ours, in theirs' order. A missing stage
  (add/add, C5) reads as empty.
- Per-clone override (O6, C7): the `worktree-setup` SessionStart hook, which already runs in
  every checkout and writes to the git common dir, makes sure `$GIT_COMMON_DIR/info/attributes`
  holds `<paths.sdlc>/backlog.md merge=text`, once, only when the project has a `kit.json`. A
  project with the hook in `hooks.off` does not get it; the README says so.
- Existing `.gitattributes` (O4): `/backlog` `triage`, `pick` and `expire` delete the
  `<sdlc>/backlog.md merge=union` line (and the file when it held only that line) in the commit
  of their own change. Prose, as the rest of `/backlog` is.
- Smallest solution: no git merge driver (it needs per-clone config naming a script path that
  moves with each plugin version, and a missing driver fails the merge); no tombstone list.

## Files that change

- `plugins/session/scripts/backlog-merge.mjs` — new — session — `mergeBacklog({ base, ours, theirs })`
  returning `{ text }` or `{ refused }`, and `withTextMerge(attributesText, sdlc)` returning the
  new `info/attributes` text or null when the line is there.
- `plugins/session/scripts/worktree-flow.mjs` — modified — `cmdRegenerate` resolves a
  conflicted `<sdlc>/backlog.md` from stages 1–3 (`git show :n:<path>`), writes and stages it,
  then runs the rules on the rest; USAGE line for `regenerate`.
- `plugins/session/scripts/worktree-setup-hook.mjs` — modified — writes the `info/attributes`
  line through `withTextMerge`, before the main-checkout return; failure is one stderr line,
  never a stopped session.
- `tests/session.backlog-merge.test.mjs` — new — pure cases.
- `tests/session.worktree-flow.test.mjs` — modified — a real merge that conflicts on the backlog
  and `regenerate` resolving it.
- `tests/session.worktree-setup-hook.test.mjs` — modified — the line is written once; a branch
  carrying the union line then conflicts instead of resurrecting.
- `plugins/session/commands/backlog.md` — modified — § The file item 3; `triage`/`pick`/`expire`
  remove an old union line.
- `plugins/session/commands/close-out.md`, `close-siblings.md` — modified — the conflicted-file
  sentence names the backlog as resolved by `worktree-flow regenerate`.
- `plugins/session/README.md`, `README.uk.md` — modified — row 6 (conflicts), follow-ups item 3,
  hook row 5 (`worktree-setup`), `regenerate` in the script table row 3.
- `docs/architecture.md`, `architecture.uk.md` — modified only if their `regenerate` sentence
  needs the backlog; checked in step 5.
- `CHANGELOG.md` — modified — one `## Unreleased` line ending `(#56)`.
- `docs/sdlc/backlog-union-resurrection/intent.md` — modified at planning: O6, C7, Q1–Q3.

Impact check (grep, no CodeGraph index): `cmdRegenerate` is called only from `COMMANDS`;
`regeneratePlan` keeps its signature (tests at `tests/session.worktree-flow.test.mjs:878`
unaffected). `grep -rn "merge=union\|union" plugins docs` lists every text to change:
`plugins/session/commands/backlog.md:36`, `plugins/session/README.md:88`, `README.uk.md:90`.

## Order of work

- [ ] 1. Row merge, test first (O1, O2, C1–C5). Files: `tests/session.backlog-merge.test.mjs`,
  `plugins/session/scripts/backlog-merge.mjs`. Check: the test fails before the module exists,
  then `node --test tests/session.backlog-merge.test.mjs` -> all pass.
- [ ] 2. `regenerate` resolves a conflicted backlog (O1, O3, C4). Files: `worktree-flow.mjs`,
  `tests/session.worktree-flow.test.mjs`. The test merges a pick against an append without a
  union line, expects a conflict, runs `regenerate`, expects the picked rows gone, the appended
  row present and no unmerged path; a C4 head clash stays conflicted and is named. Check:
  `node --test tests/session.worktree-flow.test.mjs` -> pass; the new test fails before the
  change.
- [ ] 3. Per-clone `merge=text` (O6, C7). Files: `worktree-setup-hook.mjs`, `backlog-merge.mjs`
  (`withTextMerge`), `tests/session.worktree-setup-hook.test.mjs`. The test runs the hook twice
  (one line written), then repeats the C7 reproduction: the merge conflicts instead of
  bringing rows back. Check: `node --test tests/session.worktree-setup-hook.test.mjs` -> pass.
- [ ] 4. Docs (O4, O5, C6). Files: `backlog.md`, `close-out.md`, `close-siblings.md`, session
  README (both), CHANGELOG. Check: `grep -rn "merge=union" plugins docs` -> only the
  removal instruction and the CHANGELOG; `node plugins/core/bin/kit-docs-parity` -> ok.
- [ ] 5. Architecture page sentence on `regenerate`, if it names what it rebuilds. Check:
  read `docs/architecture.md:146`; parity ok.
- [ ] 6. Full check. `npm run check` -> exit 0. Commits: step 1–2 `fix(session): …` with
  `Fixes #56` in the last fix commit; docs with them or as `docs(session): …`.

## Proof

| Check | Expected | Covers |
| --- | --- | --- |
| `node --test tests/session.backlog-merge.test.mjs` | pass; failed before step 1 | O2, C1–C5 |
| `node --test tests/session.worktree-flow.test.mjs` (backlog regenerate case) | conflict, then resolved and staged, picked rows gone | O1, O3, C4 |
| `node --test tests/session.worktree-setup-hook.test.mjs` | line written once; union branch now conflicts | O6, C7 |
| Run the built `worktree-flow regenerate` on the scratch repo of the reproduction (real input) | picked rows gone, `b 1` kept, staged | O1, O3 |
| Read `/backlog` § The file and pick/expire/triage | union line removal step present; C6 named | O4, C6 |
| `grep -rn "merge=union" plugins docs` | only the removal instruction and CHANGELOG | O5 |
| `npm run check` | exit 0 (schema, vendor, tests, docs parity, naming guard) | all |
| `claude plugin validate .` | passes (missing `version` warning expected) | all |

O4's removal is agent-run prose: proved by reading, not by a test. No `sdlc-ext-plan` skill is
listed in this session, so no extra gates.

## Deviations
