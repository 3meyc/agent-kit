// GENERATED from shared/changelog.mjs by scripts/vendor-shared.mjs. Edit shared/changelog.mjs and run `npm run vendor`.
// The changelog's unreleased heading, as `kit release` and `evolution status` find it. Node
// built-ins only.

/**
 * `## Unreleased`, or the Keep a Changelog form `## [Unreleased]`, in any case, with an optional
 * link (`## [Unreleased](…/compare/v1.2.0...HEAD)`) and an optional tail that starts with a date or
 * a separator (`## [Unreleased] - 2026-11-13`). `## Unreleased changes` and `### Unreleased` are
 * not it.
 */
export const UNRELEASED_HEADING = /^##[ \t]+(?:\[unreleased\]|unreleased)(?:\([^)]*\)|\[[^\]]*\])?(?:[ \t]+[-–—:(\d].*)?\s*$/i;

/** Whether one changelog line is the unreleased heading. @param {string} line */
export function isUnreleasedHeading(line) {
  return UNRELEASED_HEADING.test(line);
}
