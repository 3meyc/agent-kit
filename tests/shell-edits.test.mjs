// Parser tests for shared/shell-edits.mjs, ported from the source copies' vitest suite
// (the ledger tracker's tests stay with the session plugin). `expect` is a small shim over
// node:assert so the cases read as they did.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { globToRegExp, shellWriteTargets, stripHeredocs, tokenizeShell } from "../shared/shell-edits.mjs";

function expect(actual) {
  return {
    toBe: (expected) => assert.equal(actual, expected),
    toEqual: (expected) => assert.deepEqual(actual, expected),
    toContain: (expected) => assert.ok(actual.includes(expected), `${JSON.stringify(actual)} should contain ${JSON.stringify(expected)}`),
    toBeNull: () => assert.equal(actual, null),
    not: {
      toThrow: () => assert.doesNotThrow(actual),
      toContain: (expected) => assert.ok(!actual.includes(expected), `${JSON.stringify(actual)} should not contain ${JSON.stringify(expected)}`),
    },
  };
}


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

