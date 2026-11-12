// Shape checks for the convention plugins (svelte, python): every skill is path-scoped, keeps a
// short description (it is listed in every session), and appears in both plugin READMEs with
// the same globs as its frontmatter.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PLUGINS = ["svelte", "python"];
const MAX_DESCRIPTION = 250;
const MAX_BODY_LINES = 60;

/** Minimal frontmatter reader: `key: value` lines and `paths:` as a `- "glob"` list. */
function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, "frontmatter block");
  const data = { paths: [] };
  let inPaths = false;
  for (const line of match[1].split("\n")) {
    const item = line.match(/^\s+-\s+"(.+)"$/);
    if (inPaths && item) {
      data.paths.push(item[1]);
      continue;
    }
    inPaths = false;
    const pair = line.match(/^([\w-]+):\s*(.*)$/);
    if (!pair) continue;
    if (pair[1] === "paths") inPaths = true;
    else data[pair[1]] = pair[2].replace(/^"(.*)"$/, "$1");
  }
  return { data, body: match[2] };
}

for (const plugin of PLUGINS) {
  describe(`${plugin} plugin`, () => {
    const dir = join(ROOT, "plugins", plugin);
    const skills = readdirSync(join(dir, "skills"));
    const readmes = ["README.md", "README.uk.md"].map((name) => readFileSync(join(dir, name), "utf8"));

    it("has skills", () => assert.ok(skills.length > 0));

    for (const skill of skills) {
      const { data, body } = frontmatter(readFileSync(join(dir, "skills", skill, "SKILL.md"), "utf8"));

      it(`${skill}: name matches its folder and has paths`, () => {
        assert.equal(data.name, skill);
        assert.ok(data.paths.length > 0, "paths: list");
      });

      it(`${skill}: short description and body`, () => {
        assert.ok(data.description?.length > 0, "description");
        assert.ok(data.description.length <= MAX_DESCRIPTION, `description is ${data.description.length} chars`);
        assert.ok(body.split("\n").length <= MAX_BODY_LINES, "body line count");
      });

      it(`${skill}: listed in both READMEs with its globs`, () => {
        for (const readme of readmes) {
          const row = readme.split("\n").find((line) => line.includes(`| \`${plugin}:${skill}\` |`));
          assert.ok(row, "README row");
          for (const glob of data.paths) assert.ok(row.includes(`\`${glob}\``), `README row names ${glob}`);
        }
      });
    }
  });
}
