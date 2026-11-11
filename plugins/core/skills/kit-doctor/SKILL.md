---
name: kit-doctor
description: Check a project's agent-kit set-up — kit.json against the schema, needed plugins enabled, base and overlay marketplaces declared, copies of kit-owned files, installed plugins behind their channel. Use when a kit rule, skill or hook seems ignored or stale, or after changing kit.json or .claude/settings.json.
---

Run the check from the repo root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" doctor
```

(`kit doctor` is the same command on the Bash PATH. Add `--offline` to skip the remote version check; without it the remote is read every time, and a result that could only come from the cache says so. Plugins loaded with `--plugin-dir` are read from the running `claude` command line; when the report misses one, add `--plugin-dir <path>` for it.)

Then report:

1. One line: healthy, or how many FAIL and WARN items.
2. Each FAIL and WARN as a numbered item with its fix. Quote the report's line rather than paraphrasing it.
3. For an installed version behind its channel, give the update commands the report names in separate `bash` blocks (always `claude plugin update <plugin>@<marketplace> --scope user`; without `--scope user` the CLI picks a project-scope copy) and say that a new session picks the update up.
4. For a project-scope copy (one that loads instead of the user copy, or one that differs from it), say the kit is installed at user scope only (docs/using.md § 1) and offer `kit installs` to list such copies and `kit installs --clean` to clear them, after the user-scope update. `--clean` uninstalls through the `claude` CLI and changes `~/.claude/plugins`, so run it only on the user's word; if a guard refuses it, the user runs it from a Claude session's shell.
5. For a marketplace registered on this machine (or declared in the user's own settings) at another ref than the project declares, give that fix first: the update commands alone keep following the wrong ref. Editing the user's `~/.claude/settings.json` is the user's step.
6. A version result read from the cache is not proof that the plugin is current; say so.

Do not fix anything unasked. A kit-owned copy in the project, or a test of one, is the user's to retire: name it and what the kit supplies instead; never delete it. A FAIL in kit.json or settings is fixed by editing those files only after the user agrees.
