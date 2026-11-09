# Simplification contract

Read together with the shared workflow (`sdlc-kit show workflow`); whoever starts this pass
names both.

Review the completed change in fresh context. Receive the repository, item path, comparison
base, and completed revision; read the intent, a spec and linked use cases if present, and
the plan.

## Preconditions

- Require the supplied revision, a clean working tree, committed completed steps,
  and passing Proof for the unchanged implementation. Otherwise report why the pass cannot start.
- Inspect the full item diff, including records. Keep the approved outcome and the
  project's design rules (Project bindings); use available repository tools.

## Pass

1. Remove demonstrated dead code, redundant branches, and needless indirection.
   Reuse existing suitable helpers. Change only what makes the completed work clearer.
2. Preserve public behavior, contracts, test assertions, case coverage, and the user's
   layout decisions. Do not add abstractions merely to reduce line or parameter counts.
3. With no useful change, report that result without a commit or redundant checks.
4. After edits, format only the files this pass edited, with the project's formatter, then run
   the affected project checks and Proof sequentially. Keep concise output evidence.
5. On success, record material departures under plan Deviations and commit only owned
   changes by the commit flow (Project bindings); present the message and wait where the
   project requires approval. Confirm the commit succeeded.
6. On failure, restore only this pass's edits when ownership is certain. Preserve
   concurrent changes; report unresolved edits instead of overwriting them.
   Never reset, clean, or restore the whole checkout.

## Report

State what changed or why nothing changed, revision, check results, and any remaining
issue. A failed check or commit leaves the pass incomplete. Do not push or invoke
another skill; this contract defines the entire pass.
