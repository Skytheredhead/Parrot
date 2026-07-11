#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cleanup_synthetic_module() {
  rm -f \
    "${root}/spacetimedb/target/wasm32-unknown-unknown/release/project_conversation_spacetimedb.wasm" \
    "${root}/spacetimedb/target/wasm32-unknown-unknown/release/project_conversation_spacetimedb.opt.wasm" \
    "${root}/spacetimedb/target/wasm32-unknown-unknown/release/deps/project_conversation_spacetimedb.wasm"
}
trap cleanup_synthetic_module EXIT
"${root}/scripts/install-spacetime-cli.sh"
"${root}/scripts/install-binaryen.sh"

export PATH="${root}/.tools/binaryen/version_130/bin:${HOME}/.cargo/bin:${PATH}"
export RUSTUP_TOOLCHAIN="1.93.0"
export PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER="${PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER:-https://issuer.test}"
export PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE="${PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE:-project-conversation-bindings}"
export PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT="${PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT:-bindings-owner}"

"${root}/.tools/spacetime/spacetime" generate \
  --lang typescript \
  --module-path "${root}/spacetimedb" \
  --out-dir "${root}/packages/db-bindings/src" \
  --yes
