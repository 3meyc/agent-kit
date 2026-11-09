// `count-lines <file>...`: line count per file, the same on every OS (no `wc -l`, no
// `Measure-Object`). Prints `<count> <absolute path>` per file; exit 1 when any file fails.
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

/** @param {string} filePath */
export async function countLines(filePath) {
  let count = 0;
  const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  lines.on("line", () => {
    count += 1;
  });
  await once(lines, "close");
  return count;
}

/** @param {string[]} files */
export async function main(files) {
  if (files.length === 0) {
    console.error("Usage: count-lines <file>...");
    return 1;
  }
  let exitCode = 0;
  for (const file of files) {
    const path = resolve(file);
    try {
      console.log(`${String(await countLines(path)).padStart(6)} ${path}`);
    } catch (error) {
      console.error(`count-lines: ${path}: ${error instanceof Error ? error.message : error}`);
      exitCode = 1;
    }
  }
  return exitCode;
}
