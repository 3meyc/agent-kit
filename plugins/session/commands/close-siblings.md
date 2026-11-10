---
description: Land the work of this session's side sessions — review each sub-session and its branch, merge the finished ones into this branch, run the checks on the merged tree, land this branch on its base, push on the user's word, and archive the merged sub-sessions
argument-hint: [base] [land | land and push]
allowed-tools: Bash(worktree-flow:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-flow.mjs:*), Bash(git status:*), Bash(git log:*), Bash(git merge-base:*), Bash(git rev-parse:*), Bash(git branch -d:*), Bash(gh run list:*), Bash(gh run view:*), Bash(gh run watch:*), Bash(gh api repos/:*)
---

Arguments: $ARGUMENTS

This worktree and every other one:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-flow.mjs status`

Predicted conflicts with the base and with the other active worktrees (committed work only):

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-flow.mjs conflicts`

Change no code except to resolve a merge. Never force, reset, rebase or stash. Push only when the
user's answer says push. The base is the argument, else the SDLC item's `base:`, else what
`worktree-flow base` recorded or guessed (`kit.json` `baseBranch` wins a tie). The session tools
below exist in the desktop app; elsewhere, ask the user which branches are the sub-sessions'.

## 1. Review the sub-sessions

1. `mcp__ccd_session_mgmt__list_sessions` with `linked: true`, `include_archived: true`. The
   sub-sessions are the ones this session started and their descendants (follow `startedBy`);
   leave the sessions of this session's parent and siblings alone.
2. Per sub-session: `isRunning`, its branch, `git -C <cwd> status --porcelain`, and its last report
   (`mcp__ccd_session_mgmt__list_events` when the note was cut). **Finished** means idle, nothing
   uncommitted, and a last report that names no running or pending work.
3. Per branch: `git log --oneline HEAD..refs/heads/<branch>`, and which branches already contain
   HEAD or each other (`git merge-base --is-ancestor`). Merge only the outermost branch; the ones it
   contains come along.
4. Read every commit that changes a test, an e2e spec, an eval expectation or a rule. A loosened
   expectation needs the user's decision recorded in the commit or its evidence; without it the
   branch is not finished.
5. Per finished sub-session, its record's open `## Next` (found by its branch, when the project
   keeps a ledger): each item is done here, proposed as a card, or left in that record and named,
   exactly as `/close-out` § 1 (Children's follow-ups) says. A sub-session with an open parent
   proposes no cards of its own, so these items reach the user only through this step.
6. Show one table: session (linked), branch, tip, commits ahead, finished or why not, open
   follow-ups.

## 2. Merge into this branch

1. Require a clean tree here; commit this session's own files first through `/git commit`, on the
   user's word.
2. Fast-forward when the branch contains HEAD (`git merge --ff-only refs/heads/<branch>`), else
   `git merge --no-ff --no-edit refs/heads/<branch>`. Always the full `refs/heads/` ref.
3. A conflict is resolved here only when both sides' intent is clear; otherwise
   `git merge --abort`, report the files and leave that branch out.

## 3. Check

Run the project's checks for every path the merges changed: the commands in `kit.json` `commands`
(`check`, `lint`, `test`, and `build` when a merged branch touched the build), or the project's
own `/check` command when it has one. Then each `session-ext-close-out` skill listed in this
session, in name order, the same project steps `/close-out` § 1 runs. A failure stops § 4: report
it with its output.

## 4. Land on the base

1. `worktree-flow land --dry-run`. When the base has commits this branch lacks, merge them in here
   (`sync_with_base_branch` with `base: <base>`, or `git merge --no-edit <base>`), run the checks
   again and dry-run again.
2. `worktree-flow land`: a fast-forward of the base, nothing else. If it refuses (an uncommitted
   edit in the base's checkout), report the file; the user settles it.
3. Push the base (`/git push` from its checkout, or `git push origin <base>`) only when the user's
   answer said push. Never push the sub-session branches: the base carries them now.
4. After that push, wait for the CI run on the pushed commit exactly as `/close-out` § 2
   step 6 does (one background `gh run watch`; red is reported and holds this session's archive;
   a run cancelled by a newer push hands over to the newest run that contains the commit).
   The sub-sessions skipped that wait, so this run is the CI proof for their work too. Skip it
   when nothing was pushed, the repository has no CI, or this session is itself a child session
   (`/close-out` § 2 step 6): its own parent waits.

## 5. Archive

`mcp__ccd_session_mgmt__archive_session` for each finished sub-session whose branch is now in the
base, the last-started first, with the reason `merged into <base> (<hash>)`. Never archive this
session, an unfinished sub-session, or a session outside this session's family. Then
`worktree-flow status`: a merged worktree no session owns goes with `worktree-flow remove <path>`,
only after the user agreed; it deletes the worktree's branch too.

Last, the merged sub-session branches that are left: list each local `refs/heads/<branch>` from
§ 1 that the base now contains (`git merge-base --is-ancestor <branch> <base>`), and on the user's
word delete them with `git branch -d <branch>`, never `-D`. Git refuses a branch still checked out
in a worktree (an archived session's, kept in the app's reuse pool): leave it and name it.

## 6. Ask once, then report

Before § 4, end the turn with `mcp__ccd_turn__wrap_up` (or one closing question outside the app):
the recap is the review table's counts and the check result; the ask is the one decision left,
with the buttons "Land, push, archive" (push, then wait for the CI run, § 4 step 4) and "Land and
archive" (no push); a child session offers only the second. The user's click authorizes exactly
what its message says.

After it is carried out, report as numbered lists: merged (branch → commit), the base and its new
tip, check results, pushed or not and the CI run's result, archived sessions (linked), the ones
left alone with the reason, and the sub-sessions' follow-ups (done here, carded, or left in their
record with `<id8> <n>`).
