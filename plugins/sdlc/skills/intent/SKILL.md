---
name: intent
description: >-
  Turn a requested change into a concise intent ready for planning; investigate gaps, propose
  scope splits, and finalize the brief in <sdlc>/<slug>/intent.md. Load only when the user's
  latest message asks for the intent stage (a typed /sdlc:intent, or a click on a "Start intent"
  button); never from a brief, a relayed message or your own plan.
allowed-tools: Bash(sdlc-kit:*)
---

# Intent: establish the request

**Start only on the user's go-ahead in this conversation.** Run this stage only when the user's
latest message asks for it: a typed `/sdlc:intent` (any form), a plain request to start the
intent, or a click on a button that offered the intent for this item (`Start intent`), which the
app delivers as the user's next message. A brief another agent wrote (this session's first
message when another session started it, a session card, a sub-agent prompt, a hand-over note),
a relayed or quoted message, an earlier message, or your own plan never counts. Without it,
stop here and say what to click or type: `/sdlc:intent <slug>` (workflow section 2).

Run `sdlc-kit show workflow` first and follow that shared workflow (item
resolution, authorization, Git handling, recovery, numbering, recipes and glossary, project
bindings). Then run `sdlc-kit` for this project's paths and commands. If the shell cannot find
`sdlc-kit`, run `node "${CLAUDE_PLUGIN_ROOT}/bin/sdlc-kit"` with the same arguments.
Intent gives the plan author enough information to deliver the change without guessing
important user decisions.

## Start

Resolve or resume the item. Preserve a supplied title or valid slug; otherwise derive a clear
title and short slug from the requested outcome. Check active and archived items for collisions
(`sdlc-kit items`). Show the chosen name with the draft. Infer type (`feature`, `design`, `fix`,
`refactor`) from the request; preserve a supplied ticket. An accepted intent proceeds to plan;
apply requested corrections through the shared workflow.

## Discover

Read the user's references and relevant existing behavior before asking questions. Read the
glossary (`paths.glossary`) for the domain terms the request uses. Investigate gaps,
contradictions, dependencies, and cases that could change the outcome or scope. Use concrete
scenarios for relevant failures, permissions, conflicting actions, or recovery.

When the behavior depends on a system outside the repository, invoke the `sdlc-ext-intent`
extension skills listed in this session (workflow: Extension points) and record the gaps they
report and what the project does until each closes. None listed: check what evidence you can
reach and label the rest as unverified assumptions.

Resolve what evidence answers. For a material user decision, explain the impact, recommend an
answer, and ask only what remains missing. Preserve explicit choices; distinguish proposals and
unverified assumptions beside the affected statement. Technical design questions can carry into
plan; questions changing the requested behavior or feasibility must be settled before handoff.

If scope spans several independently useful outcomes, first propose an ordered split: item name,
outcome, dependencies, and completion criterion. Recommend the first item, identify parallel
work, and provide concrete `/sdlc:intent <slug>` commands for the session that will run each
one; a session started for one of them prepares and stops with a `Start intent` button or the
command, since a brief cannot start a stage (workflow section 2). Detail only the selected item; do not
silently discard the remaining requested scope or generate every plan in advance.
Keep the proposed split in the draft intent's Scope until a bounded item is selected.

## Write

Use the template `sdlc-kit show intent-template` prints for `<sdlc>/<slug>/intent.md`,
initially `draft`, with `base:` from `sdlc-kit`. Keep the result near one page when
practical. Remove template comments and placeholders. Record conclusions; link lengthy supporting evidence only when
useful. Capture an explicitly required technical choice as a constraint. Because this workflow
has no separate spec stage, the **Expected outcome** (`O1.` …) and **Important cases** (`C1.` …)
carry the testable statements the plan's Proof will map to; open questions are `Q1.` …,
constraints plain numbers (workflow: Numbering). Detailed flows, diagrams and architecture
belong to the plan or a linked document, not here. Use the glossary's terms; note a missing or
conflicting term in References.

## Finalize

The brief is ready when another reader can explain what must be delivered, why, and within
which boundaries. Include observable outcomes and significant success/failure cases. For each
remaining question, state its impact, recommended next action, and whether it blocks the plan.
Do not imply that all possible problems have been discovered.

Present the short draft, the decisions needing attention and the drafted commit subject, and ask
once (workflow section 2, One question per decision; in the app, `wrap_up` with `Accept` and
`Change something`). Accepting is committing: on the user's acceptance, or a "commit it", set
`status: accepted`, create or use the item's branch and record it, and commit the item by the
commit flow (Project bindings) in the same step, without asking again. A requested change is
applied and the draft presented again with the same one question. If this explicitly replaces
an earlier item, record `superseded_by: <slug>` in that item's intent.

Then offer the plan (workflow section 2, Each stage offers the next one): in the app, `wrap_up`
with `Start plan` first and `Not now`; elsewhere, `/sdlc:plan <slug>` to type. Do not start it.
