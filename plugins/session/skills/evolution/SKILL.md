---
name: evolution
description: Bring the project's evolution pages up to date before a release — process-evolution.md (how the way of working grew) and features-evolution.md (how the features grew), each one Mermaid flowchart plus a Sources table, with a version and last_verified. Use when the `kit release` dry run names a page unchanged since the last release, before the project's own release, when asked to update the evolution pages, or to start them (`evolution init`).
---

# Evolution pages

The pages live in `kit.json` `paths.evolution` (default `docs/evolution`). A project keeps them
by having them; with none, this skill has nothing to do unless the user asks to start them.
`evolution` is on the Bash PATH (`node "${CLAUDE_PLUGIN_ROOT}/scripts/evolution.mjs"` without it);
`evolution --help` lists its commands.

The pages are brought up to date **once per release**, not per session: sessions are small, and
the release batches their changes into a few boxes. Run this before the release commit, so the
pages land in the release (`kit release` refuses an uncommitted tree: commit them first).

## 1. What is missing

```bash
evolution status --since-release
```

It counts from the last release tag (`kit.json` `release.tag`, else `stable`, else the newest
tag), or from a page's `last_verified` when that is later, and lists:

1. Each page, its version, whether it changed since that tag, and its check result.
2. **Process**: the commits since the tag that touched the way of working (`CLAUDE.md`,
   `AGENTS.md`, `kit.json`, `.claude/` commands, agents, rules, skills and settings, `.mcp.json`,
   CI workflows, git hooks, decision records) and that the page does not quote yet. A product
   changelog seldom records these, so the commits are the source here.
3. **The changelog's `## Unreleased` lines** (the first `release.notes` changelog, else
   `CHANGELOG.md`): the triaged list. Someone already judged each line worth recording, so they
   are the features page's candidates, and the process page's too when the changelog records
   process changes. With no Unreleased lines, the `feat` commits stand in.

## 2. Triage

Each candidate becomes one of three, decided from its line or diff, never from memory:

1. **A new box**: a change a reader of the page would want to see (a new rule, skill, hook, loop,
   check; a feature a user gets). Several lines or commits of one change make one box; a release
   of many small lines often makes two or three boxes, one per area.
2. **A line in an existing box**: a follow-up, a fix or a widening of a change already drawn. Add
   it to that box's Sources row.
3. **Nothing**: a chore, a typo, an internal fix. Say so in one line when reporting, so the
   choice is visible.

The features page gets one subgraph per release, named like the release (`vX.Y.Z, MM-DD`, or the
changelog's heading); while it is being drawn it is the open `Unreleased` subgraph. A new
**stage** on the process page is a turn in the way of working (a new tool, a new loop, a retired
one): propose it and let the user name it.

## 3. Write the box

1. Inside the stage's (or release's) `subgraph`, after its last box:
   `camelId["[tag] The change in a few words<br/>one line of detail"]`, then chain it:
   `previous --> camelId`. Readable labels, camelCase ids, no sentences as ids.
2. Give it the class of its tag on the `class` lines at the end (`class camelId tooling`). The
   page's Legend names the tags; a new tag needs a `classDef` and a Legend line.
3. A move between repositories (taken from, given to) is a dotted arrow to an outside node:
   `ext -. "from: what, MM-DD" .-> camelId`.
4. A planned box gets the `planned` class (dashed) and turns solid once its work is released.
5. **Sources row**, one per box: `| Short name | YYYY-MM-DD | source |`; a span is
   `MM-DD → MM-DD`. The source is the commit subjects in backticks, or the changelog release
   (`CHANGELOG <date>`) for a box drawn from its lines. Nothing invented.

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
structural, not Mermaid's own parser. Commit the pages, then release.

## 6. Starting the pages

`evolution init` writes both pages with one first box each, and a mirror per language the repo
already keeps `*.<lang>.md` pages in (`--lang uk` to choose, `--no-mirror` for none). Replace the
first boxes with the project's real history from `git log` and the changelog's release entries
(the first commit, the agent set-up, each release), with a Sources row each, before committing.
