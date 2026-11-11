import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "./session/vitest-compat.mjs";
import {
  KIT_COMMANDS,
  KIT_DEFAULTS,
  checkSuites,
  checkoutRoot,
  hookOff,
  inLedger,
  kitCommand,
  ledgerDir,
  ledgerHookOn,
  lintOnEdit,
  normalizeKit,
  preflightSteps,
  readKit,
  rootFor,
} from "../shared/kit-config.mjs";

// The shared kit.json reader every plugin vendors into its lib/.
const schema = JSON.parse(readFileSync(new URL("../schema/kit.schema.json", import.meta.url), "utf8"));

let dir;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-config-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (kit) => writeFileSync(join(dir, "kit.json"), typeof kit === "string" ? kit : JSON.stringify(kit));

describe("readKit", () => {
  it("gives the schema defaults without a kit.json, ledger off", () => {
    const kit = readKit(dir);
    expect(kit.found).toBe(false);
    expect(kit.error).toBeNull();
    expect(kit.ledger).toBe(false);
    expect(kit.baseBranch).toBe("main");
    expect(kit.paths).toEqual({ ...KIT_DEFAULTS.paths });
    expect(kit.hooks.off).toEqual([]);
  });

  it("merges a project's values over the defaults", () => {
    write({
      project: "my-app",
      baseBranch: "develop",
      itemPrefix: "APP",
      ledger: true,
      paths: { ledger: "notes/ledger/", sdlc: "work" },
      commands: { commitAudit: "npx audit", test: "" },
      hooks: { off: ["ledger-brief", 7] },
      devServer: { port: 5173 },
    });
    const kit = readKit(dir);
    expect(kit.found).toBe(true);
    expect(kit.baseBranch).toBe("develop");
    expect(kit.itemPrefix).toBe("APP");
    expect(kit.paths.ledger).toBe("notes/ledger");
    expect(kit.paths.sdlc).toBe("work");
    expect(kit.paths.docs).toBe("docs");
    expect(kit.commands).toEqual({ commitAudit: "npx audit" });
    expect(kit.hooks.off).toEqual(["ledger-brief"]);
    expect(kit.devServer).toEqual({ port: 5173 });
  });

  it("refuses a path that leaves the repository, keeping the default", () => {
    write({ project: "x", paths: { ledger: "../elsewhere" } });
    expect(readKit(dir).paths.ledger).toBe(".claude/ledger");
    write({ project: "x", paths: { ledger: "/abs" } });
    expect(readKit(dir).paths.ledger).toBe(".claude/ledger");
  });

  it("reports a broken file and falls back to the defaults, never throwing", () => {
    write("{ not json");
    const kit = readKit(dir);
    expect(kit.found).toBe(false);
    expect(kit.error).toMatch(/^kit\.json: /);
    write("[1, 2]");
    expect(readKit(dir).error).toBe("kit.json: not a JSON object");
  });
});

describe("hookOff and ledgerHookOn", () => {
  it("switches a hook off by id, and ledger hooks need the ledger on", () => {
    write({ project: "x", ledger: true, hooks: { off: ["ledger-stop"] } });
    const kit = readKit(dir);
    expect(hookOff("ledger-stop", kit)).toBe(true);
    expect(hookOff("ledger-brief", kit)).toBe(false);
    expect(ledgerHookOn("ledger-stop", kit)).toBe(false);
    expect(ledgerHookOn("ledger-brief", kit)).toBe(true);
    write({ project: "x" });
    expect(ledgerHookOn("ledger-brief", readKit(dir))).toBe(false);
  });
});

describe("ledgerAutoClose", () => {
  it("defaults questionDays to the schema's value and keeps a valid one", () => {
    write({ project: "x" });
    expect(readKit(dir).ledgerAutoClose).toEqual({ questionDays: schema.properties.ledgerAutoClose.properties.questionDays.default });
    write({ project: "x", ledgerAutoClose: { questionDays: 3 } });
    expect(readKit(dir).ledgerAutoClose.questionDays).toBe(3);
  });

  it("falls back to the default on a value below 1 or not a whole number", () => {
    for (const questionDays of [0, -2, 1.5, "7"]) {
      write({ project: "x", ledgerAutoClose: { questionDays } });
      expect(readKit(dir).ledgerAutoClose.questionDays).toBe(KIT_DEFAULTS.ledgerAutoClose.questionDays);
    }
  });
});

describe("ledger paths", () => {
  it("joins the ledger folder to the root and matches paths inside it", () => {
    const kit = { paths: { ledger: "notes/ledger" } };
    expect(ledgerDir("/r", kit)).toBe(join("/r", "notes", "ledger"));
    expect(inLedger("notes/ledger/2026-10-01-a.md", kit)).toBe(true);
    expect(inLedger("notes/ledger", kit)).toBe(true);
    expect(inLedger("notes/ledger-old/a.md", kit)).toBe(false);
  });
});

