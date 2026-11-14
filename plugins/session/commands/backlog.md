---
description: The project's backlog of deferred follow-ups — show it, triage open ledger items into it (Keep, Defer, Drop), pick rows into a new session's charter, expire old rows. One file, <sdlc>/backlog.md, written by main sessions only
argument-hint: [triage [<word>] | pick B3 B7 … | expire]
allowed-tools: Bash(session-ledger:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs:*), Bash(git status:*), Bash(git log:*)
---

Arguments: $ARGUMENTS

Where things are comes from the project's `kit.json`: `paths.sdlc` (default `docs/sdlc`) and the
ledger (`paths.ledger`, only when `"ledger": true`). Below, `<sdlc>` stands for that path. With the
ledger off there are no records to triage: `triage` says so, the other forms still work.

## The file

`<sdlc>/backlog.md` holds every follow-up a triage deferred, and nothing else. A row enters only
through a triage (below) and leaves only by `pick` or `expire`. It is a top-level `<sdlc>/*.md`
file, so only a main session writes it: a sub-session lists the edit for its parent
(`for the parent: <sdlc>/backlog.md: <row>`) and its commit of the file prints `parent-files:`.

```markdown
# Backlog

Deferred follow-ups. Rows enter through `/backlog triage` (or the triage of `/close-out` and
`/close-siblings`) and leave by `/backlog pick` or `/backlog expire`.

| Source | What | Why | Added | Until |
| --- | --- | --- | --- | --- |
| a1b2c3d4 3 | Merge the two import result tables | Users read two counts for one run | 2026-11-14 | 2026-11-28 |
```

1. **Source** is the row's key: the ledger item it came from, `<id8> <n>`, unique and permanent.
   The B-numbers (B1, B2 …) are the rows' order in the file, shown by `/backlog` and used by `pick`
   and `expire` in the same conversation; they are never written into the file.
2. **Until** is **Added** plus 14 days. A row past it is expired.
3. Two main sessions may append rows at once (two roots closing out). When it creates the file,
   `/backlog` also adds `<sdlc>/backlog.md merge=union` to `.gitattributes`, so appended rows from
   both sides merge without a conflict. Removing rows (`pick`, `expire`) is for one session at a
   time, normally the daily one.

## No argument: show

Read-only. Show the rows as a table with their B-numbers, rows past **Until** marked expired, then
one line each: how many rows, how many expired (`/backlog expire`), and the inbox — the SessionStart
brief's count of open `## Next` items, the follow-ups no triage has seen yet (`/backlog triage`).
With no file yet, say so and show only the inbox line.

## `triage [<word>]`: the one triage

`/close-out` § 1 and `/close-siblings` § 1 run this same triage on their follow-ups; run on its
own, it takes the inbox, `session-ledger --owed [<word>]` (the open items, not the auto-closed
ones). A sub-session runs no triage: its follow-ups wait in its record for its parent.

1. **Rows.** Every follow-up becomes a row; leave out a `Resume:` item of a session still running,
   `mark done:` and `for the parent:` items (main-session steps, not work), and kit gaps (they go
   to the kit's issues, `/close-out` § 1). Columns: **#** (F1, F2 …, stable across replies),
   **What** (the change, one line), **Why** (who or what is hurt if it is left undone, one line;
   from the item's `— why:`, else written here, else `(no reason given)`), **Source**
   (`<id8> <n>`, or `this session`), **Verdict** (proposed).
2. **Proposed verdict.**
   1. **Keep** only when leaving it hurts concretely: a defect a user sees, a release blocker, a
      failing or missing check, or an unfinished item of the current charter.
   2. **Defer** for the rest: polish, wording, refactors, process tweaks.
   3. **Drop** when the Why does not hold up: already done elsewhere, superseded, no reason given.
3. **Ask.** Show the table, then end the turn with `mcp__ccd_turn__wrap_up` (elsewhere, one closing
   question); inside `/close-out` or `/close-siblings` it rides on their one question instead. The
   first button accepts the proposed verdicts. The user may answer by ids instead, lists and ranges
   alike (`F1 keep, F5–F7 drop`); a row the answer does not name keeps its proposed verdict.
4. **Carry out**, after the answer:
   1. **Keep**, inside the current charter and small: done in this session (inside
      `/close-siblings`, before its § 3 checks). Any other Keep: a session of its own, its charter
      that one row, proposed as `/close-out` § 3 describes (after the landing, when there is one).
      It lands itself through `/close-out`; nothing waits for it.
   2. **Defer**: a row in `<sdlc>/backlog.md` (Added today, Until in 14 days).
   3. **Drop**: nothing more.
   4. Every row with a Source: `session-ledger --done <id8> <n>`, so it leaves the inbox.
   5. Every row: one line in this session's record's `## Decisions`:
      `F3 a1b2c3d4 2: defer`, `F5 a1b2c3d4 4: drop — <why>`, `F1 a1b2c3d4 1: keep — <done here | session title>`.
5. **Commit** the backlog and the records through `/git commit`.

## `pick B3 B7 …`: a new charter

Moves rows out of the backlog into one new session, whose charter they become.

1. Refuse an unknown or expired B-number, and refuse in a sub-session.
2. `mcp__ccd_session__start_session`, `initiation: "user_asked"` (the user named the rows),
   `context: "fresh"`, `use_worktree: true`. The `prompt` opens with
   `First run: worktree-flow adopt <base> — this worktree's base is <base>.`, then
   `Charter: B3 <What> (why: <Why>; ledger <Source>), B7 …`, then names the files and what done
   looks like, and closes with `When the work is done, run /close-out (/close-siblings first when
   you started sub-sessions).` A charter of more than three rows asks the new session to write it
   as `<sdlc>/<slug>-roadmap.md`, one row per item with its Source.
3. Only once the tool result says the session started: remove the rows from the backlog, write
   `picked B3 B7 (<Sources>) into <session title>` in this session's `## Decisions`, and commit
   through `/git commit`.

## `expire`

List the rows past **Until** with their B-numbers. On the user's word remove them (git history
keeps them), write `expired <Sources>` in this session's `## Decisions`, and commit through
`/git commit`. An expired row nobody picked was not needed; it is not moved back to the inbox.
