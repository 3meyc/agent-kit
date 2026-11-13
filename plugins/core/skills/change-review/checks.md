# Review checks

Shared by `/core:change-review` and `/core:repo-audit`: what to look for, in order of importance, the checks every finding passes before it is reported, and how to run a command while reviewing. Change both skills' behavior here, not in their `SKILL.md`.

## Look for

1. **Bug:** wrong result, crash, missed edge case (empty, zero, last item, rounding, time zones, Windows paths), a caller broken by a change, callers that disagree with what a function returns, the same rule applied differently in two places, a fix made in one caller while the shared function stays broken, a fix made in the shared function while a caller that skips it stays broken.
2. **Risk:** security holes (injection, weak randomness, secrets in code, missing checks on input from users), data loss (errors swallowed, writes in the wrong order, no transaction, a destructive command without a guard), a check, lint or test command that writes tracked files (it rewrites what it should verify, so drift never fails it).
3. **Scale:** fine for one user, wrong for many: check-then-write races, the same work done by every process, memory or lists that only grow, a query per item, O(n²) on big input, per-process state that must be shared.
4. **Missing test:** risky logic (a branch, a parser, money, security, data writes, a bug fix) with no test that fails when it breaks. One good test, not coverage. A test double (stub, mock, in-memory adapter, dev harness) that is more forgiving than the platform it stands for counts as no test for that path: it reports every write where the platform skips an unchanged one, never times out, never fails, keeps order the platform does not promise. Name the platform behavior the double leaves out.
5. **Speed:** a big slowdown is a problem. A small win (work repeated in a hot loop) is a suggestion.
6. **Lean:** code that should not exist or should be smaller.
   6.1. Delete: dead code, unused options, flags and config, speculative features.
   6.2. Reuse: the repo already has this helper, or two helpers do the same thing (keep one, name the path).
   6.3. Standard library or platform: it already does this; a dependency doing what a few lines can.
   6.4. Not needed yet: an abstraction or interface with one implementation, a factory with one product, a wrapper that only passes calls through, config nobody sets.
   6.5. Merge: near-copies that must change together.
   6.6. Split: one function or class doing unrelated jobs, so it is hard to read or test. Split by job, never by line count, and never into helpers that exist only to make a function shorter.

## Check before you report

1. Every finding needs a concrete case: this input or situation leads to this wrong result. No case, no finding.
2. Re-read the lines and confirm: the caller exists, the value can really be empty, the code really is unused. Before calling code unused, search the whole tree, including tests, fixtures, config, and string or dynamic references.
3. A limit the code or its docs state on purpose (a comment naming the limit, an ADR, a `kit.json` setting) is a decision, not a finding, unless the expected load already crosses it.
4. Propose the smallest fix that works; prefer fixes that delete code. Never add layers, frameworks or config the problem does not need.
5. Before you write the fix, find every place with the same defect, not only the one you saw: every call site of the raw primitive beside the shared helper (each direct `fetch`, not only the API client), every writer and reader of the same stored key, every copy of the rule. The fix names them all, or says which it leaves and why.
6. When the fix relies on how a platform or library behaves (a change event, a timeout, a retry, an ordering, a lock), name that rule and the edge the fix must survive, for example "a storage change event does not fire for a write that leaves the value unchanged". Not confirmed in the platform's docs or by a run: label it _unverified_.
7. Owner: when the project names parts another owner holds (a service, a shared library or kit, another team's code; in `AGENTS.md`, `CLAUDE.md`, its rules or `kit.json`), say for each finding whose code has to change. A defect on the other side gets a written request to that owner as its fix, plus any interim change in this repo; never a proposal to edit their code from here.
8. No style taste, no "consider", no vague worries. A case you reason about but could not run or confirm is labelled _unverified_.

## When you run a command

1. Run only commands that read: the project's own check, lint and test commands count; a command that writes fixes (a formatter, `--fix`, a code generator) does not.
2. Run `git status --short` before and after each check or test you run. When the tree changed, the command wrote: report it as a finding (item 2 of Look for) with the command and the files it touched, and leave those files as they are for the user; do not restore them yourself.