describe("checkoutRoot and rootFor", () => {
  it("finds the git top level from a subfolder, and nothing outside git", () => {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    expect(checkoutRoot(join(dir, "src", "deep"))).toBe(dir);
    expect(rootFor(join(dir, "src"))).toBe(dir);
    expect(checkoutRoot(join(dir, "missing"))).toBeNull();
    expect(checkoutRoot(undefined)).toBeNull();
  });
});

describe("schema agreement", () => {
  it("knows every command and path the schema defines, with the same defaults", () => {
    expect([...KIT_COMMANDS].sort()).toEqual(Object.keys(schema.properties.commands.properties).sort());
    const pathDefaults = Object.fromEntries(
      Object.entries(schema.properties.paths.properties).map(([key, value]) => [key, value.default]),
    );
    expect({ ...KIT_DEFAULTS.paths }).toEqual(pathDefaults);
    expect(KIT_DEFAULTS.baseBranch).toBe(schema.properties.baseBranch.default);
  });

  it("keeps check suite names apart from every command name and `all`", () => {
    expect([...schema.properties.checks.propertyNames.not.enum].sort()).toEqual([...KIT_COMMANDS, "all"].sort());
  });
});

describe("lintOnEdit, kitCommand and raw", () => {
  it("reads lintOnEdit as a list of rules with a command, and keeps string globs", () => {
    expect(lintOnEdit({ lintOnEdit: { match: ["*.ts"] } })).toEqual([]);
    expect(lintOnEdit({})).toEqual([]);
    expect(lintOnEdit({ lintOnEdit: { command: "eslint", match: ["*.ts", 3] } })).toEqual([{ command: "eslint", match: ["*.ts"] }]);
    expect(normalizeKit({ lintOnEdit: { command: "eslint" } }).lintOnEdit).toEqual([{ command: "eslint", match: [] }]);
    // Idempotent: a read kit gives the same answer as the raw one.
    expect(lintOnEdit(normalizeKit({ lintOnEdit: { command: "eslint" } }))).toEqual([{ command: "eslint", match: [] }]);
  });

  it("reads a list of lintOnEdit rules in order, dropping the ones without a command", () => {
    const rules = lintOnEdit({
      lintOnEdit: [{ command: "eslint {file}", match: ["*.ts"] }, { match: ["*.json"] }, { command: "pnpm run i18n:check", match: ["locales/*.json"] }],
    });
    expect(rules).toEqual([
      { command: "eslint {file}", match: ["*.ts"] },
      { command: "pnpm run i18n:check", match: ["locales/*.json"] },
    ]);
  });

  it("reads check suites, dropping empty ones and non-string commands", () => {
    expect(checkSuites({ checks: { i18n: ["a", "b"], docs: [], bad: "x", mixed: ["c", 3, ""] } })).toEqual({ i18n: ["a", "b"], mixed: ["c"] });
    expect(normalizeKit({}).checks).toEqual({});
  });

  it("reads preflight steps with their defaults", () => {
    expect(
      preflightSteps({
        preflight: { docs: { description: "Docs review", match: ["docs/**"] }, audit: { description: "Audit", command: "npm run audit", remindAfter: 3 }, bad: { command: "x" } },
      }),
    ).toEqual({
      docs: { description: "Docs review", command: null, match: ["docs/**"], remindAfter: 1 },
      audit: { description: "Audit", command: "npm run audit", match: [], remindAfter: 3 },
    });
  });

  it("gives a command only when it is a non-empty string", () => {
    const kit = normalizeKit({ commands: { dev: "npm run dev", install: " " } });
    expect(kitCommand(kit, "dev")).toBe("npm run dev");
    expect(kitCommand(kit, "install")).toBeNull();
    expect(kitCommand(null, "dev")).toBeNull();
  });

  it("keeps the parsed file, so a caller can tell a set value from a default", () => {
    expect(normalizeKit({ project: "x" }).raw).toEqual({ project: "x" });
    expect(normalizeKit({ project: "x" }).baseBranch).toBe("main");
    expect(normalizeKit(null).raw).toBeNull();
  });

  it("takes a raw kit in hookOff and ledgerHookOn too", () => {
    expect(hookOff("rules", { hooks: { off: ["rules"] } })).toBe(true);
    expect(hookOff("rules", null)).toBe(false);
    expect(ledgerHookOn("ledger-stop", { ledger: true })).toBe(true);
    expect(ledgerHookOn("ledger-stop", undefined)).toBe(false);
  });
});
