import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

for (const [name, file] of Object.entries(process.env)) {
  if (!name.endsWith("_FILE") || !file) continue;
  const target = name.slice(0, -5);
  if (process.env[target]) throw new Error(`${target} and ${name} cannot both be set`);
  const value = (await readFile(file, "utf8")).trimEnd();
  if (!value) throw new Error(`${name} points to an empty secret`);
  process.env[target] = value;
  delete process.env[name];
}

const [main, ...args] = process.argv.slice(2);
if (!main || args.length > 0) throw new Error("gateway entrypoint accepts exactly one module path");
await import(pathToFileURL(resolve(main)).href);
