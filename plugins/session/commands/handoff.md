---
description: Write this session's ledger record now, mid-task — Intent, Decisions, and a Next that opens with a Resume item — so the next session can pick up without the transcript
argument-hint: [--export [note for the next agent]] [--out <path>]
allowed-tools: Bash(session-ledger:*), Bash(ledger-export:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs:*), Bash(git status:*), Bash(kit-repo:*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/kit-repo.mjs:*), Bash(gh repo view:*)
---

Arguments: $ARGUMENTS

This session's record:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs --record`

Files this session edited and still dirty:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/session-ledger.mjs --files`

The ledger is on only when the project's `kit.json` sets `"ledger": true`; its records live in
`kit.json` `paths.ledger` (default `.claude/ledger/`). With the ledger off there is no record:
say so and stop.

Records normally get their meaning as part of committing. This writes it now, for a session that
stops before the commit, so the Stop hook keeps real sections instead of handing placeholders to
the fallback summarizer, which only sees the transcript. The format, followed exactly, whether
written here or before a commit:

**Facts come from the hook, meaning from you.** Front matter (`flags`, `commits`, `pending`) and
the `## Files` footer are computed — do not hand-edit them. You write `title:` and three sections:

- `## Intent` — what the session was for and what it found.
- `## Decisions` — choices with the reason inline, **including approaches rejected and
  investigations that produced no code**. This is the section git cannot replace.
- `## Next` — imperative, for whoever picks this up. `None.` when nothing is owed. Each item
  **starts with its entry point** — the skill, command or recipe to use, e.g.
  ``1. `/sdlc:intent journal-revert` — undo a grant from the journal, …`` — so the next session skips
  its own triage. An item with no natural entry point starts with the file to open.

A Decisions or Next item you did not check — not run, not read, only believed — **starts with
`(unverified)`**. The brief tells every later session to trust these records, so an unchecked claim
otherwise becomes a contract. Prefix, never suffix: the brief clips long lines at the end, and
counts the marked items in one line.

There is deliberately **no `## Result`**: what changed and why belongs in the commit message, and
a record that restates it is duplication that will rot. Records never quote the conversation
either — a clipped prompt describes the session's first minute and misleads about the rest.

Write them **as part of committing**, while the context is live — before routing a commit to
`/git` — **or with `/handoff` when stopping mid-task**. Get the path with `session-ledger --record`,
replace the italic placeholders, and add `title: "<6-10 words>"` after `date:`. Update rather than
append as the session continues. A record still holding placeholders at Stop gets `## Intent` and
`## Next` from your last `wrap_up` recap (desktop app), under a `_(from the session's last recap)_`
line that marks the section as derived (a section you wrote is never touched), and only a record
with no recap is summarized by the plugin's detached summarizer (a cheap model; a project switches
it off with `ledger-summarize` in `kit.json` `hooks.off`) — a safety net, not the intended path,
since it only saw the transcript.

The steps:

1. **No record path above** (it says "no record yet": the Stop hook has not run in this session)
   — say so, and ask the user to run `/handoff` again next turn. Stop here.
2. Read the record. Leave the front matter (`flags`, `commits`, `pending`) and `## Files` alone —
   they are computed. Add `title: "<6-10 words>"` after `date:` if it is missing.
3. Replace the placeholders, or update what an earlier `/handoff` or commit wrote:
   1. `## Intent` — what the session was for and what it found.
   2. `## Decisions` — choices with the reason inline, including approaches rejected and
      investigations that produced no code.
   3. `## Next` — numbered, imperative. **Item 1 is `Resume:`**, the in-flight state:
      - what is half-done, and in which file;
      - the uncommitted paths, from the list above;
      - the failing check, with its one error line quoted;
      - the first command the next session should run.

      The brief shows only the opening lines of `Next`, so put the half-done file and the first
      command on the Resume item's first line. Every later item starts with its entry point: the
      skill, command or recipe to use, or the file to open.
4. Every Decisions or Next item you did not check this session — not run, not read — starts
   with `(unverified)`.
5. **Kit gaps.** An item whose fix belongs to a kit (a skill, hook, rule, recipe or script an
   installed plugin supplies from the plugin cache, not a file of this repo) goes to that kit's
   GitHub issues, not to a numbered list here. `kit-repo <plugin, plugin@marketplace or the kit
   file's path>` names the repo. Draft it by the kit's `kit-gap` template: title
   `<plugin>: <the gap>`; body sections Plugin, File, What happens, What should happen, Found in
   (this project described generically when the kit's repo is public: stack, plugins, stage;
   never its name, links or domain detail). Show the draft; on the user's word,
   `gh issue create --repo <owner/repo> --label kit-gap --title "<title>" --body-file <draft in the scratch folder>`
   (a repo without the label takes it without; say so) and name `owner/repo#n` in Decisions.
   Without that word, or when `kit-repo` names no repo, `gh` is missing or signed out, or
   `gh repo view <owner/repo>` fails, it stays in `## Next` as
   ``kit gap, not opened (<reason>): <title>``.
6. Never quote the conversation, never paste diffs or logs, never commit. Do not add a fourth
   section: `Resume:` lives inside `## Next`.
7. Without `--export`, reply with the record path and the Resume line, plus any drafted kit gap
   waiting for the user's word, nothing more.

## `--export [note]`

For a reader outside this repo's ledger — a colleague, another repo, another harness, a fork.
Do steps 1–6 first; the export renders the record, it never replaces it.

1. Pick the **Suggested start**: the skills, commands or docs the receiving side should load
   first, named by path (for a reader in this repo, the `Next` entry points; for another repo,
   what it needs to read here).
2. Write the note in the session-resume format of `/close-out` § 6: "Where: what — why" lines
   for the major changes and the follow-ups (the _where_ a recipe from the project's recipe index,
   `kit.json` `paths.recipes`, when one fits), no branch, commit or push detail — the script's
   header carries that. The user's own words after `--export` lead the note when they gave any.
   Run, with the note (one argument, lines joined by " · ") and the start quoted:
   `ledger-export <record path> --note "<note>" --start "<start>" [--out <path>]`
   The script writes the git header (repo, remote without credentials, branch, `HEAD`, clean or
   dirty), the three sections as written — `(unverified)` prefixes included — and commits and
   files by path or URL only, then redacts secrets. The default location is
   `~/handoffs/<repo>-<date>-<id8>.md`: outside the repo and not in the OS temp dir.
3. If it refuses because Intent or Next is still a placeholder, go back to step 3 above.
4. Reply with the printed path and one line: point the next agent at this file — do not paste its
   content into the other session.
