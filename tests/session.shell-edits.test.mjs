import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "./session/vitest-compat.mjs";
import { projectRoot } from "../shared/hook-utils.mjs";
import { createShellEditTracker } from "../plugins/session/scripts/ledger-utils.mjs";

const REPO_ROOT = projectRoot();
import { globToRegExp, shellWriteTargets, stripHeredocs, tokenizeShell } from "../shared/shell-edits.mjs";

const cwd = resolve("/repo");
const abs = (...parts) => resolve(cwd, ...parts);

function targets(command, options = {}) {
  const result = shellWriteTargets(command, { cwd, ...options });
  return { files: result.files.sort(), globs: result.globs.sort(), opaque: result.opaque };
}

describe("globToRegExp", () => {
  it("keeps an unmatched brace literal instead of building a broken expression", () => {
    expect(() => globToRegExp("docs/a{b")).not.toThrow();
    expect(globToRegExp("docs/a{b").test("docs/a{b")).toBe(true);
    expect(globToRegExp("src/{a,b}.ts").test("src/b.ts")).toBe(true);
  });
});

describe("stripHeredocs", () => {
  it("cuts the body but keeps the operator line", () => {
    const command = "cat > a.md <<'EOF'\n> not a redirect\nx => y\nEOF\necho done > b.txt";
    expect(stripHeredocs(command)).toBe("cat > a.md <<'EOF'\n\necho done > b.txt");
  });

  it("leaves here-strings alone", () => {
    expect(stripHeredocs("cat <<< 'abc' > out.txt")).toBe("cat <<< 'abc' > out.txt");
  });
});

describe("tokenizeShell", () => {
  it("separates words, operators and redirects", () => {
    expect(tokenizeShell("echo 'a b' >> f 2>&1 && ls | wc")).toEqual([
      { word: "echo", quoted: false },
      { word: "a b", quoted: true },
      { op: ">>" },
      { word: "f", quoted: false },
      { op: "dup" },
      { op: "&&" },
      { word: "ls", quoted: false },
      { op: "|" },
      { word: "wc", quoted: false },
    ]);
  });

  it("keeps backslashes literal in PowerShell mode", () => {
    expect(tokenizeShell("Set-Content C:\\x\\y.txt", { powershell: true })).toEqual([
      { word: "Set-Content", quoted: false },
      { word: "C:\\x\\y.txt", quoted: false },
    ]);
  });
});

