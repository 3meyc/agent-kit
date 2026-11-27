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
- Per-clone override (O6, C7): one function, `ensureBacklogMerge(top)`, makes sure
  `$GIT_COMMON_DIR/info/attributes` holds `<paths.sdlc>/backlog.md merge=text`, once, only when
  the project has a `kit.json`. Two callers: the `worktree-setup` SessionStart hook (early, every
  checkout) and `worktree-flow conflicts`, which `/close-out` and `/close-siblings` preload before
  any merge, so the line is in place even when the hook is in `hooks.off`. Idempotent; a write
  failure is one line, never a stopped session or a failed command.
- Existing `.gitattributes` (O4): `/backlog` `triage`, `pick` and `expire` delete the
  `<sdlc>/backlog.md merge=union` line (and the file when it held only that line) in the commit
  of their own change. Prose, as the rest of `/backlog` is; with the clone line in place the old
  line is harmless in kit clones, so this is cleanup. The same function also reports it:
  `worktree-flow conflicts` prints `backlog: .gitattributes still merges <sdlc>/backlog.md by
  union; delete that line (/backlog does on its next triage, pick or expire)` while the line is
  there, so it is removed or named on every landing.
- Smallest solution: no git merge driver (it needs per-clone config naming a script path that
  moves with each plugin version, and a missing driver fails the merge); no tombstone list.

## Files that change

- `plugins/session/scripts/backlog-merge.mjs` — new — session — `mergeBacklog({ base, ours, theirs })`
  returning `{ text }` or `{ refused }`; pure `withTextMerge(attributesText, sdlc)` (new
  `info/attributes` text, or null when the line is there) and `hasUnionLine(gitattributesText,
  sdlc)`; `ensureBacklogMerge(top)` doing the write and returning the lines to print.
- `plugins/session/scripts/worktree-flow.mjs` — modified — `cmdRegenerate` resolves a
  conflicted `<sdlc>/backlog.md` from stages 1–3 (`git show :n:<path>`), writes and stages it,
  then runs the rules on the rest; `cmdConflicts` calls `ensureBacklogMerge` first and prints
  its lines (plain and `--json` output both carry them); USAGE lines for both.
- `plugins/session/scripts/worktree-setup-hook.mjs` — modified — calls `ensureBacklogMerge`
  before the main-checkout return; failure is one stderr line, never a stopped session.
- `tests/session.backlog-merge.test.mjs` — new — pure cases.
- `tests/session.worktree-flow.test.mjs` — modified — a real merge that conflicts on the backlog
  and `regenerate` resolving it; `conflicts` writing the clone line with the hook off and naming
  a leftover union line.
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

- [x] 1. Row merge, test first (O1, O2, C1–C5). Files: `tests/session.backlog-merge.test.mjs`,
  `plugins/session/scripts/backlog-merge.mjs`. Check: the test fails before the module exists,
  then `node --test tests/session.backlog-merge.test.mjs` -> all pass.
- [x] 2. `regenerate` resolves a conflicted backlog (O1, O3, C4). Files: `worktree-flow.mjs`,
  `tests/session.worktree-flow.test.mjs`. The test merges a pick against an append without a
  union line, expects a conflict, runs `regenerate`, expects the picked rows gone, the appended
  row present and no unmerged path; a C4 head clash stays conflicted and is named. Check:
  `node --test tests/session.worktree-flow.test.mjs` -> pass; the new test fails before the
  change.
- [x] 3. Per-clone `merge=text` (O6, C7) from both callers. Files: `backlog-merge.mjs`
  (`withTextMerge`, `hasUnionLine`, `ensureBacklogMerge`), `worktree-setup-hook.mjs`,
  `worktree-flow.mjs` (`cmdConflicts`), `tests/session.worktree-setup-hook.test.mjs`,
  `tests/session.worktree-flow.test.mjs`. Tests: the hook run twice writes one line, then the C7
  reproduction conflicts instead of bringing rows back; with `worktree-setup` in `hooks.off`,
  `worktree-flow conflicts` writes the same line; a project without `kit.json` gets none.
  Check: both test files pass.
- [x] 4. Leftover union line reported (O4). Files: `backlog-merge.mjs` (`hasUnionLine`),
  `worktree-flow.mjs`, `tests/session.worktree-flow.test.mjs`. Test: `.gitattributes` with the
  union line -> `conflicts` prints the `backlog:` line; without it -> no line. Check: pass.
