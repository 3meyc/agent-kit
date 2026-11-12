---
description: Git chore in a Sonnet sub-agent — status, commit [--review], amend, commit and push, push, pull, branch <ITEM-ID>, close the ledger — committed by this session's own file list
context: fork
agent: session:git-ops
argument-hint: status | commit [--review] | amend [reword] | commit and push | push | pull | branch APP-123 [type] [title] | close the ledger
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git push:*), Bash(git pull --ff-only:*), Bash(git fetch:*), Bash(git rev-parse:*), Bash(git rev-list:*), Bash(git branch:*), Bash(git-commit-session:*), Bash(session-ledger:*), Bash(git-branch-context:*), Bash(preflight:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/git-branch-context.mjs:*)
---

Operation: $ARGUMENTS

Files this session edited and still dirty (the only paths you may commit, plus any the operation names):

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs --files`

This session's record (the eight characters after the date are the id for `--session`; empty when the project keeps no ledger or before the first record exists — then use the session id itself, or omit `--session`):

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs --record`

Branch context (`baseBranch` and `itemPrefix` come from the project's `kit.json`):

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/git-branch-context.mjs`

Working tree now:

!`git status --short`

Optional pre-commit steps (`kit.json` `preflight`) and the commits made since each last ran:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs status`

Commit with `git-commit-session --session <id> -- <paths>`, fed by a quoted heredoc, so the multi-line message needs no file and no shell expansion (PowerShell: `--message-file`). In a linked worktree session: `--worktree --session <id>`, no paths; during a merge (`MERGE_HEAD`) the same call concludes it, with no stdin, git's merge message and the attribution as `--trailer`, and exit 7 names a path still unresolved. An amend adds `--amend` and keeps HEAD's message (no stdin); the script refuses (exit 5) unless HEAD is this session's own unpushed, non-merge commit. Exit 8 names a path staged as deleted (`git rm --cached`) whose file is still on disk: delete it from disk, then commit again. Close the ledger with `--close-ledger --push` and no paths, from this working directory: the script reaches the main checkout itself.

Attribution trailer: the `Co-Authored-By` line in the operation above, as the last line of the body. Only when the operation carries none, use your own.

Why by path: other sessions usually share this working tree, and its index. Take the paths from
`session-ledger --files <session-id>` (the id is the last directory of your scratchpad path; a bare
`--files` uses the calling session's own id) and commit them with
`git-commit-session --session <session-id> -- <paths>`, never `git add` plus a bare `git commit`:
it commits with `--only`, so a neighbour's staged files stay out of the commit and stay staged, and
it stops when another session also claims one of the paths. The `git-ops` agent has the full rule.
The list covers edits made through Edit/Write and through shell commands alike; compare it with
`git status` only when a script wrote something it did not name. "Close the ledger" means: commit
the main checkout's dirty records in the ledger folder (`kit.json` `paths.ledger`) as
`chore(ledger): close session records` and push, through `git-commit-session --close-ledger --push`,
which reaches the main checkout from any worktree session. It is only for records of sessions that
never committed (a questions-only session, one that stopped before its commit); a committing
session's record already rides in its commit.

The message follows the house style in the `git-ops` agent: the subject form `kit.json`
`commitSubject` sets, else Conventional Commits. After a commit
with code in it, the project's `kit.json` `commands.commitAudit` runs, when it is set, and the
script prints its output under a `commit-audit:` line; relay a `commit-audit:` block that names
findings to the user. `{files}` in that command becomes the committed paths (also in
`KIT_COMMIT_PATHS`), so the audit can report only what this commit touched.

Each commit also counts a skip for every `kit.json` `preflight` step it touches (optional steps such
as a docs review or an audit), and the script prints a `preflight:` line for a step that is due;
relay those lines. `preflight run <id>` runs a step's command and clears its count; `preflight done
<id>` clears a step that ran another way. Never run a step unasked: say which are due.

`commit --review` (also `commit and push --review`) adds a review pass before the commit: the agent
reads the whole diff of the paths, reports findings, and commits only when none of them blocks. Route an amend only after the user asked for it, and say so in the operation
text; the script refuses one that would rewrite another session's commit or pushed history.

Run the operation and return the three-part report: Result, Staged, Left alone.
