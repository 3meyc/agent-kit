# Architecture

**English** · [Українська](architecture.uk.md)

## Layers

```mermaid
flowchart LR
  K["agent-kit<br/>(base)"] --> O["overlay kit<br/>(per group)"]
  K --> P1["project A"]
  O --> P2["project B"]
  O --> P3["project C"]
  K --> P2
  K --> P3

  classDef kit fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#111827
  classDef over fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#111827
  classDef proj fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111827
  class K kit
  class O over
  class P1,P2,P3 proj
```

- Violet: the base kit
- Amber: an overlay kit
- Blue: projects

A project enables the base kit directly, and an overlay kit if it belongs to a group. An overlay
never copies base plugins: it declares a dependency on them.

## Plugin dependencies

```mermaid
flowchart BT
  sdlc --> core
  session --> core
  svelte --> core
  python --> core
  sdlc -. "optional" .-> session

  classDef base fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#111827
  classDef kit fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#111827
  class core base
  class sdlc,session,svelte,python kit
```

- Green: `core`, which every plugin needs
- Violet: the plugins built on it

| ID | Plugin | Contains |
| --- | --- | --- |
| 1 | `core` | Always-on rules (chat output with Mermaid diagrams and text-symbol markers, shell, tooling limits), the `diagrams` skill, `check-runner` and `repo-sweep` agents, edit and shell hooks, `kit doctor`, `/kit-inventory`, `/kit-adopt`, `/change-review`, `/repo-audit`, docs parity check |
| 2 | `sdlc` | Five `/sdlc:*` skills, `sdlc:simplifier` and `sdlc:verifier` agents |
| 3 | `session` | Ledger hooks and scripts, `/handoff`, `/close-out`, `/close-siblings`, `/backlog`, `/git` with the `git-ops` agent, `/ui-fixes`, worktree set-up and landing, the `evolution` pages |
| 4 | `svelte` | Svelte 5 conventions |
| 5 | `python` | Python conventions |

## What a project keeps

```mermaid
flowchart LR
  subgraph kit["From the kits (never copied)"]
    rules["rules"]
    skills["skills, agents, commands"]
    hooks["hooks and scripts"]
  end
  subgraph repo["In the project"]
    kj["kit.json"]
    st[".claude/settings.json<br/>marketplaces + enabled plugins"]
    dom["domain skills, ADRs"]
    voc["glossary, recipes"]
    led["ledger records"]
  end
  kj -- "tells the kit where things are" --> kit

  classDef kitc fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#111827
  classDef link fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#111827
  classDef proj fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111827
  class rules,skills,hooks kitc
  class kj,st link
  class dom,voc,led proj
```

- Violet: what the kits supply
- Teal: the files that tie the project to the kits
- Blue: the project's own knowledge and records

The glossary (domain terms) and the recipes (step-by-step guides for recurring tasks) describe
the project's own domain, so they stay in the project. The kit knows where they are from
`kit.json`: the SDLC skills read the glossary when a work item touches domain terms and offer a
matching recipe when planning. An overlay kit can add recipes and terms shared by its group.

## kit.json

The kit never hard-codes a project's layout. `kit.json` at the repo root names the paths and
commands the plugins use. Draft v1; the final shape lives in `schema/kit.schema.json`.

```json
{
  "$schema": "https://raw.githubusercontent.com/3meyc/agent-kit/stable/schema/kit.schema.json",
  "project": "my-app",
  "baseBranch": "dev",
  "itemPrefix": "APP",
  "ledger": true,
  "paths": {
    "docs": "docs",
    "decisions": "docs/decisions",
    "sdlc": "docs/sdlc",
    "glossary": "docs/glossary.md",
    "recipes": "docs/recipes",
    "ledger": ".claude/ledger",
    "evolution": "docs/evolution",
    "uiScopes": "docs/ui-scopes.md"
  },
  "commands": {
    "install": "pnpm install --frozen-lockfile",
    "dev": "pnpm run dev",
    "check": "pnpm run check",
    "test": "pnpm test",
    "build": "pnpm run build",
    "commitAudit": "npx some-audit --base HEAD~1 --only {files}"
  },
  "lintOnEdit": [
    { "command": "pnpm exec eslint --no-warn-ignored {file}", "match": ["*.ts", "*.svelte"] },
    { "command": "pnpm run i18n:check", "match": ["src/locales/*.json"] }
  ],
  "checks": { "i18n": ["pnpm run i18n:check", "pnpm run i18n:parity"] },
  "preflight": { "docs-review": { "description": "Docs review skill", "match": ["docs/**"], "remindAfter": 3 } },
  "hooks": { "off": ["ledger-stop"] },
  "docsParity": { "ignore": ["docs/guide/**"] },
  "devServer": { "port": 5173 }
}
```

`commands.commitAudit` runs after each commit that holds code, so the commit script names no
specific tool; `{files}` in it becomes the committed paths (also in `KIT_COMMIT_PATHS`), so the
audit can report only what the commit touched. `commands.install` sets up a fresh worktree (without
it, `session` guesses pnpm or npm from the lockfile), and `commands.dev` starts the dev server where
the desktop app's Browser pane is not available. `paths.uiScopes` is the scope map `/ui-fixes`
reads: the app's areas with their harness routes and folders ([using](using.md) § 9). `lintOnEdit`
lints each edited file: one rule or a
list of rules, each a command where `{file}` is the quoted repo-relative path, and `match` globs
that pick the files it takes; every matching rule runs. `checks` names suites of commands for
`/core:check <suite>`, and `preflight` names optional steps whose skipped commits `session` counts;
a step with `"scope": "main"` runs once in the main session, on the merged tree. `parentFiles`
names shared files only the main session edits, and `regenerate` the generated files a merge
conflict is resolved for by a command ([session README](../plugins/session/README.md), "Sub-sessions
and the main session").
`hooks.off` lists kit hooks this project skips: a plugin can't be switched off hook by hook, so each
kit hook reads this list and exits quietly when named. `docsParity.ignore` lists paths
`kit-docs-parity` leaves out, such as a folder of Ukrainian-only pages whose English pages come
later ([core README](../plugins/core/README.md), Shell commands).

Every plugin reads `kit.json` through the same module, `shared/kit-config.mjs`, vendored into each
plugin's `lib/`: it fills in the schema defaults and answers `hooks.off`.

## Release channels

```mermaid
gitGraph
  commit id: "sdlc: plan template"
  commit id: "session: ledger fix" tag: "stable" type: HIGHLIGHT
  commit id: "core: new hook"
  commit id: "sdlc: finish checks"
```

- Filled square: the commit `stable` points at, the release
- Circles: commits on `dev`, the latest channel

| ID | Channel | Ref | Who uses it |
| --- | --- | --- | --- |
| 1 | latest | `dev` (`#dev`: a marketplace added with no ref follows the GitHub default branch) | One pilot project, and anyone testing a change. `main` holds only released work, the same commit as `stable` |
| 2 | stable | `stable` tag | Everyone else, and every overlay kit |

Plugins carry no `version` field, so each commit a ref points at counts as a new version. Moving
`stable` forward is the release; moving it back is the rollback.
