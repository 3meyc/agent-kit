---
name: tailwind-styling
description: "Load before styling a .svelte file or editing CSS or the Tailwind config in a project that uses Tailwind. Utility first, theme tokens, no inline styles, class-based dark mode."
paths:
  - "**/*.svelte"
  - "**/*.css"
  - "**/tailwind.config.*"
---

# Tailwind styling

Applies only where the project uses Tailwind. Its design language (tokens, sizes, corners, scrollbars, shared button classes) lives in the project's own rules and wins over this list.

1. **Utility first.** Style with Tailwind utility classes; custom CSS only when no utility does the job.
2. **No inline styles.** No `style` attribute, except for geometry computed at run time (drag positions, measured sizes).
3. **Extract repeats.** A utility pattern used in several places becomes a component, or an `@layer components` class when it is a pure style bundle; reuse the project's shared controls instead of rebuilding their chrome per component.
4. **Tokens over arbitrary values.** Colours, sizes and spacing come from the theme (`theme.extend` in Tailwind v3, `@theme` in v4). No arbitrary values (`bg-[#3775e3]`, `h-[37px]`) when a token exists; add a token instead of repeating a value. Keep the config lean.
5. **Dark mode by class.** When the UI has a light/dark switch, use the class strategy (`darkMode: "class"` in v3, a `dark` custom variant in v4), not only `prefers-color-scheme`.
6. **Readable class lists.** Group utilities the same way each time (layout, then spacing, then colour and type, as in `flex items-center gap-2 …`); follow the project's class-sorting plugin when it has one.
7. **Button labels are not selectable.** Don't add `select-text` / `user-select: text` to buttons or `[role="button"]`.
