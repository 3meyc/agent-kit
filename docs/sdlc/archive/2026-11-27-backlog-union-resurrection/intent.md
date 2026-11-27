---
type: fix
status: done
ticket: none
branch: claude/session-backlog-parentfiles-d2fb2c
base: dev
created: 2026-11-27
completed: 2026-11-27
---

# Intent: /backlog rows removed by pick or expire stay removed after a merge

## What to implement

`/backlog` adds `<sdlc>/backlog.md merge=union` to `.gitattributes` so two main sessions can
append rows at once. A union merge keeps both sides of a conflicting hunk, so when one side
removes rows (`pick`, `expire`) and the other appends a row next to them, the merge silently
brings the removed rows back (#56).

Reproduction (2026-11-27, throwaway repo): base holds rows `a 1`–`a 3`; branch A removes all
three; branch B appends `b 1`. With `merge=union` the merge succeeds and the file holds
`a 1`–`a 3` and `b 1`. With the default text merge the same merge stops with one conflict
(ours: nothing; theirs: `a 1`–`a 3`, `b 1`).

Proposed fix (recommended): drop `merge=union` and let the conflict surface, then resolve it
with a kit command instead of by hand: a three-way merge of the table's rows keyed by
**Source**, read from git's base, ours and theirs copies. A row either side removed stays
removed; a row either side added is added. Projects that already carry the union line lose it.

## Expected outcome

- O1. A merge where one side removed backlog rows and the other appended rows ends with the
  removed rows gone and the appended rows present, in every flow that merges: `/close-out`
  bringing the base in, `/close-siblings` merging a child branch.
- O2. Two sides that each append rows still merge to both sets of rows, with no row lost and
  no row twice (the case union was added for).
- O3. A conflicted `<sdlc>/backlog.md` is resolved and staged by one kit command, with no hand
  edit and no `git add` by the user.
- O4. New projects get no `merge=union` line; a project that already has it loses the line the
  next time `/backlog` runs in a main session, in the same commit as that run's change.
- O5. `/backlog`, the session README (both languages) and the CHANGELOG describe the new
  behaviour; nothing in the kit still says rows merge by union.
- O6. A branch cut before the union line was removed merges like O1 too: the session plugin
  sets `<sdlc>/backlog.md merge=text` in the clone's `.git/info/attributes`, which outranks a
  `.gitattributes` line on either side (found while planning, 2026-11-27; see C7).

## Scope

Included: the row merge command and its tests, the `/backlog`, `/close-out` and
`/close-siblings` wording that points a conflicted backlog to it, removing the union line from
existing projects, README and CHANGELOG.

Excluded: making a sub-session's commit of `<sdlc>/*.md` a refusal instead of the
`parent-files:` line (that line is accurate again since #57; a refusal is a separate change);
any change to triage, verdicts or the file's columns.

## Constraints

1. Node built-ins only; the command lives in the `session` plugin beside `worktree-flow`.
2. The file format stays as `/backlog` § The file defines it: one table, **Source** unique
   and permanent, B-numbers never written.
3. Merges never land a conflicted tree on the integration branch (`/close-out`'s rule stays).
4. Bilingual docs (repo rule 4); no project names in tests or text (rule 1).

## Important cases and open questions

- C1. Both sides removed the same row: removed once, no error.
- C2. One side removed a row the other side edited (say its Until): removed; the removal wins,
  since `pick`/`expire` is the only way a row leaves. Proposal, not a stated user choice.
- C3. Both sides added a row with the same Source: kept once (ours' text).
- C4. Lines outside the table (title, intro) differ on both sides: the command stops, names the
  file and leaves it conflicted, so a person decides.
- C5. The file has no table on one side (created on one branch only): git reports an add/add
  or no conflict; the command handles add/add as base = empty.
- C6. The union line is the only line in `.gitattributes`: the file is deleted with it.
- C7. The base dropped the union line and picked rows; a branch cut earlier still has the line
  and appended a row. Merging the base into that branch uses the branch's own attributes, so
  removing the line alone still brings the rows back (reproduced 2026-11-27); with `merge=text`
  in `.git/info/attributes` the same merge conflicts and the row merge resolves it.
- Q1. Command shape: a new `worktree-flow backlog-merge`, or `worktree-flow regenerate` taking
  a conflicted backlog as a built-in rule so the flows keep one command for conflicted files.
  Recommendation: built into `regenerate`, no `kit.json` rule needed. Does not block the plan.
  (resolved 2026-11-27: built into `regenerate`)
- Q2. Also flag a remaining union line from `kit doctor` (core plugin), for projects that never
  run `/backlog` again? Recommendation: no; `/backlog` is the only writer of the file, so a
  project that never runs it never removes rows. Does not block the plan.
  (resolved 2026-11-27: no; O6 covers clones whatever their `.gitattributes` says)
- Q3. A merge made on the forge (a pull request merged on GitHub) reads only `.gitattributes`,
  not a clone's `.git/info/attributes`; whether GitHub honours `merge=union` there is
  unverified. The kit lands by fast-forward (`worktree-flow land`), so this is outside its
  flows; recorded, not handled. Does not block the plan.

## References

- Issue 3meyc/agent-kit#56; related #57 (false `parent-files:` warnings hid the real one).
- `plugins/session/commands/backlog.md` § The file item 3; `close-out.md` § 4 steps 2–3;
  `close-siblings.md` § 2 step 3; `plugins/session/README.md` follow-ups item 3.
- `plugins/session/scripts/worktree-flow.mjs` `regeneratePlan`, `cmdRegenerate`.
- No glossary in this repo (`docs/glossary.md` missing); terms follow `/backlog` § The file.
