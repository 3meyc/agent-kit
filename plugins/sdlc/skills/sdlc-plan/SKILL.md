---
name: sdlc-plan
description: >-
  Turn an accepted intent into a concise implementation checklist with explicit files, order of
  work and completion proof in <sdlc>/<slug>/plan.md. User-invoked only.
disable-model-invocation: true
allowed-tools: Bash(sdlc-kit:*)
---

# Plan: implement and prove the change

Run `sdlc-kit show workflow` first and follow that shared workflow (item
resolution, authorization, Git handling, recovery, numbering, recipes and glossary, project
bindings). Then run `sdlc-kit` for this project's paths and commands. If the shell cannot find
`sdlc-kit`, run `node "${CLAUDE_PLUGIN_ROOT}/bin/sdlc-kit"` with the same arguments.
The plan explains delivery and verification; it links behavior and constraints instead of
repeating them.

## Start

Require an accepted intent; read a `spec.md` and linked use cases if the item has them. Resume
an existing draft; an approved plan normally proceeds to build. Apply requested corrections
through the shared workflow.

**Look for a recipe first.** Read the recipe index (`paths.recipes`, its `README.md` or
`index.md`) and pick the recipe that matches this change, if any. Follow it when choosing steps
and record it in Design notes; write `none matched` when nothing fits. When the task is likely
to recur and has no recipe, plan a step that writes one and adds it to the index.

Inspect affected code and tests before choosing steps. Answer the project's design-rules
checklist (Project bindings: Design rules) for this change — ownership, boundaries, smallest
solution, evidence — in the plan, briefly. Resolve routine design choices with evidence. A gap
that changes required behavior returns to the intent and receives any missing authorization
before dependent planning continues.

## Draft

Use the template `sdlc-kit show plan-template` prints. Keep the plan focused on current
implementation:

- **Files that change:** actual paths, change type, and responsibility; include required
  documents (Project bindings: Documents — glossary, recipes, decision records) and tests.
  Explain new boundaries or dependencies only where the change needs them, and name the module
  that owns each new file. For every existing symbol the change removes, renames or changes the
  signature, shape or meaning of, run the project's impact check and account for each dependent
  it reports: a file that changes, or a one-line reason it is unaffected. Record the command
  and symbol beside the list, so build and the verifier can rerun it.
- **Order of work:** a short numbered checkbox list of coherent steps, in dependency order.
  Cite intent labels (`O1`, `C2` …) or spec identifiers where useful. Each step includes its
  completion check and expected result. Group commits by project convention.
- **Proof:** exact applicable commands from `kit.json` (`check`, `lint`, `test`, `build`) and
  expected results, plus behavior-specific checks mapped to intent labels, and a run of each
  changed script on real input. Invoke the `sdlc-ext-plan` extension skills listed in this
  session for the project's required gates and environments, and include what they name. A
  manual observation names who reports it; until reported it is a pending gate. Where commands
  do not apply, name the observation that proves completion.
- **Deviations:** initially empty. During build, record material departures and their effects;
  put lengthy execution evidence in an optional `evidence.md` linked from the relevant entry.

For a fix, plan a reproducing test that fails before the fix and passes afterward; keep both in
one work batch. For a refactor, preserve behavioral assertions and map relocated tests. Add
characterization before changing behavior the existing suite does not cover. Tests should catch
real regressions. Name material risks, sequencing constraints, or alternatives beside the
affected step; omit empty analysis sections. When the change adds or renames a domain term,
enum value or identifier, the step that introduces it also updates the glossary.

## Finalize

Check every intent outcome and case is covered, every planned file has an owning step, and
Proof can distinguish success from a skip or unavailable environment. Avoid oversized steps; if
a newly discovered split changes scope, resolve it through intent before approving the plan.

Present a short summary, the recipe decision, decisions needing attention, and the draft or its
link. Once accepted and editing is permitted, save `<sdlc>/<slug>/plan.md` with
`status: approved`, unticked steps, and empty Deviations; commit by the commit flow (Project
bindings). Approval does not change session mode. Give `/sdlc-build <slug>`; do not start
implementation unless it is already authorized.
