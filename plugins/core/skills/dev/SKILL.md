---
name: dev
description: Start the project's dev server on kit.json devServer.port, in the desktop app's Browser pane when available, and report its URL and startup errors.
disable-model-invocation: true
---

Dev server settings from the project's `kit.json` and `.claude/launch.json`:

!`node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" dev`

1. If the output names a launch configuration, start it with `preview_start` and that `name`. If it is already running, reuse it and report the URL.
2. Then report the port and any startup errors from `preview_logs`. Do not start the server through Bash while `preview_start` is available.
3. Without the Browser pane tools (a terminal session), tell the user the command and port from the output and let them start it; a dev server would outlive this turn.
4. When the output says no configuration matches the port, say so: the user adds a `.claude/launch.json` entry with that `port` (the dev command is the project's own) or fixes `devServer.port`. Do not guess the command.
5. When the port is taken by another process, report which process holds it instead of moving to another port; other tools may expect this one.
