---
name: kit-doctor
description: Check a project's agent-kit set-up — kit.json against the schema, needed plugins enabled, base and overlay marketplaces declared, copies of kit-owned files, installed plugins behind their channel. Use when a kit rule, skill or hook seems ignored or stale, or after changing kit.json or .claude/settings.json.
---

Run the check from the repo root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" doctor
```

(`kit doctor` is the same command on the Bash PATH. Add `--offline` to skip the remote version check. Plugins loaded with `--plugin-dir` are read from the running `claude` command line; when the report misses one, add `--plugin-dir <path>` for it.)

Then report:

1. One line: healthy, or how many FAIL and WARN items.
2. Each FAIL and WARN as a numbered item with its fix. Quote the report's line rather than paraphrasing it.
3. For an installed version behind its channel, give the two update commands in separate `bash` blocks and say that a new session picks the update up.

Do not fix anything unasked. A kit-owned copy in the project, or a test of one, is the user's to retire: name it and what the kit supplies instead; never delete it. A FAIL in kit.json or settings is fixed by editing those files only after the user agrees.
