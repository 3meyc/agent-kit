---
status: draft
---

# Plan: <title>

## Design notes

<!-- Recipe: <link to the recipe followed> | none matched (a recurring task gets a step that
     writes one). Glossary: terms this change adds or renames, or none.
     Brief answers to the project's design-rules checklist: owning module, invariant protected,
     affected contracts, why this is the smallest solution. Skip lines that do not apply.
     Shared state (locks, leases, renewals, queues, two clients on one state): an actor table
     (actor — holds / renews / releases — when) and an interleaving table (interleaving —
     expected result — case label); one entry path per action; reads without side effects. -->

## Files that change

<!-- Path — new/modified/moved — owning module — responsibility and change. Include required
     documentation and tests.
     Impact check, one line per removed/renamed/re-signed/re-shaped symbol: command — dependents
     found — each one listed above or "unaffected: <reason>". -->

## Order of work

<!-- - [ ] 1. Outcome and intent labels (O1, C1 …).
       Files: paths. Check: command/observation -> expected result.
     Add material dependencies or risks beside the step. Keep completed steps stable. -->

## Proof

<!-- Command or behavioral check — expected result — intent label covered. For shared state,
     one row per case × entry point (C2 via the list screen, C2 via the detail screen).
     Include the project's checks, the gates its extension skills name, and required
     environments; a manual observation is pending until reported. -->

## Deviations

<!-- Leave empty until implementation. IMPROVED/FORCED/BLOCKED — change or blocker, reason,
     affected steps and evidence link. Close a blocker with resolved: evidence. -->
