#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_node="v24.18.0"
expected_pnpm="10.10.0"
expected_rust="rustc 1.93.0"

node_version="$(node --version)"
pnpm_version="$(pnpm --version)"
rust_version="$(rustc --version)"

[[ "${node_version}" == "${expected_node}" ]] || {
  echo "Expected Node.js ${expected_node}, got ${node_version}" >&2
  exit 1
}
[[ "${pnpm_version}" == "${expected_pnpm}" ]] || {
  echo "Expected pnpm ${expected_pnpm}, got ${pnpm_version}" >&2
  exit 1
}
[[ "${rust_version}" == "${expected_rust}"* ]] || {
  echo "Expected ${expected_rust}, got ${rust_version}" >&2
  exit 1
}
[[ "$("${root}/.tools/spacetime/spacetime" --version)" == *"tool version 2.6.1"* ]] || {
  echo "Expected SpacetimeDB CLI 2.6.1" >&2
  exit 1
}
[[ "$(wasm-opt --version)" == *"version 130"* ]] || {
  echo "Expected Binaryen 130" >&2
  exit 1
}

echo "Verified Node.js 24.18.0, pnpm 10.10.0, Rust 1.93.0, SpacetimeDB 2.6.1, Binaryen 130"
