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

  classDef kit fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#111827
  classDef over fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#111827
  classDef proj fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111827
  class K kit
  class O over
  class P1,P2,P3 proj
```

- Фіолетовий: базовий набір
- Бурштиновий: набір-надбудова
- Синій: проєкти

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

  classDef base fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#111827
  classDef kit fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#111827
  class core base
  class sdlc,session,svelte,python kit
```

- Зелений: `core`, потрібний кожному плагіну
- Фіолетовий: плагіни, побудовані на ньому

| ID | Плагін | Містить |
| --- | --- | --- |
| 1 | `core` | Постійні правила (вивід у чат із діаграмами Mermaid і текстовими позначками, оболонка, межі інструментів), скіл `diagrams`, агенти `check-runner` і `repo-sweep`, хуки редагування й оболонки, `kit doctor`, `/kit-inventory`, `/kit-adopt`, `/change-review`, `/repo-audit`, перевірка парності документації |
| 2 | `sdlc` | П'ять скілів `/sdlc:*`, агенти `sdlc:simplifier` і `sdlc:verifier` |
| 3 | `session` | Хуки й скрипти журналу сесій, `/handoff`, `/close-out`, `/close-siblings`, `/backlog`, `/git` з агентом `git-ops`, `/ui-fixes`, підготовка й злиття worktree, сторінки `evolution` |
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

  classDef kitc fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#111827
  classDef link fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#111827
  classDef proj fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111827
  class rules,skills,hooks kitc
  class kj,st link
  class dom,voc,led proj
```

- Фіолетовий: те, що дають набори
- Бірюзовий: файли, що пов'язують проєкт із наборами
- Синій: власні знання й записи проєкту

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

`commands.commitAudit` запускається після кожного коміту з кодом, тож скрипт коміту не називає
конкретного інструмента; `{files}` у ній стає закоміченими шляхами (вони також є в
`KIT_COMMIT_PATHS`), тож аудит може показати лише те, що зачепив коміт. `commands.install` готує
новий worktree (без нього `session` вгадує pnpm чи npm за lock-файлом), а `commands.dev` запускає
dev-сервер там, де немає панелі Browser настільного застосунку. `paths.uiScopes` — карта областей,
яку читає `/ui-fixes`: області застосунку з їхніми маршрутами в harness і теками
([використання](using.uk.md) § 9). `lintOnEdit` перевіряє лінтером
кожен змінений файл: одне правило або список правил, кожне з командою, де `{file}` — шлях відносно
репозиторію в лапках, і шаблонами `match`, що вибирають її файли; запускається кожне правило, що
збіглося. `checks` називає набори команд для `/core:check <набір>`, а `preflight` — необов'язкові
кроки, пропущені коміти яких рахує `session`; крок з `"scope": "main"` виконується один раз у
головній сесії, на злитому дереві. `parentFiles` називає спільні файли, які править лише головна
сесія, а `regenerate` — згенеровані файли, конфлікт злиття в яких розв'язує команда
([README session](../plugins/session/README.uk.md), «Підсесії й головна сесія»). `hooks.off` перелічує хуки набору, які цей проєкт
пропускає: плагін не можна вимкнути по одному хуку, тож кожен хук набору читає цей список і тихо
завершується, якщо його названо. `docsParity.ignore` перелічує шляхи, які пропускає
`kit-docs-parity`, наприклад теку сторінок лише українською, англійські версії яких з'являться
пізніше ([README core](../plugins/core/README.uk.md), «Команди оболонки»).

Усі плагіни читають `kit.json` одним модулем, `shared/kit-config.mjs`, скопійованим у `lib/`
кожного плагіна: він підставляє типові значення зі схеми й відповідає на `hooks.off`.

## Канали релізів

```mermaid
gitGraph
  commit id: "sdlc: шаблон плану"
  commit id: "session: виправлення журналу" tag: "stable" type: HIGHLIGHT
  commit id: "core: новий хук"
  commit id: "sdlc: перевірки finish"
```

- Заповнений квадрат: коміт, на який указує `stable`, тобто реліз
- Кола: коміти в `dev`, канал latest

| ID | Канал | Посилання | Хто користується |
| --- | --- | --- | --- |
| 1 | latest | `dev` (`#dev`: маркетплейс, доданий без посилання, іде за гілкою за замовчуванням на GitHub) | Один пілотний проєкт і кожен, хто перевіряє зміну. У `main` лише випущена робота, той самий коміт, що й `stable` |
| 2 | stable | тег `stable` | Усі інші та кожен набір-надбудова |

Плагіни не мають поля `version`, тож кожен коміт, на який указує посилання, вважається новою
версією. Перенесення `stable` уперед — це реліз; перенесення назад — відкат.
