# Плагін session

[English](README.md) · **Українська**

Сесійна частина набору: запис у журналі (ledger) для кожної сесії Claude Code, команди передачі
та завершення роботи, коміти, що беруть лише файли однієї сесії в спільному робочому дереві, і
потік роботи з worktree від підготовки до злиття. Залежить від `core`.

## Що він робить

| ID | Частина | Що робить |
| --- | --- | --- |
| 1 | Журнал сесій | На кожному Stop пише один Markdown-запис на сесію (намір, рішення, наступні кроки, змінені файли) у теку журналу й перебудовує її `INDEX.md`. На старті сесії додає в контекст короткий огляд недавніх записів і невиконаної роботи, без пунктів, які закрило правило автозакриття ([using § 6](../../docs/using.uk.md#6-тримайте-список-next-у-журналі-коротким)) |
| 2 | Скрипт коміту | `git-commit-session` комітить лише шляхи цієї сесії через `git commit --only`, зупиняється, коли шлях заявляє інша сесія, додає трейлер `Session-Id`, запускає аудит коміту проєкту на закомічених шляхах і рахує пропущені необов'язкові кроки проєкту (`preflight`) |
| 3 | Потік worktree | `worktree-flow` показує базу й вердикт кожного worktree, передбачає конфлікти, зливає гілку в базу лише перемоткою (fast-forward) і прибирає злиті worktree. Хук SessionStart готує кожен новий linked worktree |
| 4 | Команди | `/handoff` пише запис посеред задачі; `/close-out` сортує роботу, зливає її й пише підсумок сесії; `/close-siblings` зливає роботу бічних сесій; `/git` виконує git-завдання в агенті `git-ops`, а `/git commit --review` переглядає diff перед комітом |
| 5 | Сторінки еволюції | `process-evolution.md` і `features-evolution.md` у `paths.evolution`: по одній Mermaid-схемі того, як зростали спосіб роботи й функції, з таблицею джерел. `evolution` створює їх, показує, чого бракує, піднімає версію й перевіряє. Їх оновлюють раз на реліз — з рядків `## Unreleased` у changelog і комітів процесу від останнього тегу релізу — через скіл `evolution`; пробний запуск `kit release` з core називає сторінку, яку реліз не оновив |

Claude Code дає командам простір імен: `/session:handoff`, `/session:close-out`,
`/session:close-siblings` і `/session:git`; агент зветься `session:git-ops`. Коротка форма
(`/handoff`) працює, поки жодна інша команда не має такої ж назви.

Проєкт додає власні кроки завершення (перевірку стану своїх клонів, рядки у власному журналі)
скілом з назвою `session-ext-close-out` або `session-ext-close-out-<назва>`: `/close-out` і
`/close-siblings` завантажують кожен такий скіл, доступний у сесії, за порядком назв, перед злиттям.

## Ідентифікатори хуків

Claude Code не вміє вимкнути один хук плагіна, тож кожен хук тут читає `hooks.off` у `kit.json` і
завершується з кодом 0, нічого не роблячи, коли його ідентифікатор у списку. Хуки журналу також
мовчать, поки `kit.json` не задає `"ledger": true`.

| ID | Ідентифікатор хука | Подія | Потрібен `"ledger": true` | Що робить |
| --- | --- | --- | --- | --- |
| 1 | `ledger-stop` | Stop | так | Пише запис сесії та `INDEX.md` |
| 2 | `ledger-brief` | SessionStart | так | Виводить огляд недавніх записів у контекст сесії, а потім правила запису (і з порожнім журналом) |
| 3 | `ledger-shell-deletions` | PreToolUse, PostToolUse (Bash, PowerShell) | так | Знімає стан відстежуваних файлів, які видаляє скрипт, щоб запис зарахував видалення |
| 4 | `ledger-summarize` | (запускає `ledger-stop`) | так | Заповнює запис, який ніхто не написав, дешевою моделлю через `claude -p`. Витрачає токени; додайте його до списку, щоб вимкнути, або задайте `LEDGER_NO_SUMMARY=1` |
| 5 | `worktree-setup` | SessionStart | ні | У новому linked worktree: ставить залежності (`commands.install`, інакше pnpm або npm за lock-файлом), будує індекс CodeGraph, коли він є в основному checkout, довіряє фільтрам RTK, яким уже довіряють деінде. Кожен крок пропускається, коли його інструмент не встановлено. Worktree, який застосунок вирізав зі старішого коміту (без власних комітів, а `baseBranch` пішов далі), отримує рядок із `worktree-flow adopt <base>`, що переносить його на поточні файли |

```json
{ "hooks": { "off": ["ledger-summarize", "worktree-setup"] } }
```

## Поля kit.json, які він читає

| ID | Поле | Типово | Хто читає |
| --- | --- | --- | --- |
| 1 | `ledger` | `false` | Кожен хук журналу; без нього `session-ledger` не пише записів |
| 2 | `paths.ledger` | `.claude/ledger` | Де лежать записи, `INDEX.md` і `archive/` |
| 3 | `paths.sdlc` | `docs/sdlc` | `worktree-flow` читає `base:` елемента з `<item>/intent.md`; `git-commit-session --worktree` зараховує перейменування всередині сесії |
| 4 | `paths.recipes` | `docs/recipes` | `/close-out` і `/handoff` називають області за рецептами |
| 5 | `baseBranch` | `main` | `worktree-flow` віддає їй перевагу, коли вгадує базу; `/git branch` відгалужується від неї |
| 6 | `itemPrefix` | немає | `/git branch <ITEM-ID>` і футери комітів |
| 7 | `commands.commitAudit` | немає | Запускається після кожного коміту з кодом; показується вивід, код виходу — ніколи. `{files}` у ній стає закоміченими шляхами в лапках; вони також є в `KIT_COMMIT_PATHS`, по одному в рядку, тож аудит може показати лише знахідки в них |
| 8 | `commands.check`, `lint`, `test`, `build` | немає | Перевірки, які `/close-out` і `/close-siblings` запускають перед злиттям |
| 9 | `devServer.port` | немає | Завершальний рядок підготовки worktree |
| 10 | `commands.commitMessage` | немає | Перевіряє нове повідомлення коміту, перш ніж `git-commit-session` комітить; `{file}` стає шляхом у лапках до файлу з повідомленням (без нього шлях додається в кінці); ненульовий код виходу відхиляє коміт (код 9) |
| 10 | `hooks.off` | `[]` | Ідентифікатори хуків вище |
| 11 | `commands.install` | здогад за lock-файлом | Крок встановлення під час підготовки worktree; запускається через shell, коли відомий lock-файл новіший за останнє встановлення |
| 12 | `preflight` | немає | Необов'язкові кроки, які час від часу варто запускати перед комітом; кожен коміт, що їх зачіпає, рахується як пропуск і показується, коли сягає `remindAfter` |
| 13 | `paths.evolution` | `docs/evolution` | Де `evolution` і `kit release` шукають сторінки еволюції; якщо там їх немає, проєкт їх не веде |
| 14 | `commitSubject` | Conventional Commits | Форма теми коміту, яку пише `/git commit`, шаблоном на кшталт `<slug>: <subject>` (`<type>`, `<scope>`, `<slug>`, `<ITEM-ID>`, `<subject>`); `git-branch-context` передає його `git-ops` |
| 14 | `commands.evolutionRender` | немає | Рендерить друковану версію сторінки після `evolution bump`; `{page}` стає шляхом сторінки в лапках (без нього шлях додається в кінець) |
| 15 | `ledgerAutoClose.questionDays` | `7` | Скільки днів після останнього оновлення запису його пункт `Open question at Stop` лишається відкритим; потім бриф його приховує, `--owed` показує окремо, `--sweep` позначає |

`preflight` називає необов'язкові кроки проєкту, а не інструменти, відомі набору: кожен має
`description`, необов'язкову `command`, необов'язкові шаблони `match` (без них — будь-який коміт поза
журналом) і `remindAfter` (типово 1). Лічильники лежать у спільній git-теці репозиторію, однаковій
для всіх його worktree. `preflight run <id>` запускає команду й при успіху обнуляє лічильник;
`preflight done <id>` обнуляє крок, виконаний іншим способом, наприклад скілом.

```json
{
  "commands": { "commitAudit": "npx some-audit --base HEAD~1 --only {files}" },
  "preflight": {
    "docs-review": { "description": "Docs review: the project's docs-review skill", "match": ["docs/**", "*.md"], "remindAfter": 3 },
    "audit": { "description": "Dead-code and dependency audit", "command": "pnpm run audit" }
  }
}
```

Checkout визначається з `cwd` у даних хука (або з робочої теки shell), тож сесія у worktree
працює з власними `kit.json`, журналом і файлами цього worktree.

## Команди в PATH для Bash

Тека `bin/` плагіна є в PATH інструмента Bash у сесії. Їх викликають агенти й команди; проєкт
може дозволити їх у `.claude/settings.json` (`Bash(session-ledger --files:*)` тощо).

| ID | Команда | Що робить |
| --- | --- | --- |
| 1 | `session-ledger` | `--files`, `--record`, `--refresh`, `--conflicts`, `--owed`, `--done`, `--sweep`, `--archive`, `--backfill`; `--help` перелічує їх |
| 2 | `git-commit-session` | Коміт за шляхами; `--help` перелічує прапорці й коди виходу |
| 3 | `worktree-flow` | `status`, `resolve`, `base`, `adopt`, `conflicts`, `land`, `remove` |
| 4 | `worktree-setup` | Підготовка, яку запускає хук `worktree-setup` |
| 5 | `git-branch-context` | Гілка, upstream, базова гілка й префікс елементів у JSON, для `/git` |
| 6 | `ledger-export` | Перетворює запис на файл передачі поза репозиторієм (`/handoff --export`) |
| 7 | `scan-ledger-secrets` | Запобіжник для pre-commit: падає на тексті, схожому на секрет, у staged-записах (без шляхів — staged-файли в теці журналу) |
| 8 | `preflight` | `status`, `run <id>`, `done <id>` для кроків `preflight` з `kit.json` |
| 9 | `evolution` | `status [--since-release [<tag>] \| --base <ref>]`, `init`, `bump <page>`, `check` для сторінок еволюції; `--help` перелічує їх |
| 10 | `kit-repo` | `<plugin\|plugin@marketplace\|path> [--json]`: репозиторій GitHub, у якому відкривають issue про прогалину набору, з джерела marketplace плагіна, для `/close-out` і `/handoff` |

Поза сесією (у shell, у git-хуку) команд плагіна немає в PATH. Для перевірки секретів у git-хуку
додайте цей репозиторій як dev-залежність (`github:3meyc/agent-kit#<ref>`) і викликайте
`agent-kit ledger-scan-secrets` (наприклад, з `pre-commit` у lefthook); решту запускайте напряму:
`node <plugin>/scripts/<name>.mjs`.