- [x] 5. Docs (O4, O5, C6). Files: `backlog.md`, `close-out.md`, `close-siblings.md`, session
  README (both: conflict row 6, follow-ups item 3, hook row 5, script row 3 for `conflicts` and
  `regenerate`), CHANGELOG. Check: `grep -rn "merge=union" plugins docs` -> only the
  removal instruction, the `conflicts` line and the CHANGELOG; `node plugins/core/bin/kit-docs-parity` -> ok.
- [x] 6. Architecture page sentence on `regenerate`, if it names what it rebuilds. Check:
  read `docs/architecture.md:146`; parity ok. Result: no change; the sentence describes the
  `kit.json` `regenerate` key, and the backlog merge is built in, not a key.
- [x] 7. Full check. `npm run check` -> exit 0. Commits: step 1–2 `fix(session): …` with
  `Fixes #56` in the last fix commit; docs with them or as `docs(session): …`.

## Proof

| Check | Expected | Covers |
| --- | --- | --- |
| `node --test tests/session.backlog-merge.test.mjs` | pass; failed before step 1 | O2, C1–C5 |
| `node --test tests/session.worktree-flow.test.mjs` (backlog regenerate case) | conflict, then resolved and staged, picked rows gone | O1, O3, C4 |
| `node --test tests/session.worktree-setup-hook.test.mjs` | line written once; union branch now conflicts | O6, C7 |
| `node --test tests/session.worktree-flow.test.mjs` (conflicts cases) | hook off: `conflicts` writes the line; no `kit.json`: none; leftover union line named, absent line silent | O4, O6 |
| Run `worktree-flow conflicts` in this repo (real input) | clone line written to the common dir's `info/attributes`, no `backlog:` line | O6 |
| Run the built `worktree-flow regenerate` on the scratch repo of the reproduction (real input) | picked rows gone, `b 1` kept, staged | O1, O3 |
| Read `/backlog` § The file and pick/expire/triage | union line removal step present; C6 named | O4, C6 |
| `grep -rn "merge=union" plugins docs` | only the removal instruction and CHANGELOG | O5 |
| `npm run check` | exit 0 (schema, vendor, tests, docs parity, naming guard) | all |
| `claude plugin validate .` | passes (missing `version` warning expected) | all |

O4's removal is agent-run prose, proved by reading; its detection (`conflicts` naming a
leftover line) is tested.

Evidence (2026-11-27, on the step 5 commit plus K2's uncommitted #57 files):

1. Red: `tests/session.backlog-merge.test.mjs` failed with `ERR_MODULE_NOT_FOUND`; the two
   backlog `regenerate` tests failed; the `conflicts` and hook C7 tests failed on the missing
   exports. Each passed after its step.
2. `npm run check` -> exit 0: 793 tests pass, docs parity 14 pairs ok, naming guard ok.
3. `claude plugin validate .` -> passed with warnings: the missing `version` field (expected)
   and no install line in `plugins/session/README.md`, a line this change does not touch.
4. Real input, scratch repo shaped like the reported case (kit.json, `docs/sdlc/backlog.md`
   with three rows and the union line; `dev` picks them and drops the line; `older` appended
   one row): on `older`, `worktree-flow conflicts` printed the `backlog:` note and wrote
   `docs/sdlc/backlog.md merge=text` to `info/attributes`; `git merge dev` conflicted;
   `worktree-flow regenerate` printed `merged docs/sdlc/backlog.md by its rows; staged`, and the
   file held only the appended row, nothing left unmerged.
5. `worktree-flow conflicts` in this repo: no `backlog:` line; the common dir's
   `info/attributes` now holds `docs/sdlc/backlog.md merge=text`.
6. `grep -rn "merge=union" plugins docs`: the `/backlog` removal instruction, the README's
   history sentence, the `conflicts` description, this item's records, and a released
   CHANGELOG entry; no text still says the backlog merges by union. No `sdlc-ext-plan` skill is
listed in this session, so no extra gates.

## Deviations

- IMPROVED — `ensureBacklogMerge` returns `{ sdlc, error, union }` instead of lines to print,
  and each caller words its own output: the hook stays quiet (a write failure on stderr only;
  the leftover union line is named at landing), and `conflicts --json` prints its `backlog:`
  notes on stderr, so stdout stays one JSON array for its readers. Steps 3–4; tests in
  `tests/session.worktree-flow.test.mjs` (conflicts case) and
  `tests/session.worktree-setup-hook.test.mjs`.
