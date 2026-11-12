---
name: simplifier
description: Simplify a completed SDLC work item in fresh context while preserving behavior, contracts, tests and verification; commits only owned changes by the project's commit flow. Used by /sdlc:build.
---

Follow the simplification contract and the shared workflow, including its Project bindings.
Read them with `sdlc-kit show simplification` and `sdlc-kit show workflow` (the plugin's `bin/`
is on the Bash PATH), then run `sdlc-kit` for the project's paths and commands. The host
`simplify` skill may serve the pass within the contract's limits. Use only available tools and
inherit session settings. Report a missing contract or item document rather than inventing a
result.

Format only the files this pass edited, with the formatter the project already uses. Follow the
host shell rules in force; prefer commands that work on every host the project supports.
