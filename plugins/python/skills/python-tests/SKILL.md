---
name: python-tests
description: "Load before editing, writing or reviewing Python tests (test_*.py, *_test.py, conftest.py, tests/), however small the change. Runner, isolation, assertions, doubles, regression tests."
paths:
  - "**/test_*.py"
  - "**/*_test.py"
  - "**/conftest.py"
  - "**/tests/**/*.py"
---

# Python tests

The project's own test rules, required levels and the existing suite's style win.

1. **Runner.** Check before writing: pytest only when the project already uses it (a `[tool.pytest.ini_options]` or `pytest.ini`/`conftest.py`, `pytest` among its dependencies, or existing pytest-style tests). Otherwise use the standard library's `unittest` (`python -m unittest discover -s tests`); adding pytest is a new dependency to propose first. Run tests through `kit.json` `commands.test` when set.
2. **Through the contract.** Test what callers rely on: public functions, the CLI, the output. Not private helpers, call counts on your own code, or library behaviour.
3. **Exact assertions.** Assert exact values and every observable effect, including effects that must not happen. Build the expected value independently (a literal or a simpler calculation); write a rule's numbers as literals, not the module's constant.
4. **Specific failures.** Assert the specific exception type (`pytest.raises(ValueError, match=...)`, `assertRaises`), not "any error".
5. **Boundaries.** Cover empty, absent, zero and negative input, and the values on each side of a limit.
6. **One rule per test**, named for the rule (`test_expired_session_is_removed`). Parametrize (`pytest.mark.parametrize`, `subTest`) only cases of that one rule.
7. **Independent.** Each test builds its own data in a temporary directory (`tmp_path`, `tempfile`) and restores any environment, working directory or global it changes, so it passes alone, in any order and in parallel. Tests use synthetic sample data, never a real data folder or production service.
8. **Doubles.** Prefer the real object, then an in-memory fake of your own interface, then a stub. More than two patches for one rule means the code needs a seam. Inject clocks, randomness (fixed seeds) and ids that affect a decision.
9. **Regression first.** For a bug, write the test where the broken rule lives, watch it fail for the right reason, then fix. A flaky test is a defect: never rerun to green.
10. **Never weaken, skip or delete a test to get a green run**: fix the code, or report the conflict.
11. **What not to test**: settings plumbing, constants echoed back, log or help wording, plain data holders, the same rule at several levels.
