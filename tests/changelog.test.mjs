// The changelog's unreleased heading that `kit release` and `evolution status` share.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnreleasedHeading } from "../shared/changelog.mjs";

test("the unreleased heading in its plain and Keep a Changelog forms", () => {
  for (const line of [
    "## Unreleased",
    "## unreleased  ",
    "## UNRELEASED",
    "## [Unreleased]",
    "## [unreleased]",
    "## [Unreleased] - 2026-11-13",
    "## [Unreleased] (2026-11-13)",
    "## Unreleased — 2026-11-13",
    "## [Unreleased](https://example.com/my-app/compare/v1.2.0...HEAD)",
    "## [Unreleased][compare]",
    "## [Unreleased]\r",
  ]) {
    assert.equal(isUnreleasedHeading(line), true, line);
  }
});

test("lines that are not the unreleased heading", () => {
  for (const line of [
    "## 2026-11-13 — twelfth `stable`",
    "## [1.2.0] - 2026-11-13",
    "### Unreleased",
    "### [Unreleased]",
    "# Unreleased",
    "## Unreleased changes",
    "## [Unreleased",
    "[Unreleased]: https://example.com/my-app/compare/v1.2.0...HEAD",
    "- Unreleased",
  ]) {
    assert.equal(isUnreleasedHeading(line), false, line);
  }
});