describe("shellWriteTargets", () => {
  it("names redirect targets and ignores descriptors and devices", () => {
    expect(targets("echo hi > a.txt 2>&1; cat x >> b.log > /dev/null")).toEqual({
      files: [abs("a.txt"), abs("b.log")],
      globs: [],
      opaque: false,
    });
  });

  it("does not read a here-doc body as shell", () => {
    expect(targets("cat > docs/a.md <<'EOF'\n> quoted\nconst f = (x) => x > 1\nEOF")).toEqual({
      files: [abs("docs/a.md")],
      globs: [],
      opaque: false,
    });
  });

  it("expands a variable set earlier in the command when it follows cd", () => {
    // The verifier sub-agent's shape: its clone is outside the repo, so nothing here is claimed.
    expect(targets("S=/tmp/scratch; cd $S/clone && echo b >> README.md").files).toEqual([
      "/tmp/scratch/clone/README.md",
    ]);
    expect(targets('export H=/tmp/h LEDGER_NO_SUMMARY=1; cd "${H}" && pnpm install').files).toEqual([
      "/tmp/h/package.json",
      "/tmp/h/pnpm-lock.yaml",
    ]);
  });

  it("attributes no relative path after a cd it cannot resolve", () => {
    expect(targets('cd "$UNKNOWN/clone" && echo b >> README.md && pnpm install').files).toEqual([]);
    expect(targets("cd $(mktemp -d) && echo x > a.txt; echo y > /tmp/abs.txt").files).toEqual(["/tmp/abs.txt"]);
  });

  it("reads macOS sed -i '' as the in-place flag with an empty backup suffix", () => {
    // The script is the operand after '', not a path; it used to become a glob and crash the ledger.
    expect(targets("sed -i '' 's/a(b/{c/' x.ts").files).toEqual([abs("x.ts")]);
    expect(targets("sed -i '' 's/a(b/{c/' x.ts").globs).toEqual([]);
  });

  it("names every file of perl and sed in-place edits through variables set in the same command", () => {
    // The c9c38f4d shape: the second file went uncredited, and the commit was refused with exit 4.
    const perl = `f=a.ts && perl -0pi -e 's/x\\n/y/' $f && grep -n y $f; f2=b.json && perl -0pi -e 's/a/b/' $f2`;
    expect(targets(perl)).toEqual({ files: [abs("a.ts"), abs("b.json")], globs: [], opaque: false });
    const sed = `f=a.ts && sed -i '' 's/x/y/' "$f"; f2=b.json && sed -i 's/a/b/' "\${f2}"`;
    expect(targets(sed)).toEqual({ files: [abs("a.ts"), abs("b.json")], globs: [], opaque: false });
    expect(targets("f=a.ts; f=b.ts; perl -pi -e 's/a/b/' $f").files).toEqual([abs("b.ts")]);
    expect(targets("f=a.ts && perl -pi -e 's/a/b/' $g")).toEqual({ files: [], globs: [], opaque: true });
  });

  it("reads perl's bundled switches for the in-place flag and the script operand", () => {
    expect(targets("perl -i.bak -pe 's/a/b/' x.ts y.ts").files).toEqual([abs("x.ts"), abs("y.ts")]);
    expect(targets("perl -0777 -i -p -e 's/a/b/' -e 's/c/d/' x.ts").files).toEqual([abs("x.ts")]);
    expect(targets("perl -pi fix.pl x.ts").files).toEqual([abs("x.ts")]);
    // `-pie` is -p and -i with the backup suffix "e", so the script is the next operand, not -e's.
    expect(targets("perl -pie 's/a/b/' x.ts").files).toEqual([abs("x.ts")]);
    // `-0` takes octal digits only, so the `e` here is -e; switches go on after its code.
    expect(targets("perl -0e 's/a/b/' -i x.ts").files).toEqual([abs("x.ts")]);
    expect(targets("perl -ne 'print if /a/' x.ts").files).toEqual([]);
    expect(targets("perl -Ilib -MFoo -pi -e 's/a/b/' x.ts").files).toEqual([abs("x.ts")]);
  });

  it("follows a leading cd for relative operands", () => {
    expect(targets("cd src && sed -i 's/a/b/' x.ts y.ts").files).toEqual([abs("src/x.ts"), abs("src/y.ts")]);
    expect(targets("sed -n '1p' x.ts").files).toEqual([]);
  });

  it("maps dependency changes to the manifest and lockfile, tasks to opaque", () => {
    expect(targets("pnpm add -D vitest")).toEqual({
      files: [abs("package.json"), abs("pnpm-lock.yaml")],
      globs: [],
      opaque: false,
    });
    expect(targets("pnpm run format").opaque).toBe(true);
    expect(targets("pnpm ls && pnpm --version").opaque).toBe(false);
    expect(targets("npm i lodash").files).toEqual([abs("package-lock.json"), abs("package.json")]);
  });

  it("splits formatter operands into files and globs", () => {
    expect(targets('npx prettier --write "src/**/*.ts" docs/a.md')).toEqual({
      files: [abs("docs/a.md")],
      globs: [abs("src/**/*.ts")],
      opaque: false,
    });
    expect(targets("prettier --check docs/a.md").files).toEqual([]);
    expect(targets("eslint --fix").files).toEqual([abs(".")]);
  });

  it("splits an unquoted path-list variable into its files, as sh does", () => {
    const listed = 'F="src/a.ts lib/b.svelte" && npx prettier --write $F && pnpm exec eslint $F';
    expect(targets(listed)).toEqual({ files: [abs("lib/b.svelte"), abs("src/a.ts")], globs: [], opaque: false });
    expect(targets('F="a.ts b.ts"; pnpm exec prettier --write ${F}').files).toEqual([abs("a.ts"), abs("b.ts")]);
    // Quoted, the variable stays one word: one path with a space in its name.
    expect(targets('F="a.ts b.ts"; prettier --write "$F"').files).toEqual([abs("a.ts b.ts")]);
    expect(targets('F="a.ts b.ts"; prettier --check $F').files).toEqual([]);
    expect(targets("prettier --write $UNSET")).toEqual({ files: [], globs: [], opaque: true });
  });

  it("reads mv, cp, rm and git mv", () => {
    expect(targets("mv a.txt lib/").files).toEqual([abs("a.txt"), abs("lib"), abs("lib/a.txt")]);
    expect(targets("rm -rf tmp/*.log build").files).toEqual([abs("build")]);
    expect(targets("rm -rf tmp/*.log build").globs).toEqual([abs("tmp/*.log")]);
    expect(targets("git mv old.ts new.ts").files).toContain(abs("old.ts"));
    expect(targets("git mv old.ts new.ts").files).toContain(abs("new.ts"));
  });

  it("marks scripts, interpreters and tree-changing git as opaque", () => {
    expect(targets("node scripts/sync-agent-config.mjs").opaque).toBe(true);
    expect(targets("./tool.sh --all").opaque).toBe(true);
    expect(targets("git stash pop").opaque).toBe(true);
    expect(targets("rtk git status && git diff --stat").opaque).toBe(false);
    expect(targets("rtk proxy pnpm run -s i18n:check").opaque).toBe(true);
    expect(targets("rtk proxy git status").opaque).toBe(false);
    expect(targets("cat a | grep b").opaque).toBe(false);
  });

  it("reports git merge, pull, rebase and cherry-pick as integrating, not opaque", () => {
    const integration = (command) => {
      const { opaque, integrates } = shellWriteTargets(command, { cwd });
      return { opaque, integrates };
    };
    for (const command of [
      "git merge dev",
      "git -C ../other pull --ff-only",
      "git fetch && git rebase origin/dev",
      "git cherry-pick abc123",
      "git merge --continue",
    ]) {
      expect(integration(command)).toEqual({ opaque: false, integrates: true });
    }
    expect(integration("git merge dev && node scripts/gen.mjs")).toEqual({ opaque: true, integrates: true });
    // The session commits a squash or `cherry-pick -n` itself; autostash and --exec write beyond the merge.
    for (const command of [
      "git merge --squash dev",
      "git pull --rebase --autostash",
      "git rebase -x 'pnpm test' dev",
      "git rebase --exec=true dev",
      "git cherry-pick -n abc123",
      "git cherry-pick -nx abc123",
      "git -c rebase.autoStash=true pull --rebase",
    ]) {
      expect(integration(command)).toEqual({ opaque: true, integrates: false });
    }
    expect(integration("git cherry-pick -Sname abc123")).toEqual({ opaque: false, integrates: true });
    expect(integration("git status")).toEqual({ opaque: false, integrates: false });
  });

  it("finds literal paths in inline node and python scripts", () => {
    const node = `node -e "const fs=require('fs'); fs.writeFileSync('CLAUDE.md', fs.readFileSync('CLAUDE.md','utf8'))"`;
    expect(targets(node).files).toEqual([abs("CLAUDE.md")]);
    const stdin = "node - <<'JS'\nimport fs from 'fs'; fs.renameSync(`a.md`, `b.md`);\nJS";
    expect(targets(stdin).files).toEqual([abs("a.md"), abs("b.md")]);
    expect(targets(`python -c "open('r.txt','w').write('x')"`).files).toEqual([abs("r.txt")]);
    expect(targets(`node -e "fs.writeFileSync(path.join(root, 'x'), '')"`).files).toEqual([]);
  });

  it("follows a literal path through a name the inline script assigned", () => {
    const python = "python3 - <<'EOF'\np='scripts/mock.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF";
    expect(targets(python).files).toEqual([abs("scripts/mock.ts")]);
    const twice = "python3 - <<'EOF'\np='a.ts'\nopen(p,'w').write('x')\np='b.ts'\nopen(p,'w').write('y')\nEOF";
    expect(targets(twice).files).toEqual([abs("a.ts"), abs("b.ts")]);
    const readThenWrite =
      "python3 - <<'EOF'\np='README.md'\ntext=open(p).read()\np='out.txt'\nopen(p,'w').write(text)\nEOF";
    expect(targets(readThenWrite).files).toEqual([abs("out.txt")]);
    const computed = "python3 - <<'EOF'\np='a.txt'\np=os.path.join(root, 'b.txt')\nopen(p,'w').write('x')\nEOF";
    expect(targets(computed).files).toEqual([]);
    const loop =
      "python3 - <<'EOF'\np='README.md'\nprint(open(p).read())\nfor p in outputs:\n    open(p,'w').write('x')\nEOF";
    expect(targets(loop).files).toEqual([]);
    const withAs = "python3 - <<'EOF'\np='README.md'\nwith make() as p:\n    open(p,'w')\nEOF";
    expect(targets(withAs).files).toEqual([]);
    const node = `node -e "const out = 'docs/x.md'; fs.writeFileSync(out, 'y')"`;
    expect(targets(node).files).toEqual([abs("docs/x.md")]);
    // Read only, or a name never given a literal: nothing is named.
    expect(targets("python3 -c \"p='a.txt'; print(open(p).read())\"").files).toEqual([]);
    expect(targets(`node -e "fs.writeFileSync(target, 'y')"`).files).toEqual([]);
  });

  it("skips unresolvable operands and runs their command by its window instead", () => {
    expect(targets('echo x > "$OUT" && tee ${LOG} < a && curl -o https://x.test/a.zip')).toEqual({
      files: [],
      globs: [],
      opaque: true,
    });
    expect(targets("echo x > %TEMP%\\a.txt").files).toEqual([]);
    expect(targets("curl -o https://x.test/a.zip && echo x > /dev/null").opaque).toBe(false);
  });

  it("marks a write over loop variables, substitutions and xargs input as opaque", () => {
    // The 1bf8a621 shape: this loop rewrote five files after the scripts that first edited them.
    const loop = `F=$(git grep -l -- "--reviewed"); for f in $F; do sed -i '' 's/--reviewed/--review/g' "$f"; done`;
    expect(targets(loop).opaque).toBe(true);
    expect(targets("sed -i '' 's/a/b/' $(git grep -l a)").opaque).toBe(true);
    expect(targets("git grep -l a | xargs sed -i '' 's/a/b/'").opaque).toBe(true);
    expect(targets("git grep -l a | xargs -I{} sed -i '' 's/a/b/' {}").opaque).toBe(true);
    expect(targets("git grep -l a | xargs grep -n b").opaque).toBe(false);
    expect(targets('for f in $(ls); do echo "$f"; done').opaque).toBe(false);
    // The literal prefix already puts the write outside the checkout.
    expect(targets('git show "HEAD:$f" > "/tmp/head-$(basename $f)"').opaque).toBe(false);
    expect(targets(`echo x > "${cwd}/docs/$NAME.md"`).opaque).toBe(true);
    expect(targets("if true; then rm -f build.log; fi").files).toEqual([abs("build.log")]);
  });

  it("expands a variable set earlier in the command in write targets", () => {
    expect(targets("S=/tmp/s; cat > $S/x.mjs <<'EOF'\nwrite()\nEOF")).toEqual({
      files: ["/tmp/s/x.mjs"],
      globs: [],
      opaque: false,
    });
    expect(targets("Get-Content a | Out-File b.txt 2>$null", { powershell: true }).opaque).toBe(false);
  });

  it("reports what rm, git rm, mv and inline scripts remove", () => {
    const removed = (command) => shellWriteTargets(command, { cwd }).removed.sort();
    expect(removed("git rm -r -q -f .cursor docs/process scripts/old.mjs")).toEqual([
      abs(".cursor"),
      abs("docs/process"),
      abs("scripts/old.mjs"),
    ]);
    expect(targets("git rm -r -q -f .cursor").files).toEqual([abs(".cursor")]);
    expect(removed("rm -rf tmp/*.log build")).toEqual([abs("build"), abs("tmp/*.log")]);
    expect(removed("mv a.txt lib/ && git mv old.ts new.ts")).toEqual([abs("a.txt"), abs("old.ts")]);
    expect(removed(`node -e "require('fs').rmSync('dist', { recursive: true })"`)).toEqual([abs("dist")]);
    expect(shellWriteTargets("Remove-Item a.txt -Recurse", { cwd, powershell: true }).removed).toEqual([abs("a.txt")]);
    expect(removed("sed -i 's/a/b/' x.ts && echo y > z.txt")).toEqual([]);
  });

  it("reads PowerShell cmdlets and redirects", () => {
    const command = "Set-Content -Path a.txt -Value 'x'; Get-Content b | Out-File -FilePath c.txt; 'y' > d.txt 2>$null";
    expect(targets(command, { powershell: true }).files).toEqual([abs("a.txt"), abs("c.txt"), abs("d.txt")]);
    expect(targets("Copy-Item x.md docs\\y.md -Force", { powershell: true }).files).toContain(abs("docs/y.md"));
    expect(targets("Remove-Item a.txt,b.txt -Recurse", { powershell: true }).files).toEqual([
      abs("a.txt"),
      abs("b.txt"),
    ]);
  });
});

