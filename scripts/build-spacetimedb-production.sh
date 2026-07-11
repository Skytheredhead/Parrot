#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "${1:-}" == "--confirm-production-build" && $# -eq 1 ]] || {
  echo "Usage: $0 --confirm-production-build" >&2
  exit 1
}

node "${root}/scripts/validate-production-bootstrap-env.mjs"
"${root}/scripts/install-spacetime-cli.sh"
"${root}/scripts/install-binaryen.sh"
export PATH="${root}/.tools/binaryen/version_130/bin:${HOME}/.cargo/bin:${PATH}"
export RUSTUP_TOOLCHAIN=1.93.0

"${root}/.tools/spacetime/spacetime" build --module-path "${root}/spacetimedb"
echo "Production-configured module built locally; this command did not publish it"
