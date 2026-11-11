# Verification contract

Read together with the shared workflow (`sdlc-kit show workflow`); whoever starts this pass
names both.

Verify in fresh context; never edit, fix, format, commit, or restore repository files.
Receive the repository, comparison base, revision, item path, review result and preflight
results. Read the intent, a spec if present, the plan, and any referenced use-case or contract
documents.

## Checks

1. Record revision and complete working-tree status before checks. Require the
   supplied revision and a clean tree, including staged and untracked files.
2. Review the full item diff, including its records. Derive representative expected
   outcomes from each intent outcome (`O1` …) and important case (`C1` …) before reading its
   implementation and tests. Map outcomes, cases and changed contracts to code and meaningful
   verification. When the plan models shared state, each case needs proof through every entry
   point that reaches it.
3. Check linked flows, recipes, documents and diagrams against the intent, the plan's Proof
   and the implementation. Broken links, omissions, and contradictory records are findings.
   For a fix or refactor, use the intent's expected outcome and constraints.
4. Confirm the finish preflight (Project bindings) ran against the comparison base and its
   introduced findings are fixed or recorded with a disposition; a missing run is `PENDING`.
5. Check the design rules and documentation obligations (Project bindings: Design rules,
   Documents), and the review findings. Apply the recipe and glossary rules (workflow
   section 5): the recipe the plan followed is correct or fixed in this change, a kit recipe's
   fix is recorded as a follow-up, a recurring task without a recipe got one and an index
   entry, and every new or renamed domain term, enum value or identifier is in the glossary.
   Examine relevant security risks at changed trust boundaries. Report concrete evidence;
   distinguish executed checks from source inspection.
6. Run applicable project checks and the plan's remaining Proof sequentially. Do not run
   autofixes or commands that rewrite repository files (a lint with `--fix`, a formatter with
   `--write`); use a read-only form when the project has one, otherwise report them as pending.
   Ignored test output and caches are allowed. Retain commands and useful output. A manual
   observation the user has not reported is pending, not passed.
7. For each bug fix, confirm recorded red-phase evidence for its reproducing test
   in linked evidence or existing commit bodies. Passing tests alone do not prove it.
8. Check deviations, unresolved `BLOCKED` entries, and differences between planned
   affected paths and the actual diff. Confirm documented corrections match the
   authorized behavior and still satisfy Proof. Missing verification is not a pass.
9. Confirm the final revision and complete status equal their initial clean values.
   A change is a failure; report it without attempting restoration.

## Verdict

Start with `PASS`, `FAIL`, or `PENDING`. Use `PASS` only when all required checks and
independent review are complete. List checks with results and each finding or unavailable
check with evidence and location. Label each finding `defect` (code behavior, a failing check,
a contract or Proof mismatch, a missing gate) or `nit` (wording, a stale line or label in a
record); finish caps reruns on nits. Name the verified revision. Report only; fixes belong
to build.
