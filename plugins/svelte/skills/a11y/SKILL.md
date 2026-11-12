---
name: a11y
description: "Load before editing, writing or reviewing markup in any .svelte file, however small the change. Accessibility: semantic HTML, keyboard, form fields, dialogs, tabs, status and loading."
paths:
  - "**/*.svelte"
---

# Accessibility in Svelte components

The project's own rules and shared components win: reuse its dialog, tabs, input and loading components instead of rebuilding them.

1. **No ignore flags.** `<!-- svelte-ignore a11y_* -->` only where no native HTML alternative exists; fix the markup instead of silencing the warning.
2. **Semantic HTML.** `<button>` for actions, `<a href>` for navigation; no click handlers on a `<div>` or `<span>`.
3. **Keyboard.** Every custom interactive element takes `Tab` focus and responds to `Enter` / `Space`; arrow keys where the ARIA pattern expects them.
4. **No nested interactivity.** No buttons or links inside a `role="button"` container or another control; one native control per action.
5. **Focus visible.** Never remove the focus outline (`outline-none`, `outline: none`) without a `:focus-visible` replacement.
6. **Form fields.** Every `<input>`, `<textarea>` and `<select>` has both `id` and `name`, and an accessible label: a visible `<label for>` matching the `id`, or `aria-label` when no visible label fits. A placeholder is not a label.
7. **Unique ids.** Ids are unique on the page, including panels that stay mounted while hidden; pass distinct ids when a shared input component is used twice.
8. **Hidden and blocked content.** An inactive panel gets the `hidden` attribute (or equivalent) and `inert`; a blocked section gets `inert`, not only reduced opacity and `pointer-events: none`. Never `display: contents` on a panel root.
9. **Icon-only controls.** An accessible name through `aria-label` (translated where the app is localized), plus `title` if the project shows tooltips; the icon inside a labelled control is `aria-hidden="true"`.
10. **Dialogs.** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` its title, focus moved in on open, focus trapped while open, `Escape` closes, focus returns to the opener on close. A native `<dialog>` with `showModal()` covers most of this.
11. **Tabs.** `role="tablist"` / `"tab"` / `"tabpanel"`, `aria-selected`, `aria-controls`, roving `tabindex`, arrow keys move between tabs and focus follows the selection.
12. **Status is not colour alone.** Busy, error and success states carry readable text (visible or `sr-only`).
13. **Live regions.** Async content that stays on screen: `role="status"` (or `aria-live="polite"`) with `aria-busy` while loading and `sr-only` text. A one-off result (saved, copied): use the app's existing toast or notification host, which already owns a live region; don't add another.
14. **Disabled with a reason.** Name the reason in an `aria-describedby` target (visible or `sr-only`), not only in `title`, which browsers often don't show on disabled controls.
