import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUNDLED,
  DEFAULT_PATHS,
  show,
  countSteps,
  frontMatter,
  listItems,
  main,
  readKit,
  resolveBase,
  resolveConfig,
} from "../plugins/sdlc/scripts/sdlc-kit.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "sdlc-kit-"));
}

const noGit = () => null;

test("frontMatter reads key: value pairs and tolerates a missing block", () => {
  assert.deepEqual(frontMatter("---\nstatus: accepted\nticket: APP-1\n---\n# x"), { status: "accepted", ticket: "APP-1" });
  assert.deepEqual(frontMatter("# no front matter"), {});
  assert.equal(frontMatter(null), null);
});

test("countSteps skips fenced blocks and HTML comments", () => {
  const plan = [
    "<!-- - [ ] 1. template example",
    "     - [ ] 2. still a comment -->",
    "- [x] 1. done",
    "- [ ] 2. open <!-- inline --> text",
    "* [X] 3. done too",
    "```",
    "- [ ] not a step",
    "```",
  ].join("\n");
  assert.deepEqual(countSteps(plan), { done: 2, total: 3 });
  assert.equal(countSteps(null), null);
});

test("readKit: missing, invalid and valid kit.json", () => {
  const dir = scratch();
  try {
    assert.deepEqual(readKit(dir), { found: false, data: {}, error: null });
    writeFileSync(join(dir, "kit.json"), "{bad");
    assert.match(readKit(dir).error, /does not parse/);
    writeFileSync(join(dir, "kit.json"), "[]");
    assert.match(readKit(dir).error, /not a JSON object/);
    writeFileSync(join(dir, "kit.json"), JSON.stringify({ project: "my-app" }));
    assert.deepEqual(readKit(dir).data, { project: "my-app" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig merges path defaults and leaves absent commands null", () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, "work/items"), { recursive: true });
    mkdirSync(join(dir, "docs/recipes"), { recursive: true });
    writeFileSync(join(dir, "docs/recipes/index.md"), "# Recipes\n");
    const kit = { found: true, error: null, data: { project: "my-app", itemPrefix: "APP", baseBranch: "dev", paths: { sdlc: "work/items" }, commands: { test: "npm test" } } };
    const c = resolveConfig(dir, kit, noGit);
    assert.equal(c.paths.sdlc, "work/items");
    assert.equal(c.paths.glossary, DEFAULT_PATHS.glossary);
    assert.equal(c.exists.sdlc, true);
    assert.equal(c.exists.glossary, false);
    assert.equal(c.recipeIndex, "docs/recipes/index.md");
    assert.equal(c.commands.test, "npm test");
    assert.equal(c.commands.check, null);
    assert.deepEqual(c.baseBranch, { name: "dev", source: "kit.json" });
    assert.equal(c.itemPrefix, "APP");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveBase falls back to origin/HEAD, then a local main", () => {
  const originHead = (_root, args) => (args[0] === "symbolic-ref" ? "origin/trunk\n" : null);
  assert.deepEqual(resolveBase("/x", {}, originHead), { name: "trunk", source: "origin/HEAD" });
  const localMain = (_root, args) => (args.includes("refs/heads/main") ? "abc\n" : null);
  assert.deepEqual(resolveBase("/x", {}, localMain), { name: "main", source: "local branch" });
  assert.deepEqual(resolveBase("/x", {}, noGit), { name: null, source: "unknown" });
});

test("listItems reports committed and working state per item", () => {
  const dir = scratch();
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    mkdirSync(join(dir, "docs/sdlc/demo"), { recursive: true });
    mkdirSync(join(dir, "docs/sdlc/archive/2026-01-01-old"), { recursive: true });
    writeFileSync(join(dir, "docs/sdlc/demo/intent.md"), "---\nstatus: accepted\nticket: APP-7\nbranch: feat/demo-APP-7\n---\n");
    writeFileSync(join(dir, "docs/sdlc/demo/plan.md"), "---\nstatus: approved\n---\n- [x] 1. a\n- [ ] 2. b\n");
    git("add", "docs");
    git("commit", "-qm", "items");
    writeFileSync(join(dir, "docs/sdlc/demo/plan.md"), "---\nstatus: approved\n---\n- [x] 1. a\n- [x] 2. b\n");
    mkdirSync(join(dir, "docs/sdlc/draft-only"));
    writeFileSync(join(dir, "docs/sdlc/draft-only/intent.md"), "---\nstatus: draft\n---\n");

    const r = listItems(dir, "docs/sdlc");
    assert.deepEqual(r.archived, ["2026-01-01-old"]);
    const demo = r.active.find((i) => i.slug === "demo");
    assert.equal(demo.ticket, "APP-7");
    assert.equal(demo.docs["intent.md"].dirty, false);
    assert.deepEqual(demo.docs["plan.md"].committedSteps, { done: 1, total: 2 });
    assert.deepEqual(demo.docs["plan.md"].workingSteps, { done: 2, total: 2 });
    assert.equal(demo.docs["plan.md"].dirty, true);
    const draft = r.active.find((i) => i.slug === "draft-only");
    assert.equal(draft.docs["intent.md"].committed, null);
    assert.equal(draft.docs["intent.md"].working, "draft");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("show prints every bundled document and rejects an unknown one", () => {
  for (const name of Object.keys(BUNDLED)) {
    const lines = [];
    assert.equal(main(["show", name], { root: "/nowhere", out: (l) => lines.push(l) }), 0, name);
    assert.match(lines[0], /^(#|---)/, name);
  }
  assert.equal(show("nope"), null);
  assert.equal(main(["show"], { root: "/nowhere", out: () => {} }), 2);
});

test("templates keep their sections and the item-label conventions", () => {
  const headings = (text) => text.split("\n").filter((l) => l.startsWith("## "));
  const intent = show("intent-template");
  assert.deepEqual(headings(intent), [
    "## What to implement",
    "## Expected outcome",
    "## Scope",
    "## Constraints",
    "## Important cases and open questions",
    "## References",
  ]);
  assert.match(intent, /O1\., O2\./);
  assert.match(intent, /Plain numbers/);
  assert.match(intent, /C1\., C2\./);
  assert.match(intent, /Q1\., Q2\./);
  assert.match(intent, /\(resolved YYYY-MM-DD\)/);
  const plan = show("plan-template");
  assert.deepEqual(headings(plan), ["## Design notes", "## Files that change", "## Order of work", "## Proof", "## Deviations"]);
  assert.match(plan, /interleaving table/);
  assert.match(plan, /case × entry point/);
  const workflow = show("workflow");
  assert.match(workflow, /\(resolved YYYY-MM-DD\)/);
  assert.match(workflow, /Stages start on the user's word/);
  assert.match(show("verification"), /`defect`.*`nit`/s);
});

const SKILLS = new URL("../plugins/sdlc/skills/", import.meta.url);
const STAGES = [
  ["sdlc-intent", "Start intent", "Start plan"],
  ["sdlc-plan", "Start plan", "Start build"],
  ["sdlc-build", "Start build", "Start finish"],
  ["sdlc-finish", "Start finish", null],
];

test("stage skills are model-invocable behind the user's go-ahead and offer the next stage", () => {
  for (const [name, own, next] of STAGES) {
    const text = readFileSync(new URL(`${name}/SKILL.md`, SKILLS), "utf8");
    const head = text.split("\n---\n")[0];
    assert.doesNotMatch(head, /disable-model-invocation/, name);
    assert.match(head, /Load only when the user's\s+latest message/, name);
    assert.match(head, /never from\s+a\s+brief, a relayed message or your own plan/, name);
    assert.match(text, /\*\*Start only on the user's go-ahead in this conversation\.\*\*/, name);
    assert.ok(text.includes(`(\`${own}\`)`), `${name} names its own button`);
    if (next) assert.ok(text.includes(`\`${next}\` first`), `${name} offers ${next}`);
  }
});

test("intent and plan accept and commit on one answer", () => {
  for (const name of ["sdlc-intent", "sdlc-plan"]) {
    const text = readFileSync(new URL(`${name}/SKILL.md`, SKILLS), "utf8");
    assert.match(text, /Accepting is committing/, name);
    assert.match(text, /without asking again/, name);
    assert.match(text, /`Accept` and\s+`Change something`/, name);
  }
  const workflow = show("workflow");
  assert.match(workflow, /One answer accepts and commits/);
  assert.match(workflow, /One question per decision/);
  assert.match(workflow, /delivers a button click as the user's next\s+message/);
  assert.doesNotMatch(workflow, /disable-model-invocation/);
});

test("main prints config by default and rejects an unknown command", () => {
  const dir = scratch();
  try {
    const lines = [];
    assert.equal(main([], { root: dir, out: (l) => lines.push(l) }), 0);
    assert.match(lines[0], /kit\.json: missing/);
    assert.equal(main(["nope"], { root: dir, out: () => {} }), 2);
    const json = [];
    main(["config", "--json"], { root: dir, out: (l) => json.push(l) });
    assert.equal(JSON.parse(json[0]).paths.sdlc, "docs/sdlc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