describe("globToRegExp", () => {
  it("matches segments, depth and alternatives", () => {
    expect(globToRegExp("src/**/*.{ts,svelte}").test("src/a/b.svelte")).toBe(true);
    expect(globToRegExp("src/**/*.{ts,svelte}").test("src/a/b.css")).toBe(false);
    expect(globToRegExp("*.md").test("a/b.md")).toBe(false);
    expect(globToRegExp("docs").test("docs/x/y.md")).toBe(true);
    expect(globToRegExp("a.b").test("aXb")).toBe(false);
  });
});

describe("createShellEditTracker", () => {
  let root;
  const time = (seconds) => new Date(Date.UTC(2026, 8, 18, 10, 0, seconds)).toISOString();
  const touch = (rel, seconds) => {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
    const at = new Date(time(seconds));
    utimesSync(path, at, at);
  };
  /** The tracker maps absolute paths to repo-relative ones against the real REPO_ROOT. */
  const inRepo = (rel) => join(REPO_ROOT, rel);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ledger-shell-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("attributes named paths outright and opaque runs by mtime inside the window", () => {
    const tracker = createShellEditTracker();
    tracker.onToolUse(
      { name: "Bash", id: "t1", input: { command: "echo x > docs/named.md" } },
      { timestamp: time(0), cwd: REPO_ROOT },
    );
    tracker.onToolUse(
      { name: "Bash", id: "t2", input: { command: "node scripts/generate.mjs" } },
      { timestamp: time(10), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t2" }, { timestamp: time(20) });

    touch("docs/named.md", 0);
    touch("src/generated.ts", 15); // written while the script ran
    touch("src/neighbour.ts", 40); // another session, after the window
    touch("src/earlier.ts", 5); // another session, before the window
    const dirty = new Set(["docs/named.md", "src/generated.ts", "src/neighbour.ts", "src/earlier.ts"]);

    const result = tracker.resolve({ dirty, root });
    expect([...result.entries()].sort()).toEqual([
      ["docs/named.md", { at: time(0), via: "shell" }],
      ["src/generated.ts", { at: time(10), via: "mtime" }],
    ]);
  });

  it("moves a named path's time to a later run that wrote it, keeping the firmer label", () => {
    const tracker = createShellEditTracker();
    tracker.onToolUse(
      { name: "Bash", id: "t1", input: { command: "prettier --write docs/named.md" } },
      { timestamp: time(0), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t1" }, { timestamp: time(2) });
    tracker.onToolUse(
      { name: "Bash", id: "t2", input: { command: "node - <<'EOF'\nrewrite()\nEOF" } },
      { timestamp: time(30), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t2" }, { timestamp: time(35) });
    touch("docs/named.md", 32); // the file's last write is the inline script's, not prettier's

    const result = tracker.resolve({ dirty: new Set(["docs/named.md"]), root });
    // A stale time here reads as "committed since the last edit" and drops the path from `--files`.
    expect(result.get("docs/named.md")).toEqual({ at: time(30), via: "shell" });
  });

  it("keeps a quoted path with a space whole, and leaves one outside the repo out", () => {
    const tracker = createShellEditTracker();
    const outside = join(tmpdir(), "Application Support", "notes.md");
    tracker.onToolUse(
      {
        name: "Bash",
        id: "t1",
        input: { command: `cat > "docs/my notes/a b.md" <<'EOF'\nx\nEOF\ncat > "${outside}" <<'EOF'\ny\nEOF` },
      },
      { timestamp: time(0), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t1" }, { timestamp: time(2) });
    touch("docs/my notes/a b.md", 1);

    const result = tracker.resolve({ dirty: new Set(["docs/my notes/a b.md"]), root });
    // The record keeps repo paths only from shell commands: nothing outside it can be dirty here.
    expect([...result.entries()]).toEqual([["docs/my notes/a b.md", { at: time(0), via: "shell" }]]);
  });

  it("expands globs and directories only inside their own window", () => {
    const tracker = createShellEditTracker();
    tracker.onToolUse(
      { name: "Bash", id: "t1", input: { command: `prettier --write "src/**/*.ts" docs` } },
      { timestamp: time(0), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t1" }, { timestamp: time(5) });
    // `docs` must exist as a directory under the root the tracker stats.
    mkdirSync(join(root, "docs"), { recursive: true });
    touch("src/a.ts", 2);
    touch("src/late.ts", 30);
    touch("docs/b.md", 3);
    touch("other/c.ts", 3);
    const dirty = new Set(["src/a.ts", "src/late.ts", "docs/b.md", "other/c.ts"]);

    const result = tracker.resolve({ dirty, root });
    expect([...result.keys()].sort()).toEqual(["docs/b.md", "src/a.ts"]);
    expect(result.get("src/a.ts")?.via).toBe("mtime");
  });

  it("attributes files gone from disk under a removed path, but not a neighbour's live edit there", () => {
    const tracker = createShellEditTracker();
    tracker.onToolUse(
      { name: "Bash", id: "t1", input: { command: "git rm -r -q -f .cursor scripts/old.mjs && rm tmp/*.log" } },
      { timestamp: time(0), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t1" }, { timestamp: time(2) });
    touch(".cursor/rules/kept.mdc", 40); // recreated later by another session: not a deletion
    const dirty = new Set([
      ".cursor/rules/a.mdc",
      ".cursor/skills/x/SKILL.md",
      ".cursor/rules/kept.mdc",
      "scripts/old.mjs",
      "tmp/a.log",
      "tmp/a.txt",
      "docs/gone.md",
    ]);

    const result = tracker.resolve({ dirty, root });
    expect([...result.keys()].sort()).toEqual([
      ".cursor/rules/a.mdc",
      ".cursor/skills/x/SKILL.md",
      "scripts/old.mjs",
      "tmp/a.log",
    ]);
    expect(result.get(".cursor/rules/a.mdc")).toEqual({ at: time(0), via: "shell" });
  });

  it("attributes a script's logged deletion only while the path is still gone and dirty", () => {
    const tracker = createShellEditTracker();
    tracker.onToolUse(
      { name: "Bash", id: "t1", input: { command: "node scripts/render-diagram-pdfs.mjs" } },
      { timestamp: time(0), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t1" }, { timestamp: time(2) });
    tracker.onToolUse(
      { name: "Bash", id: "t2", input: { command: "ls docs" } },
      { timestamp: time(10), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t2" }, { timestamp: time(11) });
    touch("docs/back.pdf", 20); // restored after the script ran: no longer a deletion
    const deletions = new Map([
      ["t1", [inRepo("docs/gone.pdf"), inRepo("docs/back.pdf"), inRepo("docs/committed.pdf")]],
      ["t2", [inRepo("docs/neighbour.pdf")]], // went missing while `ls` ran: a neighbour's
    ]);
    const dirty = new Set(["docs/gone.pdf", "docs/back.pdf", "docs/neighbour.pdf"]);

    const result = tracker.resolve({ dirty, root, deletions });
    expect([...result.keys()]).toEqual(["docs/gone.pdf"]);
    expect(result.get("docs/gone.pdf")).toEqual({ at: time(0), via: "mtime" });
  });

  it("keeps a script's edits when a later loop over variables rewrites the same files", () => {
    const tracker = createShellEditTracker();
    tracker.onToolUse(
      { name: "Bash", id: "t1", input: { command: "node /tmp/scratchpad/edit.mjs" } },
      { timestamp: time(0), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t1" }, { timestamp: time(2) });
    const loop = `F=$(git grep -l old); for f in $F; do sed -i '' 's/old/new/g' "$f"; done`;
    tracker.onToolUse({ name: "Bash", id: "t2", input: { command: loop } }, { timestamp: time(30), cwd: REPO_ROOT });
    tracker.onToolResult({ tool_use_id: "t2" }, { timestamp: time(31) });
    touch(".claude/agents/git-ops.md", 31); // the loop's write is the file's last one
    touch("docs/other.md", 1); // written by the script only

    const result = tracker.resolve({ dirty: new Set([".claude/agents/git-ops.md", "docs/other.md"]), root });
    expect(result.get(".claude/agents/git-ops.md")).toEqual({ at: time(30), via: "mtime" });
    expect(result.get("docs/other.md")).toEqual({ at: time(0), via: "mtime" });
  });

  it("credits a merge, pull or rebase with nothing it wrote, but keeps the conflicts resolved after it", () => {
    const tracker = createShellEditTracker();
    const run = (id, command, from, to) => {
      tracker.onToolUse({ name: "Bash", id, input: { command } }, { timestamp: time(from), cwd: REPO_ROOT });
      tracker.onToolResult({ tool_use_id: id }, { timestamp: time(to) });
    };
    run("m1", "git fetch -q && git merge dev", 0, 4);
    run("r1", "git checkout --theirs src/taken.ts", 20, 21);
    run("r2", "sed -i '' 's/<<<<<<< HEAD//' src/edited.ts", 30, 31);
    run("p1", "git pull --rebase", 40, 44);
    touch(".github/workflows/run-checks.yml", 2); // brought in cleanly, staged while the merge waits
    touch("src/conflicted.ts", 2); // markers git wrote, not resolved yet
    touch("src/taken.ts", 21);
    touch("src/edited.ts", 31);
    touch("src/pulled.ts", 42);
    const dirty = new Set([
      ".github/workflows/run-checks.yml",
      "src/conflicted.ts",
      "src/taken.ts",
      "src/edited.ts",
      "src/pulled.ts",
    ]);

    const result = tracker.resolve({ dirty, root });
    expect([...result.entries()].sort()).toEqual([
      ["src/edited.ts", { at: time(30), via: "shell" }],
      ["src/taken.ts", { at: time(20), via: "mtime" }],
    ]);
  });

  it("keeps the window of a call that also runs a script beside its merge", () => {
    const tracker = createShellEditTracker();
    tracker.onToolUse(
      { name: "Bash", id: "t1", input: { command: "git merge dev && node scripts/gen.mjs" } },
      { timestamp: time(0), cwd: REPO_ROOT },
    );
    tracker.onToolResult({ tool_use_id: "t1" }, { timestamp: time(5) });
    touch("src/generated.ts", 3);

    const result = tracker.resolve({ dirty: new Set(["src/generated.ts"]), root });
    expect(result.get("src/generated.ts")).toEqual({ at: time(0), via: "mtime" });
  });

  it("ignores non-shell tools and returns nothing without writing commands", () => {
    const tracker = createShellEditTracker();
    expect(tracker.onToolUse({ name: "Edit", id: "e1", input: { file_path: inRepo("a.ts") } }, {})).toBe(false);
    expect(
      tracker.onToolUse({ name: "Bash", id: "b1", input: { command: "git status" } }, { timestamp: time(0) }),
    ).toBe(true);
    expect(tracker.resolve({ dirty: new Set(["a.ts"]), root }).size).toBe(0);
  });
});
