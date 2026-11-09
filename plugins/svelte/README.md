# svelte

**English** · [Українська](README.uk.md)

Conventions for Svelte 5 projects: runes, accessibility, Vitest and Tailwind styling. Each one is a
skill with `paths:`, so Claude Code loads it when the session touches a matching file. Nothing
project-specific lives here: a project's own design language, components and folders stay in the
project. Needs `core`.

## Install

With the `agent-kit` marketplace added (see the [root README](../../README.md)):

```bash
claude plugin install svelte@agent-kit
```

## Skills

| ID | Skill | Loads for | Covers |
| --- | --- | --- | --- |
| 1 | `svelte-runes` | `**/*.svelte`, `**/*.svelte.ts`, `**/*.svelte.js` | Runes only, one job per rune, read-only props, state placement, declarative templates, component size, reactivity, the Svelte MCP autofixer |
| 2 | `svelte-a11y` | `**/*.svelte` | Semantic HTML, keyboard, focus, form-field ids and labels, hidden panels, icon-only controls, dialogs, tabs, status and live regions, disabled reasons |
| 3 | `vitest` | `**/*.test.ts`, `**/*.spec.ts`, `**/*.test.js`, `**/*.spec.js`, `**/vite.config.ts`, `**/vitest.config.ts` | Vitest for new tests, no Node test runner APIs, migrate as you touch, run through the project script, test components through what a user sees |
| 4 | `tailwind-styling` | `**/*.svelte`, `**/*.css`, `**/tailwind.config.*` | Utility first, no inline styles, extracting repeats, theme tokens over arbitrary values, class-based dark mode, readable class lists |

A skill's description is listed in every session and its body loads only when the model calls it
(see [spikes](../../docs/spikes.md), S2 and side finding 2). The skills fill what the project leaves
open: the project's own rules and the surrounding code win where they differ.

## What stays in the project

1. Folder layout for helpers, services and stores, and complexity or duplication gates.
2. Design tokens, control sizes, corner radius, scrollbars and shared component names.
3. Icon library, localization and translated-label rules.
4. References to the project's own dialog, tabs, input and loading components and its recipes.

## kit.json

| ID | Key | Used by |
| --- | --- | --- |
| 1 | `commands.test` | `vitest`: the command that runs the tests |

## Retiring project copies

Projects that kept these conventions as `.claude/rules/*.md` files can retire them: `kit doctor`
and `/core:kit-adopt` list the copies named in [kit-owned.json](kit-owned.json). Most of those
files also hold project-specific lines; move those to a rule with another name before deleting the
copy.
