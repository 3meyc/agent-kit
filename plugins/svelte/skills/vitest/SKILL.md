---
name: vitest
description: "Load before editing, writing or reviewing a .test or .spec file (.ts, .js) or the Vite/Vitest config, however small the change. Vitest conventions for TypeScript and JavaScript tests; not for Playwright specs."
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "**/*.test.js"
  - "**/*.spec.js"
  - "**/vite.config.ts"
  - "**/vitest.config.ts"
---

# Vitest

Not for Playwright specs: a `.spec.ts` that imports `@playwright/test` (usually under `e2e/`) also
matches this skill's paths, but follows Playwright and the project's e2e conventions. Leave these
rules aside for it.

1. **New tests use Vitest.** Import `describe`, `it`, `expect`, `vi` and friends from `vitest`, explicitly, unless the project enables Vitest globals.
2. **No Node test runner APIs** (`node:test`, `node:assert`) in these tests.
3. **Migrate as you touch.** An existing test on another runner that you modify moves to Vitest in the same change when that is practical; say so if you leave it.
4. **Run through the project's script** (`kit.json` `commands.test` when set, else the `test` script in `package.json`), so the Vitest config, setup files and environment apply. Run one file with the script plus its path, not a bare `vitest` that skips the setup.
5. **Components.** Test a Svelte component through what a user sees and does (rendered text, roles, events), not its internal state; logic worth many cases belongs in a plain module tested without the DOM.
