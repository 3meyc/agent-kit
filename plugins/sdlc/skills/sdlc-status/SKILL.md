---
name: sdlc-status
description: >-
  Read SDLC work-item records and version history to report each item's current stage,
  blockers, drafts, and next action without changing anything. User-invoked only.
disable-model-invocation: true
allowed-tools: Bash(sdlc-kit:*)
---

# Status

Run `sdlc-kit show workflow` first and follow that shared workflow (item
resolution, comparison base, lifecycle states, project bindings, existing-format
compatibility). Change nothing.

## Gather

- Run `sdlc-kit items` (if the shell cannot find it:
  `node "${CLAUDE_PLUGIN_ROOT}/bin/sdlc-kit" items`). It lists active items under
  `paths.sdlc` with the committed and working-tree lifecycle state of each document, the
  committed checkbox count of each plan, and the archived items. Treat it as a
  starting point and read the records where it reports a difference or an error.
- Inspect the current branch, working-tree changes, and active and archived items.
  Respect an explicit item selection. Without one, show the current branch's item;
  on the base branch, include active items on other local branches.
- Read committed records for completion. Inspect working drafts separately, including
  untracked documents; show them even when no committed item exists. A working-tree
  checkbox may reflect an incomplete or failed commit and never counts as completed.
- Read implementation checkboxes throughout the plan, including legacy headings and
  appended review/verifier steps. Do not count checklists in copied examples or evidence.
- Resolve each blocker using its `resolved:` note and current evidence. Show an
  unresolved blocker before the ordinary next stage; do not edit records to clear it.
- Detect archived items on local branches and whether their archive commit is included
  in the base branch. A surviving branch alone does not mean work is unmerged.

## Derive

| Committed evidence | Stage / next action |
| --- | --- |
| No item or draft only | Not started or working draft; `/sdlc-intent <slug>` |
| Intent draft | Intent review; `/sdlc-intent <slug>` |
| Intent accepted; no plan | Ready for plan; `/sdlc-plan <slug>` |
| Plan draft | Plan review; `/sdlc-plan <slug>` |
| Approved plan with unchecked implementation steps | Building; `/sdlc-build <slug>` |
| Unresolved blocker | Blocked; name what resolves it and the affected stage |
| Approved plan with all steps committed | Ready to finish; `/sdlc-finish <slug>` |
| Done metadata with incomplete archive | Finish incomplete; `/sdlc-finish <slug>` |
| Archived, commit absent from base | Done, unmerged; authorized merge remains |
| Archived, commit included in base | Done |

An item with a hand-added `spec.md` follows the same table; a draft spec is reported as a
working draft beside the intent. Use documents' actual lifecycle fields and authorized
corrections; conflicting records are incomplete state, not approval. Missing independent
verification stays pending; do not infer a pass from completed build steps or assume a custom
reviewer exists.

## Report

Keep the output short: current branch and dirty state, then one line per selected item:
`<slug> · <stage> · <completed>/<total> steps, when planned · next: <action>`.
Mention working drafts or ticks separately from committed progress. Include only
actionable blocker details. Summarize older archives as a count when listing them
would obscure current work. Do not run checks or modify files to improve the status.
