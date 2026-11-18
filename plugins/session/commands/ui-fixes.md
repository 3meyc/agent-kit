---
description: Start a child session for UI fixes and enhancements of one area of the app (a page section, a tab or a free-text area) from one brief, so each UI polish sub-session starts the same way. Areas, harness routes and paths come from the project's scope map, kit.json paths.uiScopes. In a child session it runs the brief in place
argument-hint: [scope]
allowed-tools: Bash(git branch:*), Bash(git status:*), Bash(session-ledger:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs:*)
---

Arguments: $ARGUMENTS

`/ui-fixes <scope>` starts a sub-session that polishes one area of the app: it screenshots the
area in the dev server, asks the user for their list, builds the agreed items and lands on the
caller's branch.

## The scope map

`kit.json` `paths.uiScopes` (default `docs/ui-scopes.md`) names the project's scope map. It holds
what is the project's own:

1. **Harness** — how to open each page in the dev server, and any switch to set before a write (a
   mock backend, an administrator caller).
2. **Scopes** — one row per area: scope name, code letter for its charter items, harness route, UI
   folders, state (stores, services), docs.
3. **Names** — scope names that need a question (a name two pages share) and how free text is
   resolved.
4. **Brief additions** — what every UI brief in the project also carries: the rule skills to load,
   a shared component to use, extra checks for done.

No map → ask the user for the area's folders or find them in the project's architecture docs, and
record "add the scope map at `paths.uiScopes`" in the ledger record's `## Next`.

## In a main session

1. **Scope.** Take it from the arguments. None given → ask which area (the map's scope names) and
   stop. A name the map's Names section marks → ask its question. Free text → resolve it as Names
   says.
2. **Id.** The next charter id: the highest `F<n>` in this session's charter, its ledger record
   (`session-ledger --record` prints the path) and the titles of its linked sessions
   (`list_sessions {"linked": true}`), plus one. None found → ask for the id and stop.
3. **Branch.** `git branch --show-current` is the base. Uncommitted work stays here, so if the
   area's files hold uncommitted edits, say so and ask whether to commit first.
4. **Start.** Load `mcp__ccd_session__start_session` if it is deferred, then call it with
   `initiation: "user_asked"`, `context: "fresh"`, `use_worktree: true`, `source_branch: <base>`,
   `title: "<id>: <Scope> UI fixes and enhancements"`, `name` `<id>-<scope>-ui` in lower case,
   `prompt` the brief below filled from the scope's row, and `background` the paragraph below. Name
   in **Avoid** the folders of any sibling session still running (its title says its area).
5. **Report** in one line, linking the session, and end the turn. The sub-session is part of this
   session's charter: record it there and in the ledger record's Intent when committing.

## In a child session

A session that was started by another one (its prompt says so) never starts a session from here.
Run the brief in place instead: fill it for the scope, then do its steps yourself in this session,
starting with step 1, and say that you are doing so.

## Background

> `<project>`: `<one line on what the app is and its stack>`. The user polishes the UI one area at
> a time, each in its own sub-session titled `<id>: …`, started by `/ui-fixes` from the main
> session on `<base>`. Each states a numbered charter in its first reply; follow-ups found
> mid-task go to its ledger `## Next`, never to session cards.

## Brief

Fill every `<…>`; drop a line that does not apply to the scope.

```markdown
<id>: UI fixes and enhancements for <Scope> (<area description>).

Area
- Harness: the dev server via `preview_start`, then <harness route and switches from the map>.
- UI: <UI paths>
- State: <stores and services>
- Docs: <docs from the map>
- Avoid: <folders of running sibling sessions, or "none">

1. Open the area in the harness and screenshot its main views. In your first reply state the
   charter: ask the user for their list of fixes and enhancements, and add at most 5 issues you
   spotted in the screenshots, numbered <code>1, <code>2 … The user decides which ones join; an
   item joins only on their word.
2. Build the agreed items by the project's agent guide and rules. <The map's Brief additions.>
3. Done means: `kit.json` `commands.check` and `commands.lint` (scoped to the touched paths) and
   the tests you touched pass, <the map's extra checks>; each item is checked in the harness with
   a screenshot; the docs that describe the area are updated.
4. Commit through `/git` with `--worktree`. You are a child session: no push, no session cards;
   follow-ups go to your ledger `## Next`; finish with `/close-out`, landing on `<base>` only on
   the user's word. The full test suite and build, and the main-session-only steps, run in the
   parent at `/close-siblings`.
```
