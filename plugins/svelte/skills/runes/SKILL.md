---
name: runes
description: "Load before editing, writing or reviewing any .svelte, .svelte.ts or .svelte.js file, however small the change. Svelte 5 runes: $state, $derived, $effect, props, data flow."
paths:
  - "**/*.svelte"
  - "**/*.svelte.ts"
  - "**/*.svelte.js"
---

# Svelte 5 runes

The project's own rules and the surrounding code win where they differ.

1. **Runes only.** Legacy reactivity (`$:`, `export let`, `$$props`) is not used in new or edited code.
2. **One job per rune.**
   - `$state(initial)` for local reactive state.
   - `$derived(expr)` / `$derived.by(fn)` for computed values: pure, no side effects.
   - `$effect(fn)` for side effects only (DOM work, logging, subscriptions); clean up by returning a function.
3. **Props are read-only.** Declare them with `$props()` and an explicit type; never mutate one. Need a local editable copy: a `$state` seeded from it. Two-way binding only through `$bindable()`.
4. **State placement.** Local `$state` first; a shared `.svelte.ts` module or context for cross-component state; stores only where a library or truly global state needs them.
5. **Declarative templates.** Branching, calculations and formatting move into the script as `$derived`; the template only reads values.
6. **Composability.**
   - One component per file.
   - Logic a test could check without the DOM goes into plain functions or modules, unit-tested; the component wires them up.
   - ~200 lines is a prompt to look for logic that belongs in a module, not a cap: don't split a component just to meet a line count, since prop drilling and indirection cost more than length. Use the project's complexity or duplication checks where it has them.
7. **Effects and lifecycle.** Prefer `$effect` over lifecycle hooks; use `onMount` only for direct DOM access or browser-only APIs that must not run during SSR.
8. **Types.** No implicit `any`; type props, and type `$state` / `$derived` where inference is not obvious.
9. **Reactivity.**
   - Read every dependency inside the `$derived` or `$effect` that uses it; no hidden dependencies.
   - Never write state from a `$derived`; avoid writing state from an `$effect` when a `$derived` can compute it.
   - Plain objects and arrays in `$state` react to in-place changes; `$state.raw` values, class instances and plain `Map`/`Set` do not (reassign, or use `SvelteMap`/`SvelteSet` from `svelte/reactivity`).
10. **Data flow.** One direction; derive instead of duplicating state; keep writable state minimal.
11. **Svelte MCP**, when the project connects the official Svelte MCP server:
    - Unsure about an API: `list-sections`, pick sections by their `use_cases`, then `get-documentation` for only those (token-heavy, so try your own knowledge first).
    - After writing or editing a component, run `svelte-autofixer` with `desired_svelte_version: 5` and `filename` (the component name plus `.svelte`, not a path); fix what it reports and rerun until clean.
    - Tools deferred: load them through tool search. Server configured but not connected: say so rather than skipping the autofixer.
