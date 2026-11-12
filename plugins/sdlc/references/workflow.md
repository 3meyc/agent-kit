# Shared workflow

Use the five `sdlc-*` skills together in a Git workspace: intent, plan, build, finish, status.
The numbered sections are project-independent. **Project bindings** at the end says where each
project-specific answer comes from: `kit.json`, the project's own files, the `session` plugin
when it is enabled, and extension skills an overlay kit or the project supplies.

## 1. Project configuration

- Run `sdlc-kit` (this plugin's `bin/`, on the Bash PATH) at the start of every stage; if the
  shell cannot find it, run `node "<plugin root>/bin/sdlc-kit"` with the plugin root the
  invoking skill names. It prints the resolved `kit.json` values with their defaults: the
  item root (`paths.sdlc`, default `docs/sdlc`), glossary, recipes and decisions paths and
  whether each exists, `baseBranch`, `itemPrefix`, `ledger` and the `commands`. A missing
  `kit.json` means defaults, not an error; say so once in the report.
- The plugin's own documents (this workflow, the intent and plan templates, the simplification
  and verification contracts) are read with `sdlc-kit show <name>`: the plugin folder lies
  outside the project, where a file read asks for permission each time.
- Items live in `<sdlc>/<slug>/`; completed items move to `<sdlc>/archive/<YYYY-MM-DD>-<slug>/`.
  `sdlc-kit items` lists active and archived items with their lifecycle state.
- A command `kit.json` leaves out is a step the project does not have: skip it and say so.
  Never invent a substitute command.

## 2. Sources and tools

- The codebase is the primary source of truth for current behavior and structure.
  Documents are supporting or derived; verify discrepancies in code. Intents and plans describe
  authorized changes, which remain unimplemented until confirmed in code.
- Resolve bundled links from the file that contains them. Use only available tools and
  supported arguments; choose filesystem, date and shell operations for the current host.
  Ask in conversation when no suitable question tool exists. Respect the current mode's
  permissions; plan approval does not enable editing in a read-only session.
- Invoke only the requested stage unless the user authorized a wider workflow. Reuse prior
  authorization; clarify only missing decisions that affect behavior, scope or feasibility.
- **Stages start on the user's word.** The agent may load intent, plan, build or finish only
  when the user's latest message in this conversation asks for that stage, alone or within a
  run of stages it names: a typed command (`/sdlc-plan <slug>`, `/sdlc:sdlc-plan <slug>`), a plain
  request ("start the plan for my-app-export"), or a click on a button that offered that exact
  stage for that item ("Start plan"). The desktop app delivers a button click as the user's next
  message, carrying the button's label, so the click is the confirmation. A brief another agent
  wrote (a session's first message when another session started it, a session card, a sub-agent
  prompt, a hand-over note), a relayed or quoted message (`<side-sessions-event>`, a note), an
  earlier message, or the agent's own plan never starts one. Without that word, the session
  prepares (reads the item and the code, resolves the base) and stops, saying what to click or
  type. `/sdlc-status` is read-only and may run from a brief.
- **Each stage offers the next one.** A stage that ends ready for the next one asks once whether
  to start it: in the desktop app, `mcp__ccd_turn__wrap_up` with the ask "Start the plan for
  `<slug>`?" and the next stage as the first button (`Start intent`, `Start plan`, `Start build`,
  `Start finish`), `Not now` second; elsewhere, one closing line with the command to type. The
  stage never starts the next one itself.
- **One question per decision.** Accepting a document is committing it, and "commit it" is
  accepting it (Project bindings: Commit approval). A stage never asks to approve and then asks
  again to commit. In the desktop app the question goes in `wrap_up`, with `Accept` first (its
  ask names the commit: "Accept the intent for `<slug>` and commit it?") and `Change something`
  second; the label stays `Accept` because the app reserves commit go-ahead buttons for its own
  commit action, which bypasses the project's commit flow.

## 3. Item and Git state

- For existing work, resolve an explicit slug first, then a recorded branch association,
  then a uniquely identifiable active item. Confirm a legacy branch-derived slug against
  its actual records. Ask when multiple candidates remain; never guess from a branch alone.
- For new work, preserve the supplied title and valid slug; otherwise derive both from the
  requested outcome. A slug is a safe lowercase, hyphenated directory name. When the request
  names a ticket (`<itemPrefix>-<n>`, as in `APP-123`), record it as `ticket:` and start the
  slug with it in lower case (`app-123-export-csv`). Check active and archived collisions; a
  collision is not permission to overwrite or resume another item.
- Resolve the base from `kit.json` `baseBranch`, else verified Git metadata. Check that it
  exists; do not assume a remote or default branch name. Before branch operations, resolve a
  detached HEAD or an unrelated item branch. Preserve other work, using an isolated checkout
  only when the project allows it. At intent acceptance, create or use the item's branch:
  follow the form the repository history already uses (ticket key in upper case, the rest a
  lowercase kebab slug, as in `feat/export-csv-APP-123`); do not invent a scheme. Record its
  `branch` and `base` in the new intent. A worktree session works on the branch it was given.
