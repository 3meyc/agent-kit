---
name: check
description: Run the project's checks (kit.json commands and check suites) in a Haiku sub-agent and report only failures. Empty target runs check, lint and test; or name one command (build, test, …), a suite from kit.json checks (i18n, docs, …) or `all`.
argument-hint: "[<command name> | <suite> | all]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs:*)
context: fork
agent: core:check-runner
---

Target: $ARGUMENTS

The project's commands and check suites, from its `kit.json` (`commands.*`, `checks.*`):

!`node ${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs commands`

Pick the commands for the target, then run them in order, each as its own Bash call from the repo root, and do not stop at the first failure.

1. Empty target: `check`, `lint`, `test`, in that order, each one the project defines.
2. A command name (`build`, `test`, `lint`, …): that command only.
3. A suite name from the check suites list: every command of that suite, in its order.
4. `all`: `check`, `lint`, `test`, `build`, in that order, each one the project defines. Suites are not part of `all`.

Never run `commit`, `land` or `commitAudit` here: they change the repository. If `lint` applies fixes (eslint with `--fix`, a `format` that writes), report it as NOT RUN with that reason. When the target names neither a command the project defines nor one of its suites, or there is no `kit.json`, say so in one line, list the suite names if there are any, and run nothing.

Report pass/fail per step in a numbered list. For failures, give the file, line and the cause; do not paste output.
