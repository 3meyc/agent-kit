---
name: change-review
description: Review one change for behavior — is the logic right, is it safe, does it hold at the repo's real load, is risky code tested, is it fast enough, is every line needed. Reads the code the diff touches, not only the diff; numbered findings with a concrete case each; changes no code.
argument-hint: "[uncommitted | staged | branch | <commit range> | <PR number or link> | <path>]"
disable-model-invocation: true
allowed-tools: Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git status:*) Bash(git-branch-context:*) Bash(gh pr diff:*) Bash(gh pr view:*)
---

Target: $ARGUMENTS

Review the change like the developer who will be called when it breaks. Order of importance: correct, safe, holds under the expected load, tested, fast, lean. This is a report the user asked for: give it in full, and change no code, not even an obvious fix.

## 1. Understand first

1. Pick the diff from the target:
   1.1. Empty: the uncommitted changes (staged and unstaged); none, then the last commit.
   1.2. `uncommitted` or `staged`: those changes only.
   1.3. `branch`: the branch against the merge base with its base branch, which `git-branch-context` names as `defaultBase` (`kit.json` `baseBranch` when set).
   1.4. A commit range (`a..b`) or one commit: that range.
   1.5. A PR number or link: `gh pr diff`; without `gh`, say so and stop.
   1.6. A path: the uncommitted changes under it; none, then the files as they stand.
2. Read the diff, then the code it touches: the callers of every changed function, the functions it calls, its tests, and the project's `CLAUDE.md` or `AGENTS.md` for rules the change must keep.
3. Trace the real flow: where data comes in, what is stored, what goes out.
4. A change can break code it does not touch. When a signature, return value or behavior changes, search for every caller (CodeGraph's impact check where the repo has `.codegraph/`, else the Grep tool) and read them.
5. Find the expected load in the repo (README, deploy and CI config, `kit.json`): one person running a script, or many users and processes at once. Judge scale against it, and say which load you assumed.

## 2. Look for

1. **Bug:** wrong result, crash, missed edge case (empty, zero, last item, rounding, time zones, Windows paths), a caller the change breaks, a fix made in one caller while the shared function stays broken.
2. **Risk:** security holes (injection, weak randomness, secrets, missing checks on input from users), data loss (errors swallowed, writes in the wrong order, no transaction, a destructive command without a guard).
3. **Scale:** fine for one user, wrong for many: check-then-write races, the same work done by every process, memory or lists that only grow, a query per item, O(n²) on big input, per-process state that must be shared.
4. **Missing test:** risky new logic (a branch, a parser, money, security, data writes, a bug fix) with no test that fails when it breaks. One good test, not coverage.
5. **Speed:** a big slowdown is a problem. A small win (work repeated in a hot loop) is a suggestion.
6. **Lean:** code that should not exist or should be smaller.
   6.1. Delete: dead code, unused options, speculative features.
   6.2. Reuse: the repo already has this helper (name the path).
   6.3. Standard library or platform: it already does this; a new dependency for a few lines.
   6.4. Not needed yet: an abstraction with one implementation, config nobody sets.
   6.5. Merge: near-copies that must change together.
   6.6. Split: one function doing unrelated jobs, so it is hard to read or test. Split by job, never by line count, and never into helpers that exist only to make a function shorter.

## 3. Check before you report

1. Every finding needs a concrete case: this input or situation leads to this wrong result. No case, no finding.
2. Re-read the lines and confirm: the caller exists, the value can really be empty, the code really is unused. Before calling code unused, search the whole tree, including tests, fixtures, config, and string or dynamic references.
3. A limit the code or its docs state on purpose (a comment naming the limit, an ADR, a `kit.json` setting) is a decision, not a finding, unless the expected load already crosses it.
4. Propose the smallest fix that works; prefer fixes that delete code. Never add layers, frameworks or config the problem does not need.
5. No style taste, no "consider", no vague worries. A case you reason about but could not run or confirm is labelled _unverified_.

## 4. Output

Short sentences, everyday words; explain a technical term the first time. The reader may never have seen this code.

1. `What this change does:` two or three sentences, then the load you assumed.
2. The findings in three groups, most important first; skip an empty group:
   2.1. **Must fix:** bug, security, data loss, breaks at the expected load.
   2.2. **Should fix:** risky code without a test, real slowness, duplication, a function that mixes jobs, code that should not exist.
   2.3. **Nice to have:** small speed-ups, shorter forms.
3. Number the findings across all groups (1, 2, 3, … never restarting), so the user can say "fix 2 and 5". Each finding is a bold title with `path:line`, then four parts of one or two sentences each:
   - **What this is:** what the code is for.
   - **Problem:** the concrete case and its wrong result.
   - **Fix:** the smallest change, in words; a one-line snippet only when it is the clearest way.
   - **If we skip it:** what happens to users or data.
4. End with:
   - `Verdict: Ship.` or `Verdict: fix 1 and 3 first.`
   - `Lean: -<N> lines possible.` when there are lean findings.
   - `Not checked:` what mattered and you could not read, run or confirm; `none` when nothing.

Nothing found: `What this change does:`, then `Looks good. Ship.`, one line on what you checked, and `Not checked:`.

Adapted from `ponytail-review` in [ponytail](https://github.com/DietrichGebert/ponytail) by Dietrich Gebert, MIT licence; see the plugin's `THIRD_PARTY_NOTICES`.
