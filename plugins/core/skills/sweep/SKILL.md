---
name: sweep
description: Answer a read-only question across many files in the Haiku agent repo-sweep and return a verdict, not excerpts — dead references, which files mention X, whether a rename left stragglers. Use when the raw matches would flood the main context.
argument-hint: "<question>"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs:*)
context: fork
agent: core:repo-sweep
---

Question: $ARGUMENTS

The project's check suites, from its `kit.json` (`checks.*`), for reference:

!`node ${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs commands`

1. An empty question: say in one line that `/core:sweep` needs a question, list the suite names above (they run with `/core:check <suite>`), and run nothing.
2. Otherwise answer the question read-only with the Grep and Glob tools and the project's own read-only scripts. When a check suite above already answers it, run that suite's commands instead of searching by hand.
3. Never edit, format, stage or commit anything, and never run `commit`, `land` or `commitAudit`.

Return the three-part report: Verdict, Findings, Not checked.
