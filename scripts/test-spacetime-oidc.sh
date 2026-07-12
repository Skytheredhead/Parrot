#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
spacetime_port="${SPACETIME_OIDC_TEST_PORT:-39002}"
oidc_port="${SPACETIME_OIDC_PROVIDER_PORT:-39003}"
runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/project-conversation-oidc.XXXXXX")"
runtime_root="$(cd "${runtime_root}" && pwd -P)"
server_log="${runtime_root}/server.log"
oidc_log="${runtime_root}/oidc.log"
server_pid=""
oidc_pid=""

stop_process() {
  local pid="$1"
  local signal="$2"

  if [[ -z "${pid}" ]] || ! kill -0 "${pid}" 2>/dev/null; then
    return
  fi

  kill "-${signal}" "${pid}" 2>/dev/null || true
  for _ in {1..50}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || true
      return
    fi
    sleep 0.1
  done

  kill -KILL "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
}

cleanup() {
  stop_process "${server_pid}" INT
  stop_process "${oidc_pid}" TERM
  rm -rf "${runtime_root}"
  rm -f \
    "${root}/spacetimedb/target/wasm32-unknown-unknown/release/project_conversation_spacetimedb.wasm" \
    "${root}/spacetimedb/target/wasm32-unknown-unknown/release/project_conversation_spacetimedb.opt.wasm" \
    "${root}/spacetimedb/target/wasm32-unknown-unknown/release/deps/project_conversation_spacetimedb.wasm"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

expect_failure() {
  local label="$1"
  local pattern="$2"
  local output="$3"
  shift 3

  if "$@" >"${output}" 2>&1; then
    echo "${label} unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "${pattern}" "${output}"; then
    echo "${label} failed for an unexpected reason" >&2
    sed -n '1,100p' "${output}" >&2
    exit 1
  fi
}

"${root}/scripts/install-node.sh" >/dev/null
"${root}/scripts/install-spacetime-cli.sh" >/dev/null
"${root}/scripts/install-binaryen.sh" >/dev/null

node="${root}/.tools/node/current/bin/node"
cli="${root}/.tools/spacetime/spacetime"
server_url="http://127.0.0.1:${spacetime_port}"
oidc_base="http://localhost:${oidc_port}"
issuer="${oidc_base}/project-conversation"
audience="project-conversation-oidc-test"
owner_subject="project-conversation-owner"
publisher_subject="project-conversation-deployment-publisher"
recipient_subject="project-conversation-recipient"
database="project-conversation-oidc-test"

OIDC_PORT="${oidc_port}" "${node}" --input-type=module \
  >"${oidc_log}" 2>&1 <<'NODE' &
import http from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";

const port = Number(process.env.OIDC_PORT);
const base = `http://localhost:${port}`;
const keyId = "project-conversation-oidc-test";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicJwk = publicKey.export({ format: "jwk" });
Object.assign(publicJwk, {
  kid: keyId,
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
});

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");

function mint(issuer, audience, subject) {
  const now = Math.floor(Date.now() / 1000);
  const protectedPart = encode({ alg: "RS256", typ: "JWT", kid: keyId });
  const payloadPart = encode({
    iss: issuer,
    aud: audience,
    sub: subject,
    iat: now,
    exp: now + 600,
  });
  const signingInput = `${protectedPart}.${payloadPart}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    privateKey,
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

function sendJson(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

http
  .createServer((request, response) => {
    const url = new URL(request.url, base);

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }

    if (url.pathname === "/jwks.json") {
      sendJson(response, { keys: [publicJwk] });
      return;
    }

    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      sendJson(response, { jwks_uri: `${base}/jwks.json` });
      return;
    }

    if (url.pathname === "/mint") {
      const tenant = url.searchParams.get("tenant") ?? "project-conversation";
      const tokenAudience = url.searchParams.get("audience") ?? "";
      const subject = url.searchParams.get("subject") ?? "";
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(mint(`${base}/${tenant}`, tokenAudience, subject));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  })
  .listen(port);
NODE
oidc_pid=$!

oidc_ready=false
for _ in {1..100}; do
  if curl --fail --silent --show-error "${oidc_base}/health" >/dev/null 2>&1; then
    oidc_ready=true
    break
  fi
  sleep 0.1
done
if [[ "${oidc_ready}" != true ]]; then
  echo "Local OIDC provider did not become ready" >&2
  sed -n '1,100p' "${oidc_log}" >&2
  exit 1
fi

"${cli}" --root-dir "${runtime_root}/server-cli" start \
  --listen-addr "127.0.0.1:${spacetime_port}" \
  --data-dir "${runtime_root}/server" \
  --in-memory \
  --non-interactive >"${server_log}" 2>&1 &
server_pid=$!

"${cli}" --root-dir "${runtime_root}/admin-cli" server add oidc-test \
  --url "${server_url}" \
  --no-fingerprint >/dev/null

server_ready=false
for _ in {1..100}; do
  if "${cli}" --root-dir "${runtime_root}/admin-cli" server ping oidc-test >/dev/null 2>&1; then
    server_ready=true
    break
  fi
  sleep 0.1
done
if [[ "${server_ready}" != true ]]; then
  echo "SpacetimeDB OIDC test server did not become ready" >&2
  sed -n '1,200p' "${server_log}" >&2
  exit 1
fi

mint_token() {
  local tenant="$1"
  local token_audience="$2"
  local subject="$3"

  curl --fail --silent --show-error --get "${oidc_base}/mint" \
    --data-urlencode "tenant=${tenant}" \
    --data-urlencode "audience=${token_audience}" \
    --data-urlencode "subject=${subject}"
}

configure_token_cli() {
  local name="$1"
  local token="$2"
  local cli_root="${runtime_root}/${name}-cli"

  "${cli}" --root-dir "${cli_root}" server add oidc-test \
    --url "${server_url}" \
    --no-fingerprint >/dev/null
  "${cli}" --root-dir "${cli_root}" login --token "${token}" >/dev/null
}

publisher_token="$(mint_token project-conversation "${audience}" "${publisher_subject}")"
configure_token_cli publisher "${publisher_token}"

export PATH="${root}/.tools/binaryen/version_130/bin:${HOME}/.cargo/bin:${PATH}"
export RUSTUP_TOOLCHAIN="1.93.0"
export PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER="${issuer}"
export PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE="${audience}"
export PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT="${owner_subject}"

"${cli}" --root-dir "${runtime_root}/publisher-cli" publish \
  --server oidc-test \
  --module-path "${root}/spacetimedb" \
  --yes \
    "${database}" >/dev/null

owner_token="$(mint_token project-conversation "${audience}" "${owner_subject}")"
wrong_issuer_token="$(mint_token project-conversation-wrong-issuer "${audience}" "${owner_subject}")"
wrong_audience_token="$(mint_token project-conversation project-conversation-wrong-audience "${owner_subject}")"
wrong_subject_token="$(mint_token project-conversation "${audience}" project-conversation-wrong-subject)"
recipient_token="$(mint_token project-conversation "${audience}" "${recipient_subject}")"

configure_token_cli owner "${owner_token}"
configure_token_cli wrong-issuer "${wrong_issuer_token}"
configure_token_cli wrong-audience "${wrong_audience_token}"
configure_token_cli wrong-subject "${wrong_subject_token}"
configure_token_cli recipient "${recipient_token}"

expect_failure \
  "Wrong-issuer bootstrap" \
  'token issuer or audience rejected' \
  "${runtime_root}/wrong-issuer-bootstrap.out" \
  "${cli}" --root-dir "${runtime_root}/wrong-issuer-cli" call --server oidc-test \
  "${database}" bootstrap_owner Owner Workspace '[1]'

expect_failure \
  "Wrong-audience bootstrap" \
  'token issuer or audience rejected' \
  "${runtime_root}/wrong-audience-bootstrap.out" \
  "${cli}" --root-dir "${runtime_root}/wrong-audience-cli" call --server oidc-test \
  "${database}" bootstrap_owner Owner Workspace '[2]'

expect_failure \
  "Wrong-subject bootstrap" \
  'OIDC subject is not authorized to bootstrap this deployment' \
  "${runtime_root}/wrong-subject-bootstrap.out" \
  "${cli}" --root-dir "${runtime_root}/wrong-subject-cli" call --server oidc-test \
  "${database}" bootstrap_owner Owner Workspace '[3]'

"${cli}" --root-dir "${runtime_root}/owner-cli" call --server oidc-test \
  "${database}" bootstrap_owner Owner Workspace '[4]' >/dev/null

expect_failure \
  "Second owner bootstrap" \
  'bootstrap is already complete' \
  "${runtime_root}/second-bootstrap.out" \
  "${cli}" --root-dir "${runtime_root}/owner-cli" call --server oidc-test \
  "${database}" bootstrap_owner Another Another '[5]'

"${cli}" --root-dir "${runtime_root}/owner-cli" call --server oidc-test \
  "${database}" propose_platform_operator_transfer \
  "${recipient_subject}" 1 300 '[6]' >/dev/null

expect_failure \
  "Transfer acceptance by the current operator" \
  'proposed operator recipient token required' \
  "${runtime_root}/wrong-transfer-recipient.out" \
  "${cli}" --root-dir "${runtime_root}/owner-cli" call --server oidc-test \
  "${database}" accept_platform_operator_transfer 1 '[7]'

"${cli}" --root-dir "${runtime_root}/recipient-cli" call --server oidc-test \
  "${database}" accept_platform_operator_transfer 1 '[8]' >/dev/null
"${cli}" --root-dir "${runtime_root}/recipient-cli" call --server oidc-test \
  "${database}" propose_platform_operator_transfer \
  "${owner_subject}" 2 300 '[9]' >/dev/null
"${cli}" --root-dir "${runtime_root}/owner-cli" call --server oidc-test \
  "${database}" accept_platform_operator_transfer 2 '[10]' >/dev/null

"${cli}" --root-dir "${runtime_root}/owner-cli" sql --server oidc-test \
  "${database}" "SELECT * FROM my_workspaces" >"${runtime_root}/public-sql.out"
if ! rg -q 'Workspace' "${runtime_root}/public-sql.out"; then
  echo "Authenticated public SQL did not return the bootstrapped workspace" >&2
  sed -n '1,100p' "${runtime_root}/public-sql.out" >&2
  exit 1
fi

"${cli}" --root-dir "${runtime_root}/owner-cli" sql --server oidc-test \
  "${database}" "SELECT * FROM my_workspace_lifecycles" >"${runtime_root}/lifecycle-sql.out"
if ! rg -Fq '(active = ())' "${runtime_root}/lifecycle-sql.out"; then
  echo "Authenticated lifecycle SQL did not return the fail-closed active authority row" >&2
  sed -n '1,100p' "${runtime_root}/lifecycle-sql.out" >&2
  exit 1
fi
workspace_id="$(rg -o '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
  "${runtime_root}/lifecycle-sql.out" | head -1)"
[[ -n "${workspace_id}" ]] || { echo "Lifecycle SQL did not expose a workspace identifier" >&2; exit 1; }
workspace_u128="$("${node}" -e 'console.log(BigInt(`0x${process.argv[1].replaceAll("-", "")}`).toString())' "${workspace_id}")"
lifecycle_configuration="$(printf '{"workspace_id":{"__uuid__":%s},"deleted_content_retention_days":{"some":30},"deletion_grace_days":{"some":1},"expected_revision":1,"client_request_id":{"__uuid__":11}}' "${workspace_u128}")"
"${cli}" --root-dir "${runtime_root}/owner-cli" call --server oidc-test \
  "${database}" configure_workspace_lifecycle "${lifecycle_configuration}" >/dev/null
lifecycle_request="$(printf '{"workspace_id":{"__uuid__":%s},"expected_revision":2,"client_request_id":{"__uuid__":12}}' "${workspace_u128}")"
"${cli}" --root-dir "${runtime_root}/owner-cli" call --server oidc-test \
  "${database}" request_workspace_deletion "${lifecycle_request}" >/dev/null
"${cli}" --root-dir "${runtime_root}/owner-cli" sql --server oidc-test \
  "${database}" "SELECT * FROM my_workspace_lifecycles" >"${runtime_root}/lifecycle-requested.out"
if ! rg -Fq '(deletionRequested = ())' "${runtime_root}/lifecycle-requested.out"; then
  echo "Workspace deletion request did not publish the lifecycle fence" >&2
  sed -n '1,100p' "${runtime_root}/lifecycle-requested.out" >&2
  exit 1
fi
"${cli}" --root-dir "${runtime_root}/owner-cli" sql --server oidc-test \
  "${database}" "SELECT * FROM my_workspaces" >"${runtime_root}/fenced-workspaces.out"
if rg -Fq '"Workspace"' "${runtime_root}/fenced-workspaces.out"; then
  echo "Lifecycle-fenced workspace remained visible through my_workspaces" >&2
  sed -n '1,100p' "${runtime_root}/fenced-workspaces.out" >&2
  exit 1
fi
lifecycle_cancel="$(printf '{"workspace_id":{"__uuid__":%s},"expected_revision":3,"client_request_id":{"__uuid__":13}}' "${workspace_u128}")"
"${cli}" --root-dir "${runtime_root}/owner-cli" call --server oidc-test \
  "${database}" cancel_workspace_deletion "${lifecycle_cancel}" >/dev/null
"${cli}" --root-dir "${runtime_root}/owner-cli" sql --server oidc-test \
  "${database}" "SELECT * FROM my_workspaces" >"${runtime_root}/restored-workspaces.out"
if ! rg -Fq '"Workspace"' "${runtime_root}/restored-workspaces.out"; then
  echo "Canceling the lifecycle fence did not restore authoritative workspace visibility" >&2
  sed -n '1,100p' "${runtime_root}/restored-workspaces.out" >&2
  exit 1
fi

"${cli}" --root-dir "${runtime_root}/owner-cli" subscribe \
  --server oidc-test \
  --print-initial-update \
  --timeout 2 \
  "${database}" \
  "SELECT * FROM my_workspaces" >"${runtime_root}/public-subscription.out"
if ! rg -q 'Workspace' "${runtime_root}/public-subscription.out"; then
  echo "Authenticated public subscription did not return the bootstrapped workspace" >&2
  sed -n '1,100p' "${runtime_root}/public-subscription.out" >&2
  exit 1
fi

expect_failure \
  "Wrong-audience subscription" \
  'websocket error|connection reset|closed connection|HTTP error' \
  "${runtime_root}/wrong-audience-subscription.out" \
  "${cli}" --root-dir "${runtime_root}/wrong-audience-cli" subscribe \
  --server oidc-test \
  --print-initial-update \
  --timeout 2 \
  "${database}" \
  "SELECT * FROM my_workspaces"

expect_failure \
  "Authenticated private-table query" \
  'private|not public|access denied|permission denied' \
  "${runtime_root}/private-table.out" \
  "${cli}" --root-dir "${runtime_root}/owner-cli" sql --server oidc-test \
  "${database}" "SELECT * FROM workspace"

database_info="${runtime_root}/database-info.json"
canonical_schema="${runtime_root}/schema-v9.canonical.json"
publisher_token_file="${runtime_root}/publisher-owner.token"
verification_record="${runtime_root}/restored-state.verification"
curl --fail --silent --show-error "${server_url}/v1/database/${database}" >"${database_info}"
curl --fail --silent --show-error "${server_url}/v1/database/${database}/schema?version=9" \
  | jq -S -c . >"${canonical_schema}"
chmod 600 "${database_info}" "${canonical_schema}"
database_identity="$(jq -er '.database_identity.__identity__ | ltrimstr("0x")' "${database_info}")"
initial_program_hash="$(jq -er '.initial_program | ltrimstr("0x")' "${database_info}")"
schema_sha256="$(shasum -a 256 "${canonical_schema}" | awk '{print $1}')"
printf '%s\n' "${publisher_token}" >"${publisher_token_file}"
chmod 600 "${publisher_token_file}"
"${root}/infra/scripts/verify-restored-state.sh" \
  --endpoint "${server_url}" \
  --database-name "${database}" \
  --database-identity "${database_identity}" \
  --initial-program-hash "${initial_program_hash}" \
  --schema-sha256 "${schema_sha256}" \
  --owner-token-file "${publisher_token_file}" \
  --output "${verification_record}"

echo "SpacetimeDB 2.6.1 OIDC bootstrap, handoff, SQL, WebSocket, and private restore-verifier checks passed"
