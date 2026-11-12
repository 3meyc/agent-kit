---
description: Close out a worktree session — resume of done / follow-up / not-done work, then land on the base branch, propose follow-up sessions, push on the user's word, and end with a where-what-why session resume before the archive. Runs after /sdlc:finish
argument-hint: [slug] [land | land and push | land, push and archive] [with diagram]
allowed-tools: Bash(worktree-flow:*), Bash(session-ledger:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-flow.mjs:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), Bash(gh run list:*), Bash(gh run view:*), Bash(gh run watch:*), Bash(gh api repos/:*), Bash(kit-repo:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/kit-repo.mjs:*), Bash(gh repo view:*)
---

Arguments: $ARGUMENTS

This worktree and every other one:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-flow.mjs status`

Predicted conflicts with the base and with the other active worktrees (committed work only):

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-flow.mjs conflicts`

What landing would do now:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-flow.mjs land --dry-run --report`

Files this session edited and still dirty, and its record:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs --files`

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs --record`

Where things are comes from the project's `kit.json`: `baseBranch` (default `dev`), the SDLC
items in `paths.sdlc` (default `docs/sdlc`), the ledger in `paths.ledger` (default
`.claude/ledger`, and only when `"ledger": true`), recipes in `paths.recipes`, and the checks in
`commands` (`check`, `test`, `build`). Below, `<sdlc>` and `<ledger>` stand for those paths.

## 1. Resume

Build it from evidence, not memory: the SDLC item when there is one (`<sdlc>/archive/*-<slug>/`
after `/sdlc:finish`, else `<sdlc>/<slug>/` — unchecked plan steps, the Review's finding
dispositions, any `PENDING` gate), this session's record (`## Next`), the open `## Next` of every
child it started (below), and what the user asked for in this conversation. Sort every item into
exactly one bucket and show the three as numbered lists, empty ones as "None":

1. **Done** — asked for, built, verified. One line each, with the check that proved it.
2. **Follow-ups** — real, self-contained work found along the way: deferred review findings,
   enhancements, inherited defects. Each gets a session proposal (step 3), not just a line.
3. **Not done** — asked for but missed, failed, or with a gate still open, each with why and its
   entry point (`/sdlc:build <slug>` …). Anything here blocks landing unless the user overrides.

**Children's follow-ups.** A child with an open parent leaves its follow-ups to that parent (§ 3),
so the parent reads them. In the desktop app, `mcp__ccd_session_mgmt__list_sessions` with
`linked: true`, `include_archived: true` lists the sessions this one started, and the record of
each that landed is `grep -l "^branch: <its branch>$" <ledger>/*.md` (on the base now). Every open
item in that record's `## Next` lands in one place: small and in this session's area, it is done
here and marked with `session-ledger --done <id8> <n>` (Done); self-contained, it becomes a § 3
card (Follow-ups); otherwise it stays in that record, named in Follow-ups with its `<id8> <n>`.
None is dropped unnamed: the app's note quotes only the start of a child's report, so the record,
not the note, is the source.

**Kit gaps.** A follow-up whose fix belongs to a kit (a skill, hook, rule, recipe or script an
installed plugin supplies from the plugin cache, not a file of this repo) is neither a `## Next`
item nor a § 3 card: it is an issue in that kit's repo, the one list of every project's gaps.
For each:

1. `kit-repo <plugin, plugin@marketplace or the kit file's path>` names the repo from the
   plugin's marketplace source.
2. Draft it by the kit's `kit-gap` template: title `<plugin>: <the gap>`; body sections Plugin,
   File, What happens, What should happen, Found in. When the kit's repo is public, Found in
   describes this project generically (stack, plugins, the stage that ran), never by name, link
   or domain detail.
3. Show the drafts under Follow-ups; the § 5 question opens them. On that word,
   `gh issue create --repo <owner/repo> --label kit-gap --title "<title>" --body-file <draft in the scratch folder>`
   (a repo without the label takes it without, and the resume says so), and the record's
   `## Decisions` names each `owner/repo#n`.
4. When `kit-repo` names no repo, `gh` is missing or signed out, `gh repo view <owner/repo>`
   fails, or the user leaves them out, the gap goes to the record's `## Next` as
   ``kit gap, not opened (<reason>): <title>``, so a later session opens it. Such an item from an
   earlier record is retried here the same way and marked done once opened.

**Project steps.** Each `session-ext-close-out` skill listed in this session (the project's own, or
an overlay plugin's) runs here, in name order, before anything lands: load it and do what it says.
What it finds goes into the three buckets like everything else; a step it marks as required and
that failed is Not done. With no such skill, there are no project steps.

## 2. Land, when Not done is empty or the user says land anyway

Merge back into the integration branch one branch at a time: the base is merged into the worktree
branch first, so a conflict is resolved in the worktree that made the change, then
`worktree-flow land` fast-forwards the base — the integration branch never takes a conflicted
merge. `worktree-flow conflicts` predicts conflicts with the base and every other active worktree
before that; run it before starting a second session on the same files. Ledger records never
conflict (one file per session). The brief also reads every other worktree's unmerged records, so
a file a neighbour touched there is flagged here too.

1. Uncommitted session files: commit them first through `/git commit`, with the ledger record
   written (format: `/handoff`) — an uncommitted record is lost when the worktree goes.
   Commit only on the user's word: the close-out question below (§ 5) carries it, so one answer
   commits and lands, never a commit question followed by a landing question.
2. The landing preview above says the base has commits this branch lacks: bring them in here, so any
   conflict is resolved by this session, in this worktree — the app's `sync_with_base_branch` with
   `base: <base>`, or `git merge --no-edit <base>` when the app refuses that base. Resolve, run the
   project's checks, conclude the merge with `/git commit` (a conflicted path resolved by hand is
   `git add`ed by the user first; exit 7 names any left), and dry-run again. When the session
   started in a worktree cut from an older commit (its SessionStart said `starts <n> commit(s)
   behind <base>` and it was not adopted), its work was done against older files: name that in
   the resume, and check the merged base's changes to the files this session touched
   (`git diff <merge-base>..<base> -- <those files>`) before step 3.
3. Run the project's checks on the branch as it will land (after the base is merged in): every
   command in `kit.json` `commands` that CI also runs (`check`, `lint`, `test`, `build`), or the
   project's own `/check` command when it has one, so a failure is caught here rather than on the
   base. A failure the session introduced is fixed and committed first; one it did not (the base
   already fails) is named in the resume. Either stops the landing until fixed or the user says
   land anyway; a step not run is reported as such.
4. `worktree-flow land` — a fast-forward of the base, nothing else. It refuses when the checkout
   holding the base has an uncommitted edit in a file the landing changes: report that file; the
   user settles that checkout.
5. Push the base (`/git push` from the checkout holding it, or `git push origin <base>`) only when
   the user's answer said push. Never push the session branch for a landed change: the base
   carries it now.
6. After a push from a **top-level session**, wait for the CI run on the pushed commit, when the
   repository has CI. A **child session** skips this step: `mcp__ccd_session_mgmt__get_session`
   with `"self"` shows a `parentSessionId` and `detached` not `true` (a proposal card,
   `start_session`, a side session), or its base (`worktree-flow base`) is another session's
   `claude/*` branch, which it lands into and never pushes. Its parent pushes and waits for the run
   (`/close-out`, or `/close-siblings` § 4); a push the user asked for in the child is named with
   its commit in the resume, so the parent's run covers it. **A parent that is archived no longer
   pushes**: `get_session` on the `parentSessionId` shows `isArchived: true` (or no session) — a
   card the user started after its proposer was archived, or a parent archived since. Such a
   session is top-level for this step and for § 5's buttons, and its base is an integration
   branch, not a `claude/*` one. Find the run with
   `gh run list --commit "$(git rev-parse <base>)" --json databaseId,workflowName,status,conclusion,url`
   (it can take a few seconds to appear; list again once), then one
   `gh run watch <id> --exit-status` with `run_in_background`, so its exit wakes this session: no
   polling loop. When `gh` answers "not found", the active account cannot see the repository; say
   so. Green: one line in the resume. Red: `gh run view <id> --log-failed` names the job, step and
   cause; that run is a Not done item, and the archive waits for the user's word. **Cancelled is
   not red** when the workflow cancels a run in progress for a newer push to the same branch: take
   the newest run on the base (`gh run list --branch <base> -L 1 --json databaseId,headSha,status,url`),
   confirm it contains the pushed commit
   (`gh api repos/{owner}/{repo}/compare/<pushed>...<its headSha> --jq .status` is `ahead` or
   `identical`), and watch that one the same way. Follow at most two such hand-overs; after that,
   name the jobs and steps that passed before each cancel and the newest run's link as not waited
   for, and let the user decide the archive. No push, no CI, or a child session: skip this step.
7. Archive this session (`mcp__ccd_session_mgmt__archive_session`, `session_id: "self"`) only when
   the user's answer said archive, and only once `worktree-flow status` shows this worktree clean
   and merged — the app takes the worktree back (detached into its reuse pool, which it reuses or
   reaps), and nothing is lost because the base holds every commit. After a push from a top-level
   session, the archive also waits for step 6's run to finish green. **Children hold it too**:
   `mcp__ccd_session_mgmt__list_sessions` with `linked: true` lists the sessions this one started,
   and one still working, or one that landed on the base after this session's push
   (`git log origin/<base>..<base>` lists commits), is owed this session's push and CI wait.
   Name it in the resume and let the user decide; a click on "Land, push, archive" covers this
   session's own push, not the children's. A § 3 card the user has not started does not hold the
   archive: started later, it finds its parent archived and pushes itself (step 6). It ends this
   conversation, so it is the last call: the session resume (§ 6) is the message right before it.

Outside the desktop app there are no session tools: skip the parts that need them, land, and say
what is left for the user to do (push, remove the worktree).

## 3. Follow-up sessions

One `mcp__ccd_session__start_session` per follow-up, `initiation: "own_initiative"`,
`context: "fresh"`, `use_worktree: true` — after the landing when there is one, so the base
already holds this work. A proposal card may be cut from the repository's default branch rather
than `<base>` when the user starts it, which is why its first line must be the `adopt <base>` line
below; `adopt` steps past the files the SessionStart hooks already wrote (`.codegraph/`, the
ledger's `INDEX.md`). Its `prompt` names the files, what done looks like, and the entry point
(`/sdlc:intent <new-slug>` for anything that needs an agreed outcome first), opening with
`First run: worktree-flow adopt <base> — this worktree's base is <base>.`
and closing with `When the work is done (after /sdlc:finish for an SDLC item), run /close-out.`
Three proposals per turn at most; any further ones go to the record's `## Next`.

A **child with an open parent** (§ 2 step 6) proposes no cards: each follow-up goes to its
record's `## Next`, and its § 5 recap names them in a few words each, so the parent's note shows
them; the parent takes them (§ 1, Children's follow-ups). A child whose parent is archived
proposes them here, as a top-level session does.

## 4. Other worktrees

`worktree-flow status` is the clean-up list: `✓` marks a clean worktree whose commits are all in
its base. A session still in the app goes by archiving it: the app detaches its worktree into its
reuse pool and reuses or reaps it itself, and `status` shows those as pool, not `✓`; an orphaned
worktree goes by `worktree-flow remove <path>`, which refuses anything unmerged or dirty. A
session that stopped before its last commit leaves its record dirty, and `status` names it, since
it goes with the worktree.

From `status`, list the worktrees marked `✓` (merged, clean). Offer to clear them in one line:
a session still in the app is archived through `archive_session` (find it with
`mcp__ccd_session_mgmt__list_sessions` by branch), only after the user agreed — a pinned one is
refused until unpinned, and the app then keeps the worktree detached in its reuse pool rather than
deleting it; a worktree no session owns any more goes with `worktree-flow remove <path>`, which
refuses anything unmerged or dirty. Never remove one marked `·`.

## 5. Ask once

End with `mcp__ccd_turn__wrap_up` (in the desktop app; elsewhere, one closing question): the
recap is the three bucket counts and the land state; the ask is the one decision left. With Not
done empty the first button is "Land, push, archive" (message: land on `<base>`, push `<base>`,
wait for its CI run, then archive this session) and the second "Land only". In a child session
(§ 2 step 6) the first is "Land and archive" (message: land on `<base>`, then archive this
session; the parent pushes and waits for the CI run); with Not done items, the first button
continues the work and the second lands anyway. Drafted kit gaps (§ 1) ride on the first button:
its message also says to open them; the other answers leave them in `## Next` as not opened.
Uncommitted session files (§ 2 step 1) ride on every landing button the same way: its message
starts with committing them through `/git commit`, so the click accepts and commits in one
answer. The user's click is the authorization for exactly what its message says, nothing more.

## 6. Session resume, the last message before the archive

Once the user's answer is carried out (landed, pushed when asked, its CI run reported in a
top-level session), and before `archive_session` when they asked for it, write one chat message
for a reader who did not follow the session: what changed in the repo and why, at the level of the
product or the way of working, not of git.

1. **Sources, not memory.** The _what_ comes from the commit subjects since the base
   (`git log <base>..HEAD --format=%s`) and the archived item's plan; the _why_ from the intent's
   "What to implement", the plan's Deviations and the record's `## Decisions`. Nothing that is
   not in one of those goes in. A plan Deviation (`IMPROVED`, `FORCED`, `BLOCKED`) is quoted as
   its line's _why_ verbatim, not reworded: it is already a "what — why".
2. **Every line is "Where: what — why".** The _where_ is a recipe or area name from the project's
   recipe index (`kit.json` `paths.recipes`) when one covers it, so resumes read alike across
   sessions; otherwise the command, hook, rule, skill, agent, page, store or feature name — not a
   file path unless the file is the area. The _why_ is the reason the change was made, in a few
   words. Example:
   `report-export: failed rows listed after the run — users could not tell which rows were skipped.`
3. **Four lists, in this order, each numbered, empty ones left out:**
   1. **Major changes** — at most seven lines, one per outcome the user would notice.
   2. **Process changes** — every file changed since the base under the ledger's process paths
      (`PROCESS_PATHS` in the plugin's `lib/hook-utils.mjs`: `CLAUDE.md`, `AGENTS.md`, `kit.json`,
      `.claude/{commands,agents,rules,skills}`, `.claude/settings.json`, `.mcp.json`), from
      `git diff --name-status <base>..HEAD -- <those paths>`. Here the file is the unit: one line
      per file, its name and a few words on the change, e.g. `close-out.md — added § 6 resume`. A reader
      checks this list to know what changed in how the repo is worked on.
   3. **Chores and small fixes** — one short line each, a few words after the "where"; a dozen at
      most, the rest folded into one line ("and four doc touch-ups").
   4. **Follow-ups** — the same lines as the record's `## Next`, each with its entry point, and
      the reason it was left.

   An optional closing line, **Lessons**, names one or two things recorded in memory or in the
   record's Decisions that change how the next session works.
4. **Leave out** branch names, commit hashes and counts, push and ledger state, test counts, and
   anything the § 1 buckets or the wrap-up recap already carried. "Landed" is implied by reaching
   this step.
5. **A flow diagram only on request** (`with diagram` in the arguments, or asked in chat): the
   session's stages as a flowchart (at most six boxes, labels of a few words) before the lists. It
   costs tokens on every close-out, so it is never drawn unasked.
6. **Under 250 words** without the diagram. Full sentences only where a line needs a reason;
   no headings inside the message, the list names are enough.
7. **Chat only.** The resume is not written into the record or the item: the record's Intent,
   Decisions and Next hold the same facts for agents, and a second copy would rot (the reason the
   record has no Result section). `/handoff --export` renders the same format for a reader
   outside the repo.
