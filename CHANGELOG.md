# Changelog

Each `stable` release gets one entry: date, the commit it points at, and what changed per plugin.

## Unreleased

- Skeleton: marketplace `agent-kit` with plugins `core`, `sdlc`, `session`, `svelte`, `python` (manifests only), `kit.json` v1 schema, shared hook helpers vendored into each plugin, naming guard in CI.
- Docs: architecture, usage, change flow and evolution pages.
- sdlc: `/sdlc-intent`, `/sdlc-plan`, `/sdlc-build`, `/sdlc-finish`, `/sdlc-status`, `sdlc-simplifier` and `sdlc-verifier` agents, `sdlc-kit` helper; paths and commands from `kit.json`, recipe and glossary checks, `sdlc-ext-*` extension points, `session` plugin used when enabled.
