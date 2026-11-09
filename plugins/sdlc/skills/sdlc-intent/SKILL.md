---
name: sdlc-intent
description: >-
  Turn a requested change into a concise intent ready for planning; investigate gaps, propose
  scope splits, and finalize the brief in <sdlc>/<slug>/intent.md. User-invoked only.
disable-model-invocation: true
allowed-tools: Bash(sdlc-kit:*)
---

# Intent: establish the request

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
work, and provide concrete `/sdlc-intent <slug>` commands. Detail only the selected item; do not
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

Present the short draft and decisions needing attention. Once accepted under the shared
authorization rules, set `status: accepted`, create or use the item's branch and record it, and
commit the item by the commit flow (Project bindings). If this explicitly replaces an earlier
item, record `superseded_by: <slug>` in that item's intent. Give the next command:
`/sdlc-plan <slug>`.
