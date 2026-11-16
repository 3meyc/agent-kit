---
name: kit-dotfiles
description: Keep the user's global Claude Code layer — ~/.claude/settings.json, the global CLAUDE.md, their own skills, agents, commands and output styles — in a private dotfiles folder they push as their own git repo, and link it onto each machine. Use when the user asks to sync or carry their Claude Code setup between machines, set up a new machine from their dotfiles, or back up their user settings and skills.
---

1. See where things stand (changes nothing):

   ```bash
   kit dotfiles check
   ```

   The folder is `KIT_DOTFILES`, else `~/.claude-dotfiles`; pass `--dir <folder>` when the user
   keeps it elsewhere. "does not exist" means this is the first machine (step 2) or the repo is not
   cloned yet (step 3).

2. **First machine: seed the folder.** Show the plan, then run it once the user agrees:

   ```bash
   kit dotfiles init --dry-run
   ```

   ```bash
   kit dotfiles init
   ```

   It copies each portable path that exists, leaves the desktop app's `skills/synced/` out and
   writes it into the folder's `.gitignore`, then scans the folder. A `FAIL` line (a token or a
   secret value) must be fixed before anything is pushed: tell the user the file and line, never
   the value. A `warn` for a machine path means another machine will not have that path. Creating
   the private repo and pushing it is the user's step; give them the command line `init` printed,
   and do not run `gh repo create` or `git push` unless they ask.

3. **Another machine: apply.** After the user clones their repo into the folder, show the plan and
   apply on their word:

   ```bash
   kit dotfiles apply --dry-run
   ```

   ```bash
   kit dotfiles apply
   ```

   Each real file it replaces is kept as `<name>.backup-<time>`; name those so the user can merge
   anything machine-specific back. Where a link cannot be made (files on Windows without Developer
   Mode) it copies, and apply must run again after each pull.

4. Run `kit dotfiles check` again and report each line that is not `ok`. Changes to
   `~/.claude/settings.json` reach a running session only after a restart.

(`kit` is on the Bash PATH while the plugin is enabled; outside a session the same command is
`node "${CLAUDE_PLUGIN_ROOT}/src/kit-cli.mjs" dotfiles …`, or `agent-kit dotfiles …` from a project
that has agent-kit as a dev dependency.)
