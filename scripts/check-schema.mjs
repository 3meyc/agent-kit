#!/usr/bin/env node
// Validates examples/kit.json against schema/kit.schema.json, and checks that a few broken
// manifests are rejected, so the schema cannot quietly turn permissive.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(readJson("schema/kit.schema.json"));

let failed = false;
const example = readJson("examples/kit.json");
if (validate(example)) {
  console.log("ok   examples/kit.json");
} else {
  failed = true;
  console.error("FAIL examples/kit.json");
  for (const error of validate.errors) console.error(`     ${error.instancePath || "/"} ${error.message}`);
}

const minimal = { project: "my-app" };
const broken = {
  "missing project": {},
  "unknown top-level key": { ...minimal, extra: true },
  "lower-case item prefix": { ...minimal, itemPrefix: "app" },
  "absolute path": { ...minimal, paths: { docs: "/docs" } },
  "path leaving the repo": { ...minimal, paths: { ledger: "../ledger" } },
  "unknown command": { ...minimal, commands: { deploy: "make deploy" } },
  "port out of range": { ...minimal, devServer: { port: 70000 } },
  "lintOnEdit without a command": { ...minimal, lintOnEdit: { match: ["*.ts"] } },
  "lintOnEdit with an unknown key": { ...minimal, lintOnEdit: { command: "eslint", files: ["*.ts"] } },
  "lintOnEdit list with a rule without a command": { ...minimal, lintOnEdit: [{ command: "eslint" }, { match: ["*.ts"] }] },
  "empty lintOnEdit list": { ...minimal, lintOnEdit: [] },
  "check suite named like a command": { ...minimal, checks: { test: ["npm test"] } },
  "empty check suite": { ...minimal, checks: { i18n: [] } },
  "preflight step without a description": { ...minimal, preflight: { audit: { command: "npm run audit" } } },
  "release notes in an unknown format": { ...minimal, release: { notes: [{ path: "docs/releases.md", format: "list" }] } },
  "release base without needs": { ...minimal, release: { base: { repo: "https://github.com/owner/agent-kit.git" } } },
  "empty release notes": { ...minimal, release: { notes: [] } },
};
if (!validate(minimal)) {
  failed = true;
  console.error("FAIL minimal manifest { project } is rejected");
}
// A kit repo's own manifest: an overlay whose releases are a table in a doc and its mirror.
const overlayKit = {
  project: "my-overlay-kit",
  commands: { check: "pnpm run check" },
  release: {
    notes: [{ path: "docs/evolution.md", format: "table" }, { path: "docs/evolution.uk.md", format: "table", lang: "uk" }],
    base: { repo: "https://github.com/owner/agent-kit.git", needs: "ninth" },
  },
};
if (!validate(overlayKit)) {
  failed = true;
  console.error("FAIL an overlay kit's release manifest is rejected");
  for (const error of validate.errors) console.error(`     ${error.instancePath || "/"} ${error.message}`);
}
for (const [name, manifest] of Object.entries(broken)) {
  if (validate(manifest)) {
    failed = true;
    console.error(`FAIL accepted a broken manifest: ${name}`);
  }
}
if (!failed) console.log(`ok   minimal manifest accepted, ${Object.keys(broken).length} broken manifests rejected`);
process.exit(failed ? 1 : 0);
