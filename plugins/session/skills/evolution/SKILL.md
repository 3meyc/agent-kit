---
name: evolution
description: Keep the project's evolution pages current — process-evolution.md (how the way of working grew) and features-evolution.md (how the features grew), each one Mermaid flowchart plus a Sources table, with a version and last_verified. Use in /close-out when `evolution status` lists commits not on a page, when a session changed rules, skills, hooks, CI or kit.json or shipped a feature in a project that keeps these pages, or to start them (`evolution init`).
---

# Evolution pages

The pages live in `kit.json` `paths.evolution` (default `docs/evolution`). A project keeps them
by having them; with none, this skill has nothing to do unless the user asks to start them.
`evolution` is on the Bash PATH (`node "${CLAUDE_PLUGIN_ROOT}/scripts/evolution.mjs"` without it);
`evolution --help` lists its commands.

## 1. What is missing

```bash
evolution status --base auto
```

`--base auto` lists the commits on this branch (a worktree session); without it, the commits after
each page's `last_verified`. A commit goes to `process` when it touches the way of working
(`CLAUDE.md`, `AGENTS.md`, `kit.json`, `.claude/` commands, agents, rules, skills and settings,
`.mcp.json`, CI workflows, git hooks, decision records) and to `features` when it is a `feat`
commit that touches anything else. A commit whose subject the page already quotes is left out.

## 2. Decide per commit

Sort each listed commit into one of three, from its subject and diff, never from memory:

1. **A new box**: a change a reader of the page would want to see (a new rule, skill, hook, loop,
   check; a feature a user gets). Several commits of one change make one box.
2. **A line in an existing box**: a follow-up, a fix or a widening of a change already drawn. Add
   its subject to that box's Sources row.
3. **Nothing**: a chore, a typo, a fix to something not on the page. Name it in one line in the
   close-out resume as left off, so the choice is visible.

A new **stage** (process) is a turn in the way of working (a new tool, a new loop, a retired one);
propose it and let the user name it. On the features page the open subgraph is `Unreleased`; at a
release it is renamed `vX.Y.Z, MM-DD` and a new `Unreleased` opens below it.

## 3. Write the box

1. Inside the stage's (or release's) `subgraph`, after its last box:
   `camelId["[tag] The change in a few words<br/>one line of detail"]`, then chain it:
   `previous --> camelId`. Readable labels, camelCase ids, no sentences as ids.
2. Give it the class of its tag on the `class` lines at the end (`class camelId tooling`). The
   page's Legend names the tags; a new tag needs a `classDef` and a Legend line.
3. A move between repositories (taken from, given to) is a dotted arrow to an outside node:
   `ext -. "from: what, MM-DD" .-> camelId`.
4. A planned box gets the `planned` class (dashed) and turns solid once its work is on the base.
5. **Sources row**, one per box: `| Short name | YYYY-MM-DD | the commit subjects in backticks |`;
   a span is `MM-DD → MM-DD`. Add `(branch)` while the work is not on the base yet. Every row
   comes from `git log`, a CHANGELOG section or the work item; nothing invented.

## 4. Mirrors

A page with a mirror (`process-evolution.uk.md` and the like) gets the same change in the same
commit: the same ids, edges, class lines and line count, labels and Legend in its language,
Sources rows with the same node names and dates. `evolution check` fails when the box ids differ.

## 5. Version, check, render

```bash
evolution bump process
```

`bump` raises the minor version (`--patch` for a correction that adds no box), sets
`last_verified` to today, moves a printable link (`…-v1.4.0.pdf`) to the new version, does the same
in each mirror, and runs `kit.json` `commands.evolutionRender` with the page when the project has
one. No renderer while the page links a printable version, or a failed render: report the
printable version as **not rendered**, never as current. Then:

```bash
evolution check
```

An error there (an unclosed quote or `subgraph`, an undefined class, a mirror out of step) is
fixed before the commit; a warning (an id used but never labelled) is usually a typo. The check is
structural, not Mermaid's own parser. Commit the pages with the session's other files.

## 6. Starting the pages

`evolution init` writes both pages with one first box each, and a mirror per language the repo
already keeps `*.<lang>.md` pages in (`--lang uk` to choose, `--no-mirror` for none). Replace the
first boxes with the project's real history from `git log` (the first commit, the agent set-up,
each release), with a Sources row each, before committing.
