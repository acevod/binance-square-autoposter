import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// Regression: a "${var}" inside a normal quoted string is never interpolated
// (it once broke the Gemini fallback URL). Only template literals interpolate.
test("no '${...}' inside plain quoted strings in src/", async () => {
  const files = [];
  for (const entry of await readdir(SRC, { recursive: true })) {
    if (entry.endsWith(".mjs")) files.push(path.join(SRC, entry));
  }
  const offenders = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return; // comments
      if (/"[^"`\n]*\$\{[^"\n]*"/.test(line) && !line.includes("`")) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
