---
name: sdlc-finish
description: >-
  Independently review and verify completed SDLC work through the verifier contract, then archive
  its records under <sdlc>/archive/ and merge only when authorized. User-invoked only.
disable-model-invocation: true
allowed-tools: Bash(sdlc-kit:*)
---

# Finish

Run `sdlc-kit show workflow` first and follow that shared workflow (item
resolution, ownership, authorization, recipes and glossary, project bindings, existing-format
compatibility). Then run `sdlc-kit` for this project's paths and commands. If the shell cannot find
`sdlc-kit`, run `node "${CLAUDE_PLUGIN_ROOT}/bin/sdlc-kit"` with the same arguments.

## Ready

Read the committed item and comparison base. Require an approved plan, completed
committed steps, no unresolved blockers, and a clean working tree. Identify drafts or
unfinished work precisely; preserve unrelated edits and report any gate still pending.

## Finish preflight

1. Run the project's finish preflight (Project bindings) against the item's comparison base
   before the independent review, so its fixes are reviewed too: each `sdlc-ext-preflight`
   skill listed in this session, then the documentation check (`sdlc-ext-docs` skills, else
   `commands.check`). With no extension and no check command, review the changed documents'
   links, commands and examples by hand and say the preflight was manual.
2. Fix what the item introduced, within its scope; tell introduced from inherited findings by
   comparing with the base, not by the file list. Record each finding's disposition, and the
   inherited ones left as they were, in the plan's Review.
3. Check the recipes and glossary (workflow section 5):
   - the recipe the plan followed was right, or fixed in this change; a fix to a kit-supplied
     recipe is opened as an issue in that kit (Project bindings: Kit gaps), and its reference
     goes in the plan's Review;
   - a task likely to recur that had no recipe now has one, listed in the index, or the plan
     says why not;
   - every domain term, enum value or identifier the diff adds or renames is in the glossary.
   Fix a gap here, within scope, before the review.
4. Run the affected checks and commit the fixes by the commit flow (Project bindings). A
   preflight that cannot run is reported as pending, never as passed.
5. A document the intent's Scope excludes, or limits to a note ("a status banner only"), still
   owes the rest: record it as a follow-up (Project bindings: Follow-ups), so the deferred
   rewrite has an owner instead of going stale unnoticed.

## Independent review

1. Give a fresh read-only sub-agent the repository, base, revision, item documents,
   and linked use cases if present. Request actionable defects with locations and evidence.
   The host `code-review` skill serves that pass; add `security-review` when the change
   moves a trust boundary (permissions, host access, credentials, external writes, personal
   data, network calls).
2. Review changed behavior against the intent outcomes, cases and any contracts, the project's
   design rules, compatibility, failure paths, and relevant tests. Include security where
   changed trust boundaries warrant it: permissions, input handling, sensitive data, and
   external actions. Use project-defined checks when relevant and available. When the plan
   models shared state, the review checks each interleaving and entry point against the code,
   and build's adversarial review is in evidence; a missing one is a finding.
3. Address substantiated findings within authorized scope. Record material deviations,
   update affected documents, run appropriate checks, and commit owned fixes by the commit
   flow. Explain disputed findings and seek decisions only when necessary.
4. Preserve the review result and finding dispositions for the verifier. Record reusable
   project lessons (a decision record, a recipe, a glossary term, a project rule) only when
   warranted and authorized, before the verification gate.

## Verification gate

1. Record the exact revision and clean status after review fixes. Request a fresh pass from
   this plugin's `sdlc-verifier` agent with the repository, base, revision, item paths, review
   result, preflight results, and tell it to read its contract with `sdlc-kit show verification`
   and the workflow with `sdlc-kit show workflow`. Wait for the result; run shared-checkout
   checks sequentially. Where the agent is unavailable, run the contract and the shared
   workflow in a fresh session by hand and record its verdict in evidence.
2. If independent review or verification is unavailable, perform useful local checks
   and report the independent gate as pending. An inline self-review cannot pass it.
3. Require `PASS`, unchanged revision, and clean status. For `PENDING`, retain the open
   gate and report what is needed; do not archive. A `FAIL` becomes an unchecked
   plan step with evidence and its detecting check; commit only those owned records.
   Report `/sdlc-build <slug>`, then `/sdlc-finish <slug>` as the recovery path.
   **Rerun cap:** sort each `FAIL` finding by the verifier's label. A `defect` (code behavior,
   a failing check, a contract or Proof mismatch) goes back to build as above. When only
   `nit`s remain (wording, a stale line or label in the intent, plan, evidence or a recipe),
   fix them, list the fixes in evidence with "archived under the rerun cap", commit, and
   archive without another pass: each rerun on nits tends to find the nits the last fix
   introduced. At most two verifier passes per finish, a third only on the user's word in
   that session.
4. After `PASS`, change only completion and archive metadata. Any code, contract,
   requirement, or workflow-rule change requires checks and independent
   verification again for the affected scope before archiving.

## Archive and report

1. Set `status: done` on lifecycle documents and the intent's completion date. Move
   the entire item, including evidence, to `<sdlc>/archive/<YYYY-MM-DD>-<slug>/`;
   keep its relative links valid.
2. Stage only the item's source and destination paths and other explicitly owned
   record changes. Commit by the commit flow and verify success. Never stage the whole item
   root or include another item's work.
3. Report the verified revision, check results, archive path, and remaining merge
   state. Merge only with explicit user authorization; follow project policy for
   merge strategy, branch cleanup, worktrees, and pushing. Preserve authorization
   already given in the session.
4. Close out (Project bindings: Close-out). With the `session` plugin, run its `/close-out`:
   the done / follow-up / not-done resume, follow-up sessions, and the one question that
   authorizes landing, pushing and cleanup. Without it, give the done / follow-up / not-done
   resume in chat and ask about merging into the base and pushing, each separately.
