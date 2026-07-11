#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(mktemp -d "${TMPDIR:-/tmp}/project-conversation-gateway-package.XXXXXX")"
trap 'rm -rf -- "$out"' EXIT

cd "$root"
pnpm --filter @project-conversation/gateway deploy --prod --legacy "$out"

node - "$out" <<'NODE'
const { existsSync } = require("node:fs");
const out = process.argv[2];
for (const required of ["dist/main.js", "package.json", "node_modules/fastify/package.json"]) {
  if (!existsSync(`${out}/${required}`)) throw new Error(`gateway package is missing ${required}`);
}
for (const forbidden of [
  "test",
  "src",
  "dist/testing",
  "node_modules/typescript",
  "node_modules/vitest",
]) {
  if (existsSync(`${out}/${forbidden}`)) throw new Error(`gateway package includes ${forbidden}`);
}
NODE

echo "Gateway production package contains its entrypoint and runtime dependencies only"
