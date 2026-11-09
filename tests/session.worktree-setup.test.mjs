import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "./session/vitest-compat.mjs";
import {
  doneLine,
  installCommandFor,
  packageManagerFor,
  PACKAGE_MANAGERS,
  planSetup,
  readFacts,
  rtkFilterState,
} from "../plugins/session/scripts/worktree-setup.mjs";

const fresh = {
  linked: true,
  hasNodeModules: false,
  lockfileNewer: false,
  mainHasCodegraph: true,
  hasCodegraph: false,
  codegraphOnPath: true,
};

describe("planSetup", () => {
  it("installs and indexes a fresh worktree", () => {
    expect(planSetup(fresh)).toEqual(["install", "codegraph"]);
  });

  it("does nothing for a worktree already set up", () => {
    expect(planSetup({ ...fresh, hasNodeModules: true, hasCodegraph: true })).toEqual([]);
  });

  it("reinstalls when the lockfile is newer than the installed modules", () => {
    expect(planSetup({ ...fresh, hasNodeModules: true, lockfileNewer: true, hasCodegraph: true })).toEqual(["install"]);
  });

  it("skips the index with a hint when codegraph is not installed, and when the main checkout has none", () => {
    expect(planSetup({ ...fresh, codegraphOnPath: false })).toEqual(["install", "codegraph-hint"]);
    expect(planSetup({ ...fresh, mainHasCodegraph: false })).toEqual(["install"]);
  });

  it("notes that the main checkout is not a worktree, and still installs", () => {
    expect(planSetup({ ...fresh, linked: false, hasCodegraph: true })).toEqual(["not-linked", "install"]);
  });

  it("trusts approved RTK filters and only hints at ones the user has not reviewed", () => {
    const setUp = { ...fresh, hasNodeModules: true, hasCodegraph: true };
    expect(planSetup({ ...setUp, rtkFilters: "approved" })).toEqual(["rtk-trust"]);
    expect(planSetup({ ...setUp, rtkFilters: "review" })).toEqual(["rtk-trust-hint"]);
    expect(planSetup({ ...setUp, rtkFilters: "trusted" })).toEqual([]);
  });
});

describe("rtkFilterState", () => {
  const sha = "a".repeat(64);
  const other = "b".repeat(64);
  const listing = (path, hash) =>
    `Trusted filters:\n═════\n  ${path} (trusted 2026-10-26)\n    sha256:${hash}\n`;
  const base = { filePath: "/wt/.rtk/filters.toml", fileSha: sha, globalFiltersQuiet: true };

  it("is trusted when this path holds these bytes", () => {
    expect(rtkFilterState({ ...base, trustList: listing("/wt/.rtk/filters.toml", sha) })).toBe("trusted");
  });

  it("is approved when the same bytes are trusted at another path, e.g. the main checkout", () => {
    expect(rtkFilterState({ ...base, trustList: listing("/repo/.rtk/filters.toml", sha) })).toBe("approved");
  });

  it("needs review for new content, or while an unreviewed user-global filter file would be swept in", () => {
    expect(rtkFilterState({ ...base, trustList: listing("/repo/.rtk/filters.toml", other) })).toBe("review");
    expect(rtkFilterState({ ...base, trustList: "No trusted filters.\n" })).toBe("review");
    expect(
      rtkFilterState({ ...base, globalFiltersQuiet: false, trustList: listing("/repo/.rtk/filters.toml", sha) }),
    ).toBe("review");
  });

  it("is none without a filter file", () => {
    expect(rtkFilterState({ ...base, fileSha: null, trustList: "" })).toBe("none");
  });
});

describe("readFacts", () => {
  it("returns null outside a git repository, so the SessionStart hook stays silent", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktree-setup-"));
    try {
      expect(readFacts(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("install step and kit.json", () => {
  const fresh = {
    linked: true,
    hasNodeModules: false,
    lockfileNewer: false,
    mainHasCodegraph: false,
    hasCodegraph: false,
    codegraphOnPath: false,
  };

  it("installs nothing without a known lockfile, and only hints when the package manager is missing", () => {
    expect(planSetup({ ...fresh, hasLockfile: false })).toEqual([]);
    expect(planSetup({ ...fresh, hasLockfile: true, packageManagerOnPath: false })).toEqual(["install-hint"]);
    expect(planSetup({ ...fresh, hasLockfile: true, packageManagerOnPath: true })).toEqual(["install"]);
  });

  it("picks the package manager by lockfile, pnpm first", () => {
    const has = (...names) => (path) => names.some((name) => path.endsWith(name));
    expect(packageManagerFor("/r", has("pnpm-lock.yaml", "package-lock.json"))?.name).toBe("pnpm");
    expect(packageManagerFor("/r", has("package-lock.json"))?.name).toBe("npm");
    expect(packageManagerFor("/r", has("Cargo.lock"))).toBeNull();
  });

  it("runs kit.json commands.install through the shell in place of the guessed package manager", () => {
    const [pnpm] = PACKAGE_MANAGERS;
    expect(installCommandFor(pnpm, { commands: { install: "make deps" } })).toEqual({ command: "make deps", args: [], shell: true });
    expect(installCommandFor(pnpm, { commands: {} })).toEqual({ command: "pnpm", args: pnpm.args, shell: false });
    expect(installCommandFor(null, { commands: {} })).toBeNull();
  });

  it("names the dev server port only when kit.json sets one", () => {
    expect(doneLine({ devServer: { port: 5173 } })).toContain("port 5173");
    expect(doneLine({ devServer: null })).toBe("worktree-setup: done.");
  });
});
