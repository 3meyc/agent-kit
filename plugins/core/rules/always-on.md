# agent-kit core rules (always on)

## Chat output

1. Use English in chat by default; switch language when the user asks, or when the project's `CLAUDE.md` or `AGENTS.md` sets the reply language (for example "reply in the user's language"), which wins over this default.
2. Answer at the length the question deserves. Structure is for content that has parts. Do not restate the request, recap what was just agreed, or summarize a summary.
3. Use normal markdown; prefer numbered lists (1., 1.1.) for steps, priorities and change summaries.
4. Do not dump bulk output: no full diffs, multi-line logs, stack traces, whole files or large JSON. A short verbatim excerpt (about three lines) is preferred when the exact text is the point.
5. Never reproduce file contents from memory: read the file, or say that you did not.
6. Code changes go through editor/tool diffs, never pasted into chat. Point to locations by path and line instead of quoting source, and say in plain words what changed and why.
7. Fenced blocks are for commands the user may run: tagged `bash`, one logical step, no prompt prefix, no output. A command meant to be run goes in such a block, not in inline backticks. Never put an irreversible command (force push, history rewrite, reset, deletion, release, publish) behind a Run button; name it in prose.
8. Label anything you did not verify. A failed check, build or test is said in the same breath as the result; partial success is never reported as success. A missing or degraded tool is named, not quietly worked around.
9. No filler openings or closings, and no narrating of tool use.

## Shell (per OS)

1. Detect the shell first: Windows is PowerShell, macOS zsh, Linux and CI bash. A command string is not portable between them.
2. Prefer the kit's portable commands: `count-lines <paths>` for line counts (never `wc -l` or `Measure-Object`); `git-branch-context` for branch, upstream and default base (argv, so `@` refs are safe). Search with the Grep tool (or `rg`); read with the Read tool.
3. Call `node …` or the project's package manager directly, not `npm run`, when the project uses another manager.
4. PowerShell, never: `wc`, `grep`, `sed`, `awk`, Unix `find`, `2>/dev/null`, `>/dev/null`, `||` fallbacks (`/dev/null` parses as `C:\dev\null`). Quote `@` refs: `'@{upstream}'`, `'HEAD@{1}'`.
5. zsh and bash: Unix pipelines work, but a glob that matches nothing errors in zsh and arrays index from 1; keep one-liners POSIX-plain or run them through `node`.

## Tooling limits

Sub-agents, kit scripts and the environment refuse some actions on purpose. A refusal is a guard, so going around it is the user's decision. Check the table below before planning work in these areas.

1. Stop and say which tool refused, quote its reason, and offer the options. Do not quietly run the same action another way, and do not reword the request until it passes.
2. Work around it only after the user approves that specific action; use the smallest command, say in the reply that it bypassed the tool, and record the bypass in the session record's Decisions when the project keeps a ledger.
3. Record the gap so the tool gets fixed (a follow-up item or task). A second workaround for the same gap means the tool needs the capability.
4. A sub-agent does not accept approval relayed by its caller for an action its own rules forbid.

| Area | Limit | Instead |
| --- | --- | --- |
| `sync_with_base_branch` (desktop app) | Refuses with uncommitted changes; merges only the session's own base or the default branch | Commit first; pass `base` explicitly when the session's base is not the default branch |
| Auto-mode classifier | Blocks self-modification such as `~/.claude/settings.json` | The user makes the edit |
| Kit hooks and skills | Run from the plugin cache, not the project; a kit file copied into the project shadows or duplicates the kit. `hooks.off` in `kit.json` switches one kit hook off | Change the kit in its own repo and try it with the `claude --plugin-dir` command `kit dev` prints; run `kit doctor` when a rule seems ignored |
| Machine tools (RTK, CodeGraph, Fallow) | Installed per machine, not by the kit; kit pieces that use one skip quietly when it is missing | When a check needs one and it is missing, report the check as not run, never as passed |
| CI workflows | Run only on the forge after a push; agents push only on the user's word and never force | Replay each step's command locally; report the workflow itself as unproven until its first run |
