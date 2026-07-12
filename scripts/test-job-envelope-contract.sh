#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${root}/.tools/node/current/bin:${PATH}"

pnpm --dir "${root}/services/worker" exec tsc -p "${root}/scripts/tsconfig.job-envelope.json"
pnpm --dir "${root}/services/worker" exec tsx --test test/spacetime-outbox.test.ts
