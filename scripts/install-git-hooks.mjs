#!/usr/bin/env node
// Point this clone's git hooks at .githooks/, so the naming guard runs before every push. Runs as
// `npm run hooks:install` (kit.json commands.install), never as `prepare`: pnpm refuses a git
// dependency with a prepare script. Does nothing outside this repo's own checkout (a tarball or a
// consumer's node_modules) and leaves another hooks path alone, saying so.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const top = git("rev-parse", "--show-toplevel");
const here = resolve(process.cwd());
if (top.status !== 0 || resolve(top.stdout.trim()) !== here || !existsSync(resolve(here, ".githooks"))) process.exit(0);
const current = git("config", "--local", "core.hooksPath").stdout.trim();
if (current && current !== ".githooks") {
  console.log(`install-git-hooks: keeping core.hooksPath=${current}; .githooks/pre-push (naming guard) is not active.`);
  process.exit(0);
}
if (current !== ".githooks") git("config", "--local", "core.hooksPath", ".githooks");
