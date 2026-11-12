---
name: repo-audit
description: Audit a whole repo or one folder for behavior in a forked sub-agent — bugs, security holes, what breaks at the real load, risky code without tests, slow paths, what to delete, merge or split. At most 20 ranked, numbered findings, each with a concrete case; changes no code.
argument-hint: "[<folder or package> | all]"
disable-model-invocation: true
context: fork
agent: general-purpose
---

Scope: $ARGUMENTS

Audit the scope like the developer who just inherited the repo and will be called when it breaks. Order of importance: correct, safe, holds under the expected load, tested, fast, lean. This is a one-shot report the user asked for: give it in full, and change no code. Never edit, format, stage or commit anything, and run only commands that read (the project's own read-only checks and tests count; a command that writes fixes does not).

## 1. Map first

1. Audit what the scope names: a folder, a package, or `all`. Empty: the whole repo.
2. Read the README, the project's `CLAUDE.md` or `AGENTS.md`, `kit.json`, the build, deploy and CI config, the dependency list, the entry points (main, routes, handlers, jobs, CLI commands, hooks) and the tests.
3. Find the expected load: one person running a script, or many users and processes at once. Judge scale against it, and say which load you assumed.
4. Trace the main flows end to end: where data comes in, what is stored, what goes out. Read those paths fully: input from users, money, auth, data writes, background jobs, anything shared between processes.
5. A big repo: go deep where a mistake costs the most, not file by file, and keep a list of what you did not read for `Not checked:`.

## 2. Look for, then check

Read `${CLAUDE_PLUGIN_ROOT}/skills/change-review/checks.md` before you judge any code; `/core:change-review` uses the same file. It lists what to look for, in order, and the checks every finding passes before you report it; follow both lists. When the file cannot be read, say so under `Not checked:` and stop.

## 3. Output

Short sentences, everyday words; explain a technical term the first time. The reader may never have seen this code. Your report is the whole result the caller gets: quote at most three lines of code per finding, and point to the rest by `path:line`.

1. `What this repo does:` two or three sentences, then the load you assumed.
2. The findings in three groups, most important first; skip an empty group:
   2.1. **Must fix:** bug, security, data loss, breaks at the expected load.
   2.2. **Should fix:** risky code without a test, real slowness, duplication, a function that mixes jobs, code that should not exist.
   2.3. **Nice to have:** small speed-ups, shorter forms.
3. Number the findings across all groups (1, 2, 3, … never restarting), so the user can say "fix 2 and 5". At most 20; when you left smaller ones out, say how many. Each finding is a bold title with `path:line`, then four parts of one or two sentences each:
   - **What this is:** what the code is for.
   - **Problem:** the concrete case and its wrong result.
   - **Fix:** the smallest change, in words; a one-line snippet only when it is the clearest way.
   - **If we skip it:** what happens to users or data.
4. End with:
   - `Verdict:` one line: healthy, or what to fix first.
   - `Lean: -<N> lines, -<M> dependencies possible.` when there are lean findings.
   - `Not checked:` the parts you did not read and the checks you could not run; `none` when nothing.

Nothing found: `What this repo does:`, then `Healthy. Nothing to fix.`, one line on what you checked, and `Not checked:`.

Adapted from `ponytail-audit` in [ponytail](https://github.com/DietrichGebert/ponytail) by Dietrich Gebert, MIT licence; see the plugin's `THIRD_PARTY_NOTICES`.
