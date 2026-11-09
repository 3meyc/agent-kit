---
name: sdlc-build
description: >-
  Implement an approved SDLC plan step by step, record verification and deviations, and prepare
  the completed item for independent review. User-invoked only.
disable-model-invocation: true
allowed-tools: Bash(sdlc-kit:*)
---

# Build

Run `sdlc-kit show workflow` first and follow that shared workflow (item
resolution, ownership, authorization, recipes and glossary, project bindings, existing-format
compatibility). Then run `sdlc-kit` for this project's paths and commands. If the shell cannot find
`sdlc-kit`, run `node "${CLAUDE_PLUGIN_ROOT}/bin/sdlc-kit"` with the same arguments.

## Start or resume

1. Read the committed intent, a spec and linked use cases if present, and the plan. Require
   an approved plan. Resolve recorded blockers against current evidence and authorization.
2. Start at the first unchecked committed implementation step. A working-tree tick is
   unfinished work; preserve its edits and recover the missing check or commit.
3. Read affected code before changing it, and the recipe the plan's Design notes name.
   Establish ownership of existing edits and preserve unrelated work — other sessions may
   share the working tree.

## Implement each step

1. Implement the planned outcome within the project's design rules (Project bindings).
   For a bug, first run a reproducing test and observe its expected failure.
2. Run the step's check and applicable project checks (`kit.json` `commands`). Preserve
   behavioral assertions; explain any correction to an incorrect test. Never weaken a test to
   pass.
3. Retain concise evidence: command, expected and observed result, and useful output.
   Put substantial output and red-phase evidence in optional `evidence.md`, linked from
   the plan. Existing red-phase evidence in commit bodies remains valid.
4. Keep documents current in the same step: a new or renamed domain term, enum value or
   identifier updates the glossary; a recipe that proved wrong or incomplete is fixed when it
   is the project's own, and recorded as a follow-up for its kit when a kit supplies it
   (workflow section 5).
5. Update the checkbox only after its expected result is observed. Commit code, tests,
   documents, the checkbox, and relevant record updates together by the commit flow (Project
   bindings) — with the `session` plugin its `/git commit`, without it plain git by explicit
   path. Build commits as soon as the check passes unless the project requires approval.
   Group small steps into one commit when the project's convention calls for a work batch.
6. Verify the commit succeeded. Uncommitted ticks never establish completion.

## Changes and blockers

- Record an `IMPROVED` or `FORCED` deviation with the reason, evidence, and affected
  steps. Update future steps and linked documents when the implementation changes them.
- Keep completed steps and their evidence historical; append corrections. A changed
  implementation may preserve scope, but changed behavior or acceptance criteria need
  existing or new user authorization before updating the affected agreement.
- For a blocker, keep the step unchecked and record `BLOCKED`: reason, impact, and
  what resolves it. Commit only the owned record change when permitted; preserve
  unfinished implementation edits. Continue independent authorized steps where useful.
  Add `resolved: <evidence>` when the cause is cleared.

## Complete

1. When all implementation steps are committed, run the plan's Proof and required
   project checks. Reuse results only when they cover the unchanged revision and scope.
   Commit any final record updates before delegation.
2. Request a fresh simplification pass from this plugin's `sdlc-simplifier` agent. Give it the
   item path, repository, base and revision, and tell it to read its contract with
   `sdlc-kit show simplification` and the workflow with `sdlc-kit show workflow`. It may use
   the host `simplify` skill within the contract's limits. Wait for its result. Run
   shared-checkout checks sequentially. Where the agent is unavailable, run the contract and
   the shared workflow in a fresh session by hand.
3. Simplification is optional; report an unavailable or skipped pass. Required Proof
   remains a gate. Summarize changes, checks, and remaining issues, then name
   `/sdlc-finish <slug>` as the next stage when ready.
