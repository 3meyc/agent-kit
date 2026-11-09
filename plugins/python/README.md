# python

**English** · [Українська](README.uk.md)

Conventions for Python code: toolchain, layout, typing and checks in one skill, tests in another. Each one is a skill with
`paths:`, so Claude Code loads it when the session touches a matching file. Nothing project-specific
lives here: a project's required-checks table and its own constraints stay in the project. Needs
`core`.

## Install

With the `agent-kit` marketplace added (see the [root README](../../README.md)):

```bash
claude plugin install python@agent-kit
```

## Skills

| ID | Skill | Loads for | Covers |
| --- | --- | --- | --- |
| 1 | `python-code` | `**/*.py`, `**/pyproject.toml` | Version pin, uv instead of pip, dependencies as a decision, PEP 723 scripts, ruff; script and package layout, import time, imports and cycles; typing (`X \| None`, weak inputs, frozen dataclasses, Protocols, version-gated features); where to catch errors; which checks to run before calling a change done |
| 2 | `python-tests` | `**/test_*.py`, `**/*_test.py`, `**/conftest.py`, `**/tests/**/*.py` | The project's runner, testing through the contract, exact assertions, boundaries, isolation, doubles, regression tests first, what not to test |

A skill's description is listed in every session and its body loads only when the model calls it
(see [spikes](../../docs/spikes.md), S2 and side finding 2). The skills fill what the project leaves
open: the project's own rules, `pyproject.toml` and the surrounding code win where they differ.

## What stays in the project

1. The required-checks table: which command runs for which folder.
2. Version targets of vendored or upstream code that differ from the project's own.
3. Rules for private data folders, sample data paths and real-input runs.

## kit.json

| ID | Key | Used by |
| --- | --- | --- |
| 1 | `commands.check` | `python-code`: the checks to run before calling a change done |
| 2 | `commands.test` | `python-code`, `python-tests`: the command that runs the tests |

## Retiring project copies

A project that kept a `.claude/rules/python.md` can retire its generic part: `kit doctor` and
`/core:kit-adopt` list it from [kit-owned.json](kit-owned.json). Keep the project's own checks
table in a rule with another name.
