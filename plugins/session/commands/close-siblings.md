---
description: Land the work of this session's side sessions — review each sub-session and its branch, merge the finished ones into this branch, run the checks on the merged tree, land this branch on its base, push on the user's word, archive the merged sub-sessions and delete their merged branches, locally and on origin
argument-hint: [base] [land | land and push]
allowed-tools: Bash(worktree-flow:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-flow.mjs:*), Bash(preflight:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs:*), Bash(session-ledger:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs:*), Bash(git status:*), Bash(git log:*), Bash(git merge-base:*), Bash(git rev-parse:*), Bash(git branch -d:*), Bash(gh run list:*), Bash(gh run view:*), Bash(gh run watch:*), Bash(gh api repos/:*)
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
   proposes no cards of its own, so these items reach the user only through this step. Its
   `mark done: <id8> <n>` and `for the parent: <file>: <edit>` items are the main-session edits
   it left to this session (`/close-out` § 1, Main-session steps); § 2 step 4 carries them out.
6. Show one table: session (linked), branch, tip, commits ahead, finished or why not, open
   follow-ups.

## 2. Merge into this branch

1. Require a clean tree here; commit this session's own files first through `/git commit`, on the
   user's word.
2. Fast-forward when the branch contains HEAD (`git merge --ff-only refs/heads/<branch>`), else
   `git merge --no-ff --no-edit refs/heads/<branch>`. Always the full `refs/heads/` ref.
3. A conflict is resolved here only when both sides' intent is clear; otherwise
   `git merge --abort`, report the files and leave that branch out. A conflicted generated file
   is never resolved by hand: `worktree-flow regenerate` rebuilds each one a `kit.json`
   `regenerate` rule names (after its sources are resolved) and stages it.
4. After the last merge, the main-session edits the sub-sessions left (§ 1 step 5), once, on the
   merged tree: `session-ledger --done <id8> <n>` for each `mark done:` item, the edit each
   `for the parent:` item names (a changelog line, a roadmap or `<sdlc>/*.md` tick, a release
   note), then `session-ledger --done <child id8> <k>` for the item itself (add `--in-child` when
   this session is itself a sub-session). A changelog line comes
   from the merged branches' commit subjects when a child left none. Commit them through
   `/git commit` before § 3.

## 3. Check

The sub-sessions ran `check`, `lint` and the tests their changes touched; the steps that need the
whole tree run here, once, after the merges and before § 4's push:

1. **Checks.** The commands in `kit.json` `commands` on the merged tree: `check`, `lint`, the
   whole `test` suite, and `build`; or the project's own `/check` command when it has one.
2. **Main-session preflight.** Each step `preflight status --scope main` lists with commits since
   its last run: `preflight run <id>` when it has a command, else what its description says
   (a docs-review skill, say) over the diff since `git merge-base HEAD <base>`, then
   `preflight done <id>`.
3. **Deferred extensions.** Each `sdlc-ext-preflight` and `sdlc-ext-docs` skill whose description
   says `Main session only.` (a sub-session's plan Review names them as deferred to the parent),
   against the same merge base. With no merged SDLC item, a skill that needs an item path gets
   the merged items' archive paths, else none.
4. **Project steps.** Each `session-ext-close-out` skill listed in this session, in name order,
   the same project steps `/close-out` § 1 runs, including those marked main session only.

Fixes these steps make are committed through `/git commit`, then step 1 runs again. A failure
stops § 4: report it with its output.

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

Then the same branches on `origin`, which nothing else deletes:

1. **List.** `worktree-flow stale-remote --base <base> <branch>…` with § 1's branches and every
   `claude/*` branch the sub-sessions pushed under another name (their reports name it; the
   listing without names covers every `claude/*` on origin). It fetches origin and marks a
   branch stale only when `origin/<base>` holds it, or when `gh` shows its PR merged into `<base>`
   at origin's tip (a squash merge). It keeps `main`, `dev`, the base and the other integration
   branches, a branch checked out in another worktree, and one with commits the base lacks, each
   with the reason. It deletes nothing.
2. **Ask.** § 6's question shows this list, run with `--landing` before § 4 (what HEAD holds counts,
   since the landing and its push bring it to `origin/<base>`), so one click covers the archive and
   the remote branches.
3. **Delete.** After § 4, run the listing again without `--landing`. Delete only branches the click
   covered and the second run still marks stale, in one visible command:
   `git push origin --delete <b1> <b2> …`. Never force, never a branch the listing kept. Without a
   push, only the ones already stale before the landing go.
4. **Report** each deleted branch, and each one kept with the listing's reason.

## 6. Ask once, then report

Before § 4, end the turn with `mcp__ccd_turn__wrap_up` (or one closing question outside the app):
the recap is the review table's counts and the check result; the ask is the one decision left,
with the buttons "Land, push, archive" (push, then wait for the CI run, § 4 step 4) and "Land and
archive" (no push); a child session offers only the second. When § 5's listing names stale
remote branches, the recap names them and each button's message ends with "delete the stale
remote branches <b1> <b2> …", so the same click covers them. The user's click authorizes exactly
what its message says; the `git push --delete` still goes through the normal permission ask.

After it is carried out, report as numbered lists: merged (branch → commit), the base and its new
tip, the main-session edits made for the sub-sessions (§ 2 step 4), check, preflight and extension
results (§ 3), pushed or not and the CI run's result, archived sessions (linked), the ones
left alone with the reason, the remote branches deleted and kept (with the reason), and the
sub-sessions' follow-ups (done here, carded, or left in their record with `<id8> <n>`).
