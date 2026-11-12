---
name: change-review
description: Review one change for behavior — is the logic right, is it safe, does it hold at the repo's real load, is risky code tested, is it fast enough, is every line needed. Reads the code the diff touches, not only the diff; numbered findings with a concrete case each; changes no code.
argument-hint: "[uncommitted | staged | last | branch | <commit or range> | <PR number or link> | <path>]"
disable-model-invocation: true
allowed-tools: Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git status:*) Bash(git merge-base:*) Bash(git rev-parse:*) Bash(git-branch-context:*) Bash(gh pr diff:*) Bash(gh pr view:*)
---

Target: $ARGUMENTS

Review the change like the developer who will be called when it breaks. Order of importance: correct, safe, holds under the expected load, tested, fast, lean. This is a report the user asked for: give it in full, and change no code, not even an obvious fix.

## 1. Understand first

1. Pick the change from the target:
   1.1. Empty or `uncommitted`: the staged, unstaged and untracked changes. `git diff HEAD` leaves out untracked files, so take them from `git status --short` and read each one whole. Nothing uncommitted, when the target was empty: the last commit.
   1.2. `staged`: the staged changes only.
   1.3. `last`: the last commit (`HEAD`). Another commit, or a range `a..b`: that commit or range.
   1.4. `branch`: the branch from the point it left its base. `git-branch-context` names the base as `defaultBase` (`kit.json` `baseBranch` when set); diff from `git merge-base origin/<defaultBase> HEAD` when `origin/<defaultBase>` exists, else from the merge base with the local branch, which may be behind its remote.
   1.5. A PR number or link: `gh pr diff`; without `gh`, say so and stop.
   1.6. A path: the uncommitted changes under it, untracked files included; none, then the files as they stand.
2. Read the diff, then the code it touches: the callers of every changed function, the functions it calls, its tests, and the project's `CLAUDE.md` or `AGENTS.md` for rules the change must keep.
3. Trace the real flow: where data comes in, what is stored, what goes out.
4. A change can break code it does not touch. When a signature, return value or behavior changes, search for every caller (CodeGraph's impact check where the repo has `.codegraph/`, else the Grep tool) and read them.
5. Find the expected load in the repo (README, deploy and CI config, `kit.json`): one person running a script, or many users and processes at once. Judge scale against it, and say which load you assumed.

## 2. Look for, then check

Read [checks.md](checks.md) (`${CLAUDE_SKILL_DIR}/checks.md`) before you judge the change. It lists what to look for, in order, and the checks every finding passes before you report it; follow both lists. For a change, a missing test is about logic the change adds or fixes.

## 3. Output

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