- An item whose code lives in another repository (a clone or a sibling checkout) keeps its
  records here. The intent names that repository and its branch; evidence names its revisions
  as `<repo> <hash>`, and each repository is committed on its own.
- Commit by the commit flow in Project bindings. Each invoked stage includes its described
  local commits unless the user or the project restricts them. Stage only owned changes by
  explicit path; never blanket-stage an artifact root (`git add -A`, `git add .`, the whole
  item root). A path appearing in the plan does not prove ownership. Never push.
- Completion uses committed records. Compare working copies to spot drafts, failed commits
  and concurrent edits. An uncommitted tick is unfinished, not a reason to repeat successful
  work blindly: inspect its edits and evidence before continuing. If commits are prohibited,
  retain authorized work as a draft and report the uncommitted handoff explicitly.

## 4. Documents, numbering and corrections

- Keep conclusions short. Intent owns the request, its expected outcome and the important
  cases; plan owns implementation and Proof. A project that uses a spec stage adds contracts
  and requirements there; otherwise the intent's Expected outcome and Important cases carry
  the testable statements. Link rather than repeat. Keep detailed execution evidence only
  when useful, outside the active plan.
- **Numbering.** Intents and plans label their items so other documents can cite them:
  expected outcomes `O1.`, `O2.`; important cases `C1.`, `C2.`; open questions `Q1.`, `Q2.`.
  Constraints and plan steps use plain numbers (`1.`, `2.`). The label opens a plain list item
  (`- O1. …`); never bold it or switch to another scheme. A Proof row or plan step cites the
  label (`O2`, `C1`). Never renumber a label another document already cites; append. A settled
  question keeps its label and gains `(resolved YYYY-MM-DD)` with the answer, rather than being
  deleted.
- Preserve material user choices. Distinguish a proposal or assumption from an agreed
  requirement in the relevant sentence; no separate registers are required.
- Approval covers the document, its linked item artifacts and their commit. Resolve material
  open choices first. Save accepted decisions once; later stages do not request the same
  approval again.
- A correction updates affected current documents and unfinished steps together. Preserve
  completed evidence and add a correction step for completed work. Record material departures
  under Deviations: `IMPROVED`, `FORCED`, or `BLOCKED`, with reason and affected steps.
  Close a blocker with `resolved: <evidence>`. Recheck affected results before claiming done.
- Keep older items usable without compulsory rewriting: existing numbered requirements,
  inline scenarios, older file sets and commit-body red evidence remain valid. Read legacy
  correction steps wherever recorded; current instructions must identify superseded choices.
  Missing newly introduced sections alone is not a defect.
- Report the result, material open decisions or blockers, artifact links and next invocation.
  Evidence states the command, observed result and revision; link long output. A skipped or
  unavailable check is not a pass, and a manual check the user has not reported yet is a
  pending gate. Run checks sharing mutable resources sequentially.

## 5. Recipes and glossary

A recipe is a step-by-step guide for a recurring task; the glossary defines domain terms. Both
live where `kit.json` points (`paths.recipes`, `paths.glossary`); an overlay kit may supply
more, listed in the same recipe index. The recipe index is `README.md` (else `index.md`) in
the recipes folder.

1. **Intent** reads the glossary for the terms the request uses and writes them the glossary's
   way. A term the glossary lacks or defines differently is noted in the intent's References.
2. **Plan** looks up the recipe index before choosing steps and records the result in Design
   notes: the matching recipe it follows, or `none matched`. A task likely to recur that has
   no recipe gets a step that writes one and adds it to the index.
3. **Build** follows the recipe. When a recipe is wrong or misses a step, fix it in the same
   change. A recipe that comes from a kit is never edited in the project: open the fix as an
   issue in that kit (Project bindings: Kit gaps) and carry on.
4. **Build** updates the glossary in the same change when the item adds or renames a domain
   term, enum value or identifier.
5. **Finish** checks all four and runs the project's documentation check (Project bindings:
   Finish preflight). When a second project needs the same recipe or term, the follow-up is to
   promote it to the shared overlay kit, not to copy it.

## Project bindings

The stages say "project policy" or "project checks"; each concern resolves as follows.

