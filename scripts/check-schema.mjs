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
};
if (!validate(minimal)) {
  failed = true;
  console.error("FAIL minimal manifest { project } is rejected");
}
for (const [name, manifest] of Object.entries(broken)) {
  if (validate(manifest)) {
    failed = true;
    console.error(`FAIL accepted a broken manifest: ${name}`);
  }
}
if (!failed) console.log(`ok   minimal manifest accepted, ${Object.keys(broken).length} broken manifests rejected`);
process.exit(failed ? 1 : 0);
