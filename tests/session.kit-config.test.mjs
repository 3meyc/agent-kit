import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "./session/vitest-compat.mjs";
import {
  KIT_DEFAULTS,
  checkoutRoot,
  hookOff,
  inLedger,
  ledgerDir,
  ledgerHookOn,
  readKit,
  rootFor,
} from "../plugins/session/scripts/kit-config.mjs";

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
