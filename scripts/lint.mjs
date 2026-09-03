import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const forbidden = [/require\s*\(/, /from\s+["']node:/, /import\s*\(["']node:/, /node:https/, /https\.Agent/, /\bBuffer\b/, /module\.exports/, /exports\./];

for (const pattern of forbidden) {
  if (pattern.test(source)) throw new Error(`src/index.js contains Worker-incompatible runtime code: ${pattern}`);
}

console.log("Worker runtime lint passed.");
