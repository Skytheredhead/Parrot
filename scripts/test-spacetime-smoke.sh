#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${SPACETIME_SMOKE_PORT:-39001}"
runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/project-conversation-spacetime.XXXXXX")"
server_log="${runtime_root}/server.log"
server_pid=""

stop_process() {
  local pid="$1" signal="$2"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    return
  fi
  kill "-$signal" "$pid" 2>/dev/null || true
  for _ in {1..50}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  stop_process "$server_pid" INT
  rm -rf "${runtime_root}"
  rm -f \
    "${root}/spacetimedb/target/wasm32-unknown-unknown/release/project_conversation_spacetimedb.wasm" \
    "${root}/spacetimedb/target/wasm32-unknown-unknown/release/project_conversation_spacetimedb.opt.wasm" \
    "${root}/spacetimedb/target/wasm32-unknown-unknown/release/deps/project_conversation_spacetimedb.wasm"
}
trap cleanup EXIT

"${root}/scripts/install-spacetime-cli.sh" >/dev/null
"${root}/scripts/install-binaryen.sh" >/dev/null
cli="${root}/.tools/spacetime/spacetime"

"${cli}" --root-dir "${runtime_root}/server-cli" start \
  --listen-addr "127.0.0.1:${port}" \
  --data-dir "${runtime_root}/server" \
  --in-memory \
  --non-interactive >"${server_log}" 2>&1 &
server_pid=$!

"${cli}" --root-dir "${runtime_root}/cli" server add smoke \
  --url "http://127.0.0.1:${port}" \
  --no-fingerprint >/dev/null

ready=false
for _ in {1..100}; do
  if "${cli}" --root-dir "${runtime_root}/cli" server ping smoke >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.1
done
if [[ "${ready}" != true ]]; then
  echo "SpacetimeDB smoke server did not become ready" >&2
  sed -n '1,200p' "${server_log}" >&2
  exit 1
fi

export PATH="${root}/.tools/binaryen/version_130/bin:${HOME}/.cargo/bin:${PATH}"
export RUSTUP_TOOLCHAIN="1.93.0"
export PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER="https://issuer.test"
export PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE="project-conversation-smoke"
export PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT="smoke-owner"
"${cli}" --root-dir "${runtime_root}/cli" publish \
  --server smoke \
  --module-path "${root}/spacetimedb" \
  --yes \
  project-conversation-smoke >/dev/null

for query in "SELECT * FROM post" "SELECT * FROM visible_posts"; do
  if "${cli}" --root-dir "${runtime_root}/cli" sql \
    --anonymous \
    --server smoke \
    project-conversation-smoke \
    "${query}" >"${runtime_root}/anonymous-query" 2>&1; then
    echo "Anonymous access unexpectedly passed the mandatory OIDC connection gate: ${query}" >&2
    exit 1
  fi
  if ! rg -q 'authenticated OIDC token required|token issuer or audience rejected|pending authentication policy is unavailable or expired' \
    "${runtime_root}/anonymous-query"; then
    echo "Anonymous query failed for an unexpected reason: ${query}" >&2
    sed -n '1,80p' "${runtime_root}/anonymous-query" >&2
    exit 1
  fi
done

echo "SpacetimeDB 2.6.1 fresh publish and mandatory OIDC-denial smoke checks passed"