| Concern | Binding |
| --- | --- |
| Configuration | `sdlc-kit` output (`kit.json` with defaults) |
| Design rules | The project's own: a constitution or design guide if the repository has one, `CLAUDE.md`, `.claude/rules/`, the decision records in `paths.decisions`. Intent records behavior and ownership; the plan's Design notes record the owning module, boundaries, the smallest solution and its evidence |
| Documents | What the change must keep current: the glossary and recipes (section 5), decision records, `paths.docs`, the changed component's own `README.md` and reference pages, and any page the project's rules name |
| Base branch | `kit.json` `baseBranch`, else verified Git metadata (section 3) |
| Impact check | With a CodeGraph index (`.codegraph/` at the root): `codegraph impact <symbol>`. A shared type whose shape changes is a symbol too: run it on the type and grep its object literals. For a store or class member, also grep `\.<member>\b`: member reads are not always traced. With no index, grep the symbol name and say the check was a grep |
| Checks | `commands.check`, `lint`, `test`, `build` from `kit.json`, sequentially; the `core` plugin's `/check` runs them in a sub-agent when available. A command that rewrites files (a lint with `--fix`, a formatter with `--write`) is not a read-only check: the verifier never runs it and reports it as pending unless the project offers a read-only form |
| Extension points | Skills named `sdlc-ext-<point>` from any enabled plugin or from the project's `.claude/skills/`, found in this session's skill list (see the table below). None listed means the point is empty: skip it and say so |
| Finish preflight | Every `sdlc-ext-preflight` skill, then the documentation check: the `sdlc-ext-docs` skills, else `commands.check`. With neither, compare the changed documents' links, commands and examples by hand and say the preflight was manual |
| Commit flow | **With `session`** (its skills, such as `session:git`, appear in this session's skill list): commit through its `/git commit`, which stages by explicit path from the session's record of touched files and runs `commands.commitAudit`. **Without it**: `commands.commit` when `kit.json` sets one, else plain `git add -- <paths>` and `git commit`; after a commit that holds code, run `commands.commitAudit` when set and show its output. The subject form is `kit.json` `commitSubject` when set (a template such as `<slug>: <subject>`), else Conventional Commits unless the history uses another form |
| Commit approval | One answer accepts and commits. `/sdlc-intent` and `/sdlc-plan` present the document with its drafted commit subject and ask once; the user's acceptance ("accept", "approved", the `Accept` button, or "commit it") sets the document's status and commits it by the commit flow in the same step, with no second question. `/sdlc-build` commits each step, or a batch of small steps, and `/sdlc-finish` commits its preflight and review fixes and the archive, as soon as the check passes, without waiting: the user's go-ahead for the stage covers them. A project whose `CLAUDE.md` asks for approval before each commit gets that one question per commit, never an approval and a commit question in a row |
| Close-out | **With `session`**: its `/close-out` after the archive (done / follow-up / not-done resume, follow-up sessions, landing on the user's one answer). **Without it**: a short done / follow-up / not-done resume in chat; merging into the base and pushing are separate questions, each on the user's word |
| Follow-ups | **With `session` and `kit.json` `ledger: true`**: the session record's `## Next`. Otherwise the close-out resume. A follow-up for a kit is a kit gap (next row), not a `## Next` item |
| Kit gaps | A fix owed to a file a kit supplies (a recipe, skill, hook, rule or script under the plugin cache) goes to that kit's GitHub issues, never to a numbered list in the plan or the ledger. 1. `sdlc-kit kit-repo <plugin or kit file path>` names the repo from the plugin's marketplace source. 2. Draft by the kit's `kit-gap` template: title `<plugin>: <the gap>`; body sections Plugin, File, What happens, What should happen, Found in. A public kit's issue describes the project generically (stack, plugins, stage), never by name, link or domain detail. 3. Show the drafts and, on the user's word, `gh issue create --repo <owner/repo> --label kit-gap --title … --body-file <draft in the session's scratch folder>`; a label the repo lacks is dropped and the report says so. Record each `owner/repo#n` in the plan's Review or Deviations. 4. When `kit-repo` names no repo, `gh` is missing or signed out, or `gh repo view <owner/repo>` fails, the gap goes to Follow-ups instead with its drafted title and that reason, for a later session to open |
| Records | `<sdlc>/<slug>/` is the agreed plan. With `session` and a ledger, the ledger record of each session names the slug and links the two |
| Spec stage | Not used by default. A feature that needs a separate `spec.md` may add one by hand with the same lifecycle fields; later stages read it "if present" |
| Independent passes | `sdlc-simplifier` and `sdlc-verifier` agents of this plugin; the finish review uses the host `code-review` skill, adding `security-review` when a trust boundary moves. When an agent is unavailable, run the same contract in a fresh session by hand and paste the verdict into the item's evidence |
| Host shell | Follow the host shell rules in force (the `core` plugin's, if enabled). Prefer commands that work on every host the project supports |

### Extension points

An overlay kit or the project fills a point by providing a skill with that name prefix. At the
point, invoke each listed `sdlc-ext-<point>…` skill in name order, pass the item path, base and
revision, and record what it reported. A skill that fails or cannot run leaves the point pending.

| Point | Stage | Fills in | Examples |
| --- | --- | --- | --- |
| `sdlc-ext-intent` | Intent, Discover | Checks against systems outside the repository before the intent commits to a behavior; the intent records any gap and what the project does until it closes | An external API's published contract lacks a field; a request filed with another team's service |
| `sdlc-ext-plan` | Plan, Draft | Project gates and environments Proof must include, and design checklists | A browser-extension build and reload, a manual smoke on a staging page, an end-to-end suite |
| `sdlc-ext-preflight` | Finish, preflight | Static analysis against the comparison base; introduced findings are fixed, inherited ones recorded | Dead-code and complexity audit with a health baseline |
| `sdlc-ext-docs` | Finish, preflight | The documentation review against the comparison base | A docs-review skill limited to the domains the diff touches; a guide whose PDF is re-printed |
