import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const bindingsDirectory = new URL("../packages/db-bindings/src/", import.meta.url);

async function normalizeDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory.pathname, entry.name);

    if (entry.isDirectory()) {
      await normalizeDirectory(new URL(`${entry.name}/`, directory));
      continue;
    }

    if (!entry.isFile() || extname(entry.name) !== ".ts") {
      continue;
    }

    const source = await readFile(path, "utf8");
    const normalized = `${source.trimEnd()}\n`;
    if (source !== normalized) {
      await writeFile(path, normalized);
    }
  }
}

await normalizeDirectory(bindingsDirectory);
