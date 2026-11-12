---
name: code
description: "Load before editing, writing or reviewing any .py file or pyproject.toml, however small the change. Python toolchain (uv, version pin), layout, typing, errors and the checks to run."
paths:
  - "**/*.py"
  - "**/pyproject.toml"
---

# Python code

The project's own rules, `pyproject.toml`, linters and the surrounding code win; match the neighbouring idioms and leave unrelated code alone.

## Toolchain

1. **Version.** Read the minimum Python (`requires-python`, `.python-version`) first and use nothing newer; never fall back to an older system Python.
2. **uv, not pip.** `uv add` / `uv remove` (dev tools with `--dev`), `uv run` to run; never `pip install` into a uv environment or hand-edit `uv.lock`.
3. **Dependencies are a decision.** Standard-library-only code stays that way; propose a new dependency before adding it. A standalone script that needs packages declares them in a PEP 723 header (`# /// script` … `# ///`) and runs with `uv run <script>`.
4. **Lint and format** with the project's tools; with none configured, `uvx ruff check` and `uvx ruff format --check` on the changed paths, with `--target-version` matching `requires-python`.

## Layout

1. **Scale to the program.** A script is `main()` plus pure functions behind `if __name__ == "__main__":`. Add classes, Protocols or an exception hierarchy when a second caller or a test needs them.
2. **Separate phases** (parse, compute, render or write) with a value between them, so each runs and tests alone. An orchestrator's body is calls to named steps.
3. **Library code takes everything as parameters**: it prints nothing, reads no environment, configures no logging (only `logging.getLogger(__name__)`) and keeps no mutable global state.
4. **Packages.** An application's `__init__.py` holds only a docstring; a library curates its public API there with `__all__`. Private by default (`_name`, `_module.py`).
5. **Import time only defines names**: no I/O, clients, environment reads or logging setup at module level.
6. **Imports.** Import a name from the module that defines it. A circular import means two modules are not layered; fix the layering instead of hiding it with a local import.
7. **No parallel copies.** No `*_v2.py`, `new_*` or `*_old.py`, and no compatibility shims for unreleased code: change it and update the callers.

## Typing

1. Annotate every public function, method and module constant whose type is not obvious; no implicit `Any` leaking out of a module.
2. `X | None` when absence is a normal answer; an exception for failure. Test `is None` where `0`, `""` or `[]` are valid values.
3. Accept the weakest type the body needs (`Iterable`, `Sequence`, `Mapping`); return concrete types.
4. A fixed set of fields is a frozen `dataclass`, not a dict or a tuple of more than two values; a closed set of values is an `Enum`; ids that must not mix are `NewType`.
5. Parse input into precise types once, at the boundary, and trust them inside.
6. A `Protocol` is owned by the code that consumes it and lists only the calls it makes.
7. Closed `match` over an enum or union ends in `assert_never` (3.11+). Annotation-only imports go under `if TYPE_CHECKING:` unless a framework evaluates annotations at run time.
8. Use only what `requires-python` allows: PEP 695 generics (`def f[T]`, `type X = …`) need 3.12; from 3.14 annotations are lazy, so new code needs no `from __future__ import annotations` or quoted forward references.

## Errors

1. Let exceptions propagate; catch only where you can act: retry, fall back, translate at a boundary, or isolate one unit (a request, a job, one batch item) from its siblings.
2. Catch the narrowest type around the statement that raises it; a broad `except Exception` only at an isolation point, logged once.
3. Translate at layer boundaries with `raise AppError(...) from exc`. Don't collapse distinct failures into a silent default (`None`, `[]`, `False`).
4. Files: state the `encoding`, open csv with `newline=""`, and replace a file others read atomically (write a temp file, then `os.replace`).

## Before calling a change done

1. Run once, one after another: formatter check, linter, type checker if the project has one, tests (`kit.json` `commands.check` / `commands.test` when set; core's `/check` runs them). Run a changed script once on sample input, never on private or production data.
2. Investigate findings: no `# noqa`, `# type: ignore` or weakened assertion just to get green; a justified suppression carries its reason.
3. Report what ran, its result, and what was not checked.
