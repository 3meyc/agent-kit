# Архітектура

[English](architecture.md) · **Українська**

## Шари

```mermaid
flowchart LR
  K["agent-kit<br/>(базовий)"] --> O["набір-надбудова<br/>(для групи)"]
  K --> P1["проєкт A"]
  O --> P2["проєкт B"]
  O --> P3["проєкт C"]
  K --> P2
  K --> P3
```

Проєкт вмикає базовий набір напряму, а якщо належить до групи — ще й набір-надбудову.
Надбудова ніколи не копіює базові плагіни: вона оголошує залежність від них.

## Залежності плагінів

```mermaid
flowchart BT
  sdlc --> core
  session --> core
  svelte --> core
  python --> core
  sdlc -. "необов'язково" .-> session
```

| ID | Плагін | Містить |
| --- | --- | --- |
| 1 | `core` | Постійні правила, агенти `check-runner` і `repo-sweep`, хуки редагування й оболонки, `kit doctor`, `/kit-inventory`, `/kit-adopt`, перевірка парності документації |
| 2 | `sdlc` | П'ять скілів `/sdlc-*`, агенти `sdlc-simplifier` і `sdlc-verifier` |
| 3 | `session` | Хуки й скрипти журналу сесій, `/handoff`, `/close-out`, `/close-siblings`, `/git` з агентом `git-ops`, підготовка й злиття worktree |
| 4 | `svelte` | Домовленості для Svelte 5 |
| 5 | `python` | Домовленості для Python |

## Що лишається в проєкті

```mermaid
flowchart LR
  subgraph kit["З наборів (ніколи не копіюється)"]
    rules["правила"]
    skills["скіли, агенти, команди"]
    hooks["хуки й скрипти"]
  end
  subgraph repo["У проєкті"]
    kj["kit.json"]
    st[".claude/settings.json<br/>маркетплейси + увімкнені плагіни"]
    dom["доменні скіли, ADR"]
    voc["глосарій, рецепти"]
    led["записи журналу"]
  end
  kj -- "каже набору, де що лежить" --> kit
```

Глосарій (доменні терміни) і рецепти (покрокові інструкції для повторюваних задач) описують
домен самого проєкту, тож вони лишаються в проєкті. Набір знаходить їх через `kit.json`: скіли
SDLC читають глосарій, коли робочий елемент зачіпає доменні терміни, і пропонують відповідний
рецепт під час планування. Набір-надбудова може додати рецепти й терміни, спільні для своєї групи.

## kit.json

Набір ніколи не прописує структуру проєкту жорстко. `kit.json` у корені репозиторію називає
шляхи й команди, якими користуються плагіни. Це чернетка v1; остаточну форму задає
`schema/kit.schema.json`.

```json
{
  "$schema": "https://raw.githubusercontent.com/3meyc/agent-kit/stable/schema/kit.schema.json",
  "project": "my-app",
  "baseBranch": "main",
  "itemPrefix": "APP",
  "ledger": true,
  "paths": {
    "docs": "docs",
    "decisions": "docs/decisions",
    "sdlc": "docs/sdlc",
    "glossary": "docs/glossary.md",
    "recipes": "docs/recipes",
    "ledger": ".claude/ledger"
  },
  "commands": {
    "check": "pnpm run check",
    "test": "pnpm test",
    "build": "pnpm run build",
    "commitAudit": "npx some-audit --base HEAD~1"
  },
  "hooks": { "off": ["ledger-stop"] },
  "devServer": { "port": 5173 }
}
```

`commands.commitAudit` запускається після кожного коміту з кодом, тож скрипт коміту не називає
конкретного інструмента. `hooks.off` перелічує хуки набору, які цей проєкт пропускає: плагін не
можна вимкнути по одному хуку, тож кожен хук набору читає цей список і тихо завершується, якщо
його названо.

## Канали релізів

```mermaid
gitGraph
  commit id: "sdlc: шаблон плану"
  commit id: "session: виправлення журналу" tag: "stable"
  commit id: "core: новий хук"
  commit id: "sdlc: перевірки finish"
```

| ID | Канал | Посилання | Хто користується |
| --- | --- | --- | --- |
| 1 | latest | `main` | Один пілотний проєкт і кожен, хто перевіряє зміну |
| 2 | stable | тег `stable` | Усі інші та кожен набір-надбудова |

Плагіни не мають поля `version`, тож кожен коміт, на який указує посилання, вважається новою
версією. Перенесення `stable` уперед — це реліз; перенесення назад — відкат.
