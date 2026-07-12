#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INFRA_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
COMPOSE_FILE="$INFRA_DIR/compose.yaml"
EXPECTED_SPACETIMEDB_IMAGE='clockworklabs/spacetime:v2.6.1@sha256:53100591a8bfd62c6e088e801b68e96871a8fc6e68eb4fb031bc6ac76f77a72e'
EXPECTED_OTEL_IMAGE='otel/opentelemetry-collector-contrib:0.156.0@sha256:125bdbeb7590cc1952c5b3430ecf14063568980c2c93d5b38676cc0446ed8108'
EXPECTED_EDGE_IMAGE='nginx:1.28.0-alpine@sha256:09ab424a8c788f8d0fe3a64429f6d19dfa526885c8609b748d0943a75dcb9f8c'
EXPECTED_CLAMAV_IMAGE='clamav/clamav:1.4.3_base@sha256:be37f82c9cccf6c2559a44b8fb537e6f11e8547b37988650b169c4540c2f298c'
EXPECTED_SOCAT_IMAGE='alpine/socat:1.8.0.3@sha256:2d83bdac2858b4bcfa57d478ce53ae3c18a1147a68db4f610454a2d60e5c19bc'
PLACEHOLDER_DIGEST='sha256:0000000000000000000000000000000000000000000000000000000000000000'
DEPLOYMENT_ENV_KEYS=(
  COMPOSE_PROJECT_NAME DEPLOY_ENVIRONMENT SPACETIMEDB_IMAGE SPACETIMEDB_DATA_DIR
  SPACETIMEDB_LOOPBACK_PORT SPACETIMEDB_DATABASE_NAME SPACETIMEDB_DATABASE_IDENTITY
  RESTORE_EXPECTED_INITIAL_PROGRAM_HASH RESTORE_EXPECTED_MODULE_SCHEMA_SHA256 RESTORE_VERIFIER_DATABASE_OWNER_TOKEN_FILE
  BACKUP_DIR GATEWAY_IMAGE WORKER_IMAGE GATEWAY_LOOPBACK_PORT EDGE_IMAGE EDGE_LOOPBACK_PORT
  EDGE_SERVER_NAME EDGE_CONFIG_TEMPLATE_PATH CLAMAV_IMAGE CLAMAV_DATA_DIR CLAMAV_CONFIG_PATH
  SOCAT_IMAGE GATEWAY_STATE_DIR WORKER_STATE_DIR OBJECT_DATA_DIR EXPORT_DATA_DIR
  OLLAMA_BRIDGE_DIR OLLAMA_MODEL OIDC_ALLOW_MISSING_TYP OIDC_ALLOW_CLIENT_ID_AUDIENCE
  SPACETIMEDB_WORKER_SERVICE_IDENTITY WORKOS_M2M_TOKEN_ENDPOINT WORKOS_M2M_CLIENT_ID
  WORKOS_M2M_CLIENT_SECRET_FILE WORKOS_M2M_ISSUER WORKOS_M2M_AUDIENCE
  WORKOS_M2M_EXPECTED_SUBJECT GMAIL_SENDER
  GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET_FILE GMAIL_REFRESH_TOKEN_FILE GMAIL_MESSAGE_ID_DOMAIN
  GATEWAY_READINESS_TOKEN_FILE BACKUP_EVIDENCE_SIGNING_KEY_FILE BACKUP_EVIDENCE_VERIFY_KEY_FILE
  OBJECT_CAPABILITY_HMAC_SECRET_FILE FILE_CAPABILITY_PUBLIC_ORIGIN
  GATEWAY_ADAPTER_MODULE GATEWAY_SPACETIMEDB_URI GATEWAY_LOG_LEVEL ALLOWED_ORIGINS
  WORKER_ADAPTER_MODULE WORKER_ID WORKER_LOG_LEVEL WORKER_POLL_INTERVAL_MS
  WORKER_CLAIM_TIMEOUT_MS WORKER_READINESS_TIMEOUT_MS WORKER_LEASE_MS
  WORKER_HEARTBEAT_MS WORKER_HANDLER_TIMEOUT_MS WORKER_HEARTBEAT_TIMEOUT_MS
  WORKER_SHUTDOWN_TIMEOUT_MS WORKER_MAX_ATTEMPTS WORKER_MAX_JOB_AGE_MS
  WORKER_BACKOFF_BASE_MS WORKER_BACKOFF_CAP_MS WORKER_BACKOFF_JITTER_RATIO
  WORKER_CHECKPOINT_MS AGENT_MAX_CONTEXT_BYTES AGENT_MAX_OUTPUT_TOKENS
  AGENT_MAX_TOOL_CALLS AGENT_MAX_RUN_COST_MICROS
  TRUSTED_PROXY_CIDRS OIDC_ISSUER OIDC_AUDIENCE OIDC_JWKS_URI DB_TOKEN_AUDIENCE
  AGENT_STREAM_ORIGINS FILE_CAPABILITY_ORIGINS
  PUBLIC_WSS_REAL_IP_MODE PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS
  GATEWAY_OTEL_ENABLED GATEWAY_OTEL_TRACES_ENDPOINT OTEL_COLLECTOR_IMAGE OTEL_CONFIG_PATH
  OTEL_EXPORTER_OTLP_ENDPOINT CONTAINER_LOG_MAX_SIZE CONTAINER_LOG_MAX_FILES
  SPACETIMEDB_PIDS_LIMIT SPACETIMEDB_MEMORY_LIMIT SPACETIMEDB_CPU_LIMIT
  GATEWAY_PIDS_LIMIT GATEWAY_MEMORY_LIMIT GATEWAY_CPU_LIMIT EDGE_PIDS_LIMIT
  EDGE_MEMORY_LIMIT EDGE_CPU_LIMIT CLAMAV_PIDS_LIMIT CLAMAV_MEMORY_LIMIT CLAMAV_CPU_LIMIT
  OTEL_PIDS_LIMIT OTEL_MEMORY_LIMIT OTEL_CPU_LIMIT WORKER_PIDS_LIMIT WORKER_MEMORY_LIMIT WORKER_CPU_LIMIT
)

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }

usage_env() {
  printf '  --env-file PATH  reviewed production or staging environment file\n'
}

load_env_file() {
  local file="$1" require_private="${2:-true}" line key value
  [[ -f "$file" && ! -L "$file" ]] || die "environment file must be a regular, non-symlink file: $file"
  if [[ "$require_private" == true ]]; then
    assert_private_regular_file "$file" "environment file"
  else
    assert_trusted_regular_file "$file" "environment file"
  fi
  ENV_FILE="$(cd -- "$(dirname -- "$file")" && pwd -P)/$(basename -- "$file")"
  for key in "${DEPLOYMENT_ENV_KEYS[@]}"; do unset "$key"; done
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || die "invalid environment line (expected KEY=VALUE)"
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid environment key: $key"
    case "$key" in
      COMPOSE_PROJECT_NAME|DEPLOY_ENVIRONMENT|SPACETIMEDB_IMAGE|SPACETIMEDB_DATA_DIR|SPACETIMEDB_LOOPBACK_PORT|SPACETIMEDB_DATABASE_NAME|SPACETIMEDB_DATABASE_IDENTITY|SPACETIMEDB_WORKER_SERVICE_IDENTITY|RESTORE_EXPECTED_INITIAL_PROGRAM_HASH|RESTORE_EXPECTED_MODULE_SCHEMA_SHA256|RESTORE_VERIFIER_DATABASE_OWNER_TOKEN_FILE|BACKUP_DIR|GATEWAY_IMAGE|WORKER_IMAGE|GATEWAY_LOOPBACK_PORT|EDGE_IMAGE|EDGE_LOOPBACK_PORT|EDGE_SERVER_NAME|EDGE_CONFIG_TEMPLATE_PATH|CLAMAV_IMAGE|CLAMAV_DATA_DIR|CLAMAV_CONFIG_PATH|SOCAT_IMAGE|GATEWAY_STATE_DIR|WORKER_STATE_DIR|OBJECT_DATA_DIR|EXPORT_DATA_DIR|OLLAMA_BRIDGE_DIR|OLLAMA_MODEL|WORKOS_M2M_TOKEN_ENDPOINT|WORKOS_M2M_CLIENT_ID|WORKOS_M2M_CLIENT_SECRET_FILE|WORKOS_M2M_ISSUER|WORKOS_M2M_AUDIENCE|WORKOS_M2M_EXPECTED_SUBJECT|GMAIL_SENDER|GMAIL_CLIENT_ID|GMAIL_CLIENT_SECRET_FILE|GMAIL_REFRESH_TOKEN_FILE|GMAIL_MESSAGE_ID_DOMAIN|GATEWAY_READINESS_TOKEN_FILE|OBJECT_CAPABILITY_HMAC_SECRET_FILE|BACKUP_EVIDENCE_SIGNING_KEY_FILE|BACKUP_EVIDENCE_VERIFY_KEY_FILE|GATEWAY_ADAPTER_MODULE|GATEWAY_SPACETIMEDB_URI|GATEWAY_LOG_LEVEL|ALLOWED_ORIGINS|TRUSTED_PROXY_CIDRS|OIDC_ISSUER|OIDC_AUDIENCE|OIDC_JWKS_URI|OIDC_ALLOW_MISSING_TYP|OIDC_ALLOW_CLIENT_ID_AUDIENCE|DB_TOKEN_AUDIENCE|AGENT_STREAM_ORIGINS|FILE_CAPABILITY_ORIGINS|FILE_CAPABILITY_PUBLIC_ORIGIN|PUBLIC_WSS_REAL_IP_MODE|PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS|GATEWAY_OTEL_ENABLED|GATEWAY_OTEL_TRACES_ENDPOINT|OTEL_COLLECTOR_IMAGE|OTEL_CONFIG_PATH|OTEL_EXPORTER_OTLP_ENDPOINT|CONTAINER_LOG_MAX_SIZE|CONTAINER_LOG_MAX_FILES|SPACETIMEDB_PIDS_LIMIT|SPACETIMEDB_MEMORY_LIMIT|SPACETIMEDB_CPU_LIMIT|GATEWAY_PIDS_LIMIT|GATEWAY_MEMORY_LIMIT|GATEWAY_CPU_LIMIT|EDGE_PIDS_LIMIT|EDGE_MEMORY_LIMIT|EDGE_CPU_LIMIT|CLAMAV_PIDS_LIMIT|CLAMAV_MEMORY_LIMIT|CLAMAV_CPU_LIMIT|OTEL_PIDS_LIMIT|OTEL_MEMORY_LIMIT|OTEL_CPU_LIMIT|WORKER_ADAPTER_MODULE|WORKER_ID|WORKER_LOG_LEVEL|WORKER_POLL_INTERVAL_MS|WORKER_CLAIM_TIMEOUT_MS|WORKER_READINESS_TIMEOUT_MS|WORKER_LEASE_MS|WORKER_HEARTBEAT_MS|WORKER_HANDLER_TIMEOUT_MS|WORKER_HEARTBEAT_TIMEOUT_MS|WORKER_SHUTDOWN_TIMEOUT_MS|WORKER_MAX_ATTEMPTS|WORKER_MAX_JOB_AGE_MS|WORKER_BACKOFF_BASE_MS|WORKER_BACKOFF_CAP_MS|WORKER_BACKOFF_JITTER_RATIO|WORKER_CHECKPOINT_MS|AGENT_MAX_CONTEXT_BYTES|AGENT_MAX_OUTPUT_TOKENS|AGENT_MAX_TOOL_CALLS|AGENT_MAX_RUN_COST_MICROS|WORKER_PIDS_LIMIT|WORKER_MEMORY_LIMIT|WORKER_CPU_LIMIT) ;;
      *) die "environment key is not on the deployment allowlist: $key" ;;
    esac
    [[ "$value" != *$'\n'* ]] || die "multiline environment values are not supported"
    export "$key=$value"
  done < "$ENV_FILE"
}

require_base_identity() {
  : "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
  : "${DEPLOY_ENVIRONMENT:?DEPLOY_ENVIRONMENT is required}"
  case "$COMPOSE_PROJECT_NAME:$DEPLOY_ENVIRONMENT" in
    project-conversation-production:production|project-conversation-staging:staging) ;;
    *) die "refusing unapproved project/environment identity: $COMPOSE_PROJECT_NAME/$DEPLOY_ENVIRONMENT" ;;
  esac
  [[ "${SPACETIMEDB_LOOPBACK_PORT:-}" =~ ^[0-9]{4,5}$ ]] || die "invalid SpacetimeDB loopback port"
  (( SPACETIMEDB_LOOPBACK_PORT >= 1024 && SPACETIMEDB_LOOPBACK_PORT <= 65535 )) || die "SpacetimeDB loopback port must be 1024-65535"
  (( SPACETIMEDB_LOOPBACK_PORT != 4789 )) || die "port 4789 belongs to the audited unrelated SpacetimeDB service"
  [[ "${GATEWAY_LOOPBACK_PORT:-}" =~ ^[0-9]{4,5}$ ]] || die "invalid gateway loopback port"
  (( GATEWAY_LOOPBACK_PORT >= 1024 && GATEWAY_LOOPBACK_PORT <= 65535 )) || die "gateway loopback port must be 1024-65535"
  (( GATEWAY_LOOPBACK_PORT != 4789 )) || die "port 4789 belongs to the audited unrelated SpacetimeDB service"
  [[ "${EDGE_LOOPBACK_PORT:-}" =~ ^[0-9]{4,5}$ ]] || die "invalid edge loopback port"
  (( EDGE_LOOPBACK_PORT >= 1024 && EDGE_LOOPBACK_PORT <= 65535 && EDGE_LOOPBACK_PORT != 4789 )) \
    || die "edge loopback port is outside the approved range"
  [[ "$GATEWAY_LOOPBACK_PORT" != "$SPACETIMEDB_LOOPBACK_PORT" \
    && "$EDGE_LOOPBACK_PORT" != "$SPACETIMEDB_LOOPBACK_PORT" \
    && "$EDGE_LOOPBACK_PORT" != "$GATEWAY_LOOPBACK_PORT" ]] || die "loopback ports must be distinct"
  case "$DEPLOY_ENVIRONMENT:$SPACETIMEDB_LOOPBACK_PORT:$GATEWAY_LOOPBACK_PORT:$EDGE_LOOPBACK_PORT" in
    production:39000:39080:39090|staging:39100:39180:39190) ;;
    *) die "loopback ports must match the reserved Parrot environment allocation" ;;
  esac
  [[ "${SPACETIMEDB_DATABASE_NAME:-}" =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]] \
    || die "SpacetimeDB database name must be a bounded lowercase DNS-style name"
  [[ "${SPACETIMEDB_DATABASE_IDENTITY:-}" =~ ^[a-f0-9]{64}$ ]] \
    || die "SpacetimeDB database identity must be an exact 64-character lowercase hex identity"
  [[ "${SPACETIMEDB_WORKER_SERVICE_IDENTITY:-}" =~ ^[a-f0-9]{64}$ ]] \
    || die "SpacetimeDB worker service identity must be exact lowercase hex"
  [[ "${RESTORE_EXPECTED_INITIAL_PROGRAM_HASH:-}" =~ ^[a-f0-9]{64}$ ]] \
    || die "restore expected initial program hash must be an exact 64-character lowercase hex hash"
  [[ "${RESTORE_EXPECTED_MODULE_SCHEMA_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] \
    || die "restore expected module/schema digest must be an exact sha256"

  local expected_root="/srv/project-conversation/$DEPLOY_ENVIRONMENT"
  [[ "${SPACETIMEDB_DATA_DIR:-}" == "$expected_root/spacetime" ]] || die "SpacetimeDB data path must be $expected_root/spacetime"
  [[ "${BACKUP_DIR:-}" == "/mnt/bigboi/project-conversation/$DEPLOY_ENVIRONMENT/backups" ]] \
    || die "backup path must stay on /mnt/bigboi for this environment"
  [[ "${EDGE_CONFIG_TEMPLATE_PATH:-}" == "$expected_root/config/edge.conf.template" ]] \
    || die "edge configuration path must stay inside the approved environment"
  [[ "${CLAMAV_DATA_DIR:-}" == "$expected_root/clamav" ]] \
    || die "ClamAV signature data path must stay inside the approved environment"
  [[ "${CLAMAV_CONFIG_PATH:-}" == "$expected_root/config/clamd.conf" ]] \
    || die "ClamAV configuration path must stay inside the approved environment"
  [[ "${GATEWAY_STATE_DIR:-}" == "$expected_root/state/gateway" \
    && "${WORKER_STATE_DIR:-}" == "$expected_root/state/worker" \
    && "${OBJECT_DATA_DIR:-}" == "$expected_root/state/objects" \
    && "${EXPORT_DATA_DIR:-}" == "$expected_root/state/exports" \
    && "${OLLAMA_BRIDGE_DIR:-}" == "$expected_root/state/worker/ollama-bridge" ]] \
    || die "provider state paths must match the isolated environment allocation"
  [[ "${OLLAMA_MODEL:-}" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || die "Ollama model identifier is invalid"
  [[ "${OIDC_ALLOW_MISSING_TYP:-}" == true || "${OIDC_ALLOW_MISSING_TYP:-}" == false ]] \
    || die "OIDC_ALLOW_MISSING_TYP must be true or false"
  [[ "${OIDC_ALLOW_CLIENT_ID_AUDIENCE:-}" == true || "${OIDC_ALLOW_CLIENT_ID_AUDIENCE:-}" == false ]] \
    || die "OIDC_ALLOW_CLIENT_ID_AUDIENCE must be true or false"
  [[ "${EDGE_SERVER_NAME:-}" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ \
    && "$EDGE_SERVER_NAME" == *.* && "$EDGE_SERVER_NAME" != *..* ]] \
    || die "edge server name must be a bounded lowercase DNS name"
  [[ "${GATEWAY_READINESS_TOKEN_FILE:-}" == "$expected_root/secrets/gateway-readiness-token" ]] \
    || die "gateway readiness secret path must stay inside the approved environment"
  [[ "${OBJECT_CAPABILITY_HMAC_SECRET_FILE:-}" == "$expected_root/secrets/object-capability-hmac" ]] \
    || die "object capability secret path must stay inside the approved environment"
  [[ "${BACKUP_EVIDENCE_SIGNING_KEY_FILE:-}" == "$expected_root/secrets/backup-evidence-ed25519-private.pem" ]] \
    || die "backup evidence signing-key path must stay inside the approved environment"
  [[ "${BACKUP_EVIDENCE_VERIFY_KEY_FILE:-}" == "$expected_root/config/backup-evidence-ed25519-public.pem" ]] \
    || die "backup evidence verification-key path must stay inside the approved environment"
  [[ "${RESTORE_VERIFIER_DATABASE_OWNER_TOKEN_FILE:-}" == "$expected_root/secrets/restore-verifier-database-owner-token" ]] \
    || die "restore verifier owner-token path must stay inside the approved environment"
  [[ "${WORKOS_M2M_CLIENT_SECRET_FILE:-}" == "$expected_root/secrets/workos-m2m-client-secret" ]] \
    || die "worker WorkOS secret path must stay inside the approved environment"
  if [[ -n "${GMAIL_CLIENT_SECRET_FILE:-}${GMAIL_REFRESH_TOKEN_FILE:-}" ]]; then
    [[ "${GMAIL_CLIENT_SECRET_FILE:-}" == "$expected_root/secrets/gmail-client-secret" \
      && "${GMAIL_REFRESH_TOKEN_FILE:-}" == "$expected_root/secrets/gmail-refresh-token" ]] \
      || die "optional Gmail secret paths must stay inside the approved environment"
  fi
  [[ "${WORKER_ADAPTER_MODULE:-}" == /app/dist/production/parrot.js ]] \
    || die "worker must use the repository-owned Parrot production composition"
}

assert_immutable_image() {
  local image="$1" label="$2"
  [[ "$image" =~ @sha256:[a-f0-9]{64}$ ]] || die "$label must be pinned to an exact sha256 digest"
  [[ "$image" != *"$PLACEHOLDER_DIGEST"* ]] || die "$label still uses the non-runnable placeholder digest"
  [[ "$image" != registry.invalid/* ]] || die "$label still uses the non-runnable placeholder registry"
}

is_valid_ipv4_cidr() {
  local cidr="$1" address prefix octet
  local -a octets=()
  [[ "$cidr" == */* ]] || return 1
  address="${cidr%/*}"; prefix="${cidr##*/}"
  [[ "$prefix" =~ ^[0-9]{1,2}$ ]] || return 1
  (( 10#$prefix <= 32 )) || return 1
  [[ "$address" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS=. read -r -a octets <<< "$address"
  [[ "${#octets[@]}" == 4 ]] || return 1
  for octet in "${octets[@]}"; do
    (( 10#$octet <= 255 )) || return 1
  done
}

is_valid_ipv6_cidr() {
  local cidr="$1" address prefix reduced segment segment_count=0
  local -a segments=()
  [[ "$cidr" == */* ]] || return 1
  address="${cidr%/*}"; prefix="${cidr##*/}"
  [[ "$prefix" =~ ^[0-9]{1,3}$ ]] || return 1
  (( 10#$prefix <= 128 )) || return 1
  [[ "$address" == *:* && "$address" =~ ^[0-9A-Fa-f:]+$ ]] || return 1
  [[ "$address" != *:::* ]] || return 1
  [[ "$address" != :* || "$address" == ::* ]] || return 1
  [[ "$address" != *: || "$address" == *:: ]] || return 1
  reduced="${address/::/}"
  [[ "$reduced" != *::* ]] || return 1
  IFS=: read -r -a segments <<< "${address//::/:}"
  for segment in "${segments[@]}"; do
    [[ -z "$segment" ]] && continue
    [[ "$segment" =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1
    segment_count=$((segment_count + 1))
  done
  if [[ "$address" == *::* ]]; then
    (( segment_count < 8 )) || return 1
  else
    (( segment_count == 8 )) || return 1
  fi
}

is_valid_cidr() {
  is_valid_ipv4_cidr "$1" || is_valid_ipv6_cidr "$1"
}

require_public_wss_real_ip_config() {
  local cidr normalized_cidrs
  local -a cidrs=()
  [[ "${PUBLIC_WSS_REAL_IP_MODE:-}" == cloudflare-tunnel || "${PUBLIC_WSS_REAL_IP_MODE:-}" == trusted-reverse-proxy ]] \
    || die "public WSS real-client-IP mode is not configured"
  [[ -n "${PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS:-}" \
    && "$PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS" != ,* \
    && "$PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS" != *, \
    && "$PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS" != *,,* \
    && "$PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS" != *192.0.2.* \
    && "$PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS" != *198.51.100.* \
    && "$PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS" != *203.0.113.* ]] \
    || die "public WSS trusted proxy/tunnel CIDRs remain unset or use a TEST-NET placeholder"
  normalized_cidrs="$(printf '%s' "$PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS" | tr '[:upper:]' '[:lower:]')"
  [[ "$normalized_cidrs" != *2001:db8:* ]] \
    || die "public WSS trusted proxy/tunnel CIDRs use the IPv6 documentation prefix"
  IFS=, read -r -a cidrs <<< "$PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS"
  ((${#cidrs[@]} > 0)) || die "public WSS trusted proxy/tunnel CIDR list is empty"
  for cidr in "${cidrs[@]}"; do
    is_valid_cidr "$cidr" || die "public WSS trusted proxy/tunnel CIDR is invalid: $cidr"
  done
}

compose() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" --file "$COMPOSE_FILE" "$@"
}

require_apply_confirmation() {
  local apply="$1" confirmation="$2"
  [[ "$apply" == true ]] || {
    note "DRY RUN: no mutation performed. Re-run with --apply --confirm $COMPOSE_PROJECT_NAME"
    return 1
  }
  [[ "$confirmation" == "$COMPOSE_PROJECT_NAME" ]] || die "confirmation must exactly equal $COMPOSE_PROJECT_NAME"
}

assert_owned_container_id() {
  local id="$1" service="$2" label project environment role
  label="$(docker inspect --format '{{ index .Config.Labels "com.project-conversation.stack" }}' "$id")"
  project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$id")"
  environment="$(docker inspect --format '{{ index .Config.Labels "com.project-conversation.environment" }}' "$id")"
  role="$(docker inspect --format '{{ index .Config.Labels "com.project-conversation.role" }}' "$id")"
  [[ "$label" == true && "$project" == "$COMPOSE_PROJECT_NAME" && "$environment" == "$DEPLOY_ENVIRONMENT" && "$role" == "$service" ]] || die "container ownership labels do not match the approved project, environment, and service"
}

owned_container_id() {
  local service="$1" id
  id="$(compose ps --quiet "$service")"
  [[ -n "$id" ]] || die "no running $service container in project $COMPOSE_PROJECT_NAME"
  assert_owned_container_id "$id" "$service"
  printf '%s\n' "$id"
}

assert_spacetimedb_mount() {
  local id="$1" source
  source="$(docker inspect --format '{{ range .Mounts }}{{ if eq .Destination "/stdb" }}{{ .Source }}{{ end }}{{ end }}' "$id")"
  [[ "$source" == "$SPACETIMEDB_DATA_DIR" ]] || die "container /stdb mount is not the approved data directory"
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

wait_healthy_status() {
  local service="$1" attempts="${2:-60}" id status
  for ((i=1; i<=attempts; i++)); do
    id="$(compose ps --quiet "$service")"
    if [[ -n "$id" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
      [[ "$status" == healthy ]] && return 0
      [[ "$status" == exited || "$status" == dead ]] && return 1
    fi
    sleep 2
  done
  return 1
}

wait_healthy() {
  local service="$1" attempts="${2:-60}"
  wait_healthy_status "$service" "$attempts" || die "$service did not become healthy"
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi
}

file_uid() {
  if stat -c '%u' "$1" >/dev/null 2>&1; then stat -c '%u' "$1"; else stat -f '%u' "$1"; fi
}

file_gid() {
  if stat -c '%g' "$1" >/dev/null 2>&1; then stat -c '%g' "$1"; else stat -f '%g' "$1"; fi
}

file_mtime() {
  if stat -c '%Y' "$1" >/dev/null 2>&1; then stat -c '%Y' "$1"; else stat -f '%m' "$1"; fi
}

assert_trusted_regular_file() {
  local file="$1" label="$2" mode owner logical_parent physical_parent
  [[ -f "$file" && ! -L "$file" ]] || die "$label must be a regular, non-symlink file: $file"
  logical_parent="$(cd -L -- "$(dirname -- "$file")" && pwd -L)"
  physical_parent="$(cd -P -- "$(dirname -- "$file")" && pwd -P)"
  [[ "$logical_parent" == "$physical_parent" ]] || die "$label path contains a symlinked parent: $file"
  mode="$(file_mode "$file")"
  owner="$(file_uid "$file")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "$label has an unreadable mode: $file"
  (( (8#$mode & 022) == 0 )) || die "$label must not be writable by group or other: $file (mode $mode)"
  [[ "$owner" == "$(id -u)" || "$owner" == 0 ]] || die "$label must be owned by the runtime operator or root: $file"
}

assert_private_regular_file() {
  local file="$1" label="$2" mode owner logical_parent physical_parent
  [[ -f "$file" && ! -L "$file" ]] || die "$label must be a regular, non-symlink file: $file"
  logical_parent="$(cd -L -- "$(dirname -- "$file")" && pwd -L)"
  physical_parent="$(cd -P -- "$(dirname -- "$file")" && pwd -P)"
  [[ "$logical_parent" == "$physical_parent" ]] || die "$label path contains a symlinked parent: $file"
  mode="$(file_mode "$file")"
  owner="$(file_uid "$file")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "$label has an unreadable mode: $file"
  (( (8#$mode & 077) == 0 )) || die "$label must not be accessible by group or other: $file (mode $mode)"
  [[ "$owner" == "$(id -u)" || "$owner" == 0 ]] || die "$label must be owned by the runtime operator or root: $file"
}

assert_trusted_directory() {
  local directory="$1" label="$2" private="${3:-false}" mode owner logical physical
  [[ -d "$directory" && ! -L "$directory" ]] || die "$label must be a real directory: $directory"
  logical="$(cd -L -- "$directory" && pwd -L)"; physical="$(cd -P -- "$directory" && pwd -P)"
  [[ "$logical" == "$physical" ]] || die "$label path contains a symlink component: $directory"
  mode="$(file_mode "$directory")"
  owner="$(file_uid "$directory")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "$label has an unreadable mode: $directory"
  if [[ "$private" == true ]]; then
    (( (8#$mode & 077) == 0 )) || die "$label must not be accessible by group or other: $directory (mode $mode)"
  else
    (( (8#$mode & 022) == 0 )) || die "$label must not be writable by group or other: $directory (mode $mode)"
  fi
  [[ "$owner" == "$(id -u)" || "$owner" == 0 ]] || die "$label must be owned by the runtime operator or root: $directory"
}

assert_container_state_directory() {
  local directory="$1" label="$2" expected_uid="${3:-10001}" mode owner logical physical
  [[ -d "$directory" && ! -L "$directory" ]] || die "$label must be a real directory: $directory"
  logical="$(cd -L -- "$directory" && pwd -L)"; physical="$(cd -P -- "$directory" && pwd -P)"
  [[ "$logical" == "$physical" ]] || die "$label path contains a symlink component: $directory"
  mode="$(file_mode "$directory")"; owner="$(file_uid "$directory")"
  [[ "$mode" == 700 || "$mode" == 0700 ]] || die "$label must have exact mode 0700: $directory"
  [[ "$owner" == "$expected_uid" ]] || die "$label must be owned by container uid $expected_uid: $directory"
}

assert_environment_path_chain() {
  local service_root="${1:-/srv}" environment="${2:-$DEPLOY_ENVIRONMENT}"
  [[ "$environment" == production || "$environment" == staging ]] || die "invalid environment path-chain identity"
  assert_trusted_directory "$service_root" "service root" false
  assert_trusted_directory "$service_root/project-conversation" "project-conversation root" false
  assert_trusted_directory "$service_root/project-conversation/$environment" "environment root" true
}

assert_not_future_mtime() {
  local file="$1" label="$2" now mtime
  now="$(date +%s)"
  mtime="$(file_mtime "$file")"
  [[ "$mtime" =~ ^[0-9]{1,10}$ ]] || die "$label has an invalid or out-of-range modification time"
  awk -v value="$mtime" -v current="$now" 'BEGIN { exit !(value <= current) }' \
    || die "$label has a future modification time"
}

utc_compact_to_epoch() {
  local value="$1" result
  [[ "$value" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  local readable="${value:0:4}-${value:4:2}-${value:6:2} ${value:9:2}:${value:11:2}:${value:13:2} UTC"
  if date -u -d "$readable" +%s >/dev/null 2>&1; then
    result="$(date -u -d "$readable" +%s)"
  else
    result="$(date -u -j -f '%Y%m%dT%H%M%SZ' "$value" +%s 2>/dev/null)" || return 1
  fi
  [[ "$result" =~ ^[0-9]{1,10}$ ]] || return 1
  printf '%s\n' "$result"
}

assert_epoch_utc_pair() {
  local epoch="$1" utc="$2" label="$3" parsed now
  [[ "$epoch" =~ ^[0-9]{1,10}$ ]] || die "$label epoch is invalid or out of the supported range"
  awk -v value="$epoch" 'BEGIN { exit !(value >= 0 && value <= 4102444800) }' \
    || die "$label epoch is outside 1970-2100"
  parsed="$(utc_compact_to_epoch "$utc")" || die "$label UTC timestamp is invalid"
  [[ "$parsed" == "$epoch" ]] || die "$label UTC timestamp and epoch disagree"
  now="$(date +%s)"
  awk -v value="$epoch" -v current="$now" 'BEGIN { exit !(value <= current) }' \
    || die "$label timestamp is in the future"
}

epoch_age_at_most() {
  local epoch="$1" maximum="$2" now
  [[ "$epoch" =~ ^[0-9]{1,10}$ && "$maximum" =~ ^[0-9]{1,10}$ ]] || return 1
  now="$(date +%s)"
  awk -v created="$epoch" -v current="$now" -v max="$maximum" \
    'BEGIN { exit !(created <= current && current - created <= max) }'
}

require_upgrade_backup_freshness() {
  local state_status="$1" created_epoch="$2"
  [[ "$state_status" == resume ]] && return 0
  epoch_age_at_most "$created_epoch" 86400 || die "signed backup creation time is older than 24 hours"
}

metadata_value() {
  local file="$1" key="$2" count
  count="$(awk -F= -v key="$key" '$1 == key { count++ } END { print count + 0 }' "$file")"
  [[ "$count" == 1 ]] || die "metadata must contain exactly one $key entry: $file"
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$file"
}

assert_metadata_keys() {
  local file="$1"; shift
  local allowed=" $* " line key seen=' '
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || die "invalid metadata line in $file"
    key="${line%%=*}"
    [[ "$key" =~ ^[a-z][a-z0-9_]*$ ]] || die "invalid metadata key in $file: $key"
    [[ "$allowed" == *" $key "* ]] || die "unexpected metadata key in $file: $key"
    [[ "$seen" != *" $key "* ]] || die "duplicate metadata key in $file: $key"
    seen+="$key "
  done < "$file"
  for key in "$@"; do
    [[ "$seen" == *" $key "* ]] || die "missing metadata key in $file: $key"
  done
}

write_checksum_sidecar() {
  local file="$1" checksum sidecar="$1.sha256"
  checksum="$(hash_file "$file")"
  printf '%s  %s\n' "$checksum" "$(basename -- "$file")" > "$sidecar.partial"
  chmod 600 "$sidecar.partial"
  mv -- "$sidecar.partial" "$sidecar"
}

verify_checksum_sidecar() {
  local file="$1" sidecar="${2:-$1.sha256}" publish="$1.publish" expected name extra actual
  assert_private_regular_file "$file" "checksummed record"
  actual="$(hash_file "$file")"
  if [[ -e "$sidecar" ]]; then
    assert_private_regular_file "$sidecar" "checksum sidecar"
    IFS=' ' read -r expected name extra < "$sidecar"
    if [[ "$expected" =~ ^[a-f0-9]{64}$ && "$name" == "$(basename -- "$file")" \
      && -z "${extra:-}" && "$actual" == "$expected" ]]; then
      printf '%s\n' "$actual"
      return 0
    fi
  fi
  if [[ -e "$publish" ]]; then
    assert_private_regular_file "$publish" "checksummed-record publication intent"
    IFS=' ' read -r expected name extra < "$publish"
    [[ "$expected" =~ ^[a-f0-9]{64}$ && "$name" == "$(basename -- "$file")" \
      && -z "${extra:-}" && "$actual" == "$expected" ]] \
      || die "publication intent does not match $file"
    note "Recovered verification from durable publication intent for $file; the next successful write will finalize its sidecar."
    printf '%s\n' "$actual"
    return 0
  fi
  die "checksum mismatch or missing recovery intent for $file"
}

publish_checksummed_record() {
  local partial="$1" file="$2" checksum publish="$2.publish"
  assert_private_regular_file "$partial" "checksummed-record partial"
  checksum="$(hash_file "$partial")"
  printf '%s  %s\n' "$checksum" "$(basename -- "$file")" > "$publish.partial"
  chmod 600 "$publish.partial"
  mv -- "$publish.partial" "$publish"
  mv -- "$partial" "$file"
  write_checksum_sidecar "$file"
  rm -f -- "$publish"
}

require_evidence_verify_key() {
  local public_text
  : "${BACKUP_EVIDENCE_VERIFY_KEY_FILE:?BACKUP_EVIDENCE_VERIFY_KEY_FILE is required}"
  assert_private_regular_file "$BACKUP_EVIDENCE_VERIFY_KEY_FILE" "backup evidence verification key"
  command -v openssl >/dev/null 2>&1 || die "OpenSSL is required for backup evidence verification"
  public_text="$(openssl pkey -pubin -in "$BACKUP_EVIDENCE_VERIFY_KEY_FILE" -text -noout 2>/dev/null)" \
    || die "backup evidence verification key is not a valid public key"
  grep -Fq 'ED25519 Public-Key:' <<< "$public_text" \
    || die "backup evidence verification key is not a valid public key"
}

require_evidence_signing_key() {
  local private_text
  require_evidence_verify_key
  : "${BACKUP_EVIDENCE_SIGNING_KEY_FILE:?BACKUP_EVIDENCE_SIGNING_KEY_FILE is required}"
  assert_private_regular_file "$BACKUP_EVIDENCE_SIGNING_KEY_FILE" "backup evidence signing key"
  private_text="$(openssl pkey -in "$BACKUP_EVIDENCE_SIGNING_KEY_FILE" -text -noout 2>/dev/null)" \
    || die "backup evidence signing key is not a valid private key"
  grep -Fq 'ED25519 Private-Key:' <<< "$private_text" \
    || die "backup evidence signing key is not a valid private key"
  cmp -s <(openssl pkey -in "$BACKUP_EVIDENCE_SIGNING_KEY_FILE" -pubout 2>/dev/null) \
    "$BACKUP_EVIDENCE_VERIFY_KEY_FILE" \
    || die "backup evidence signing and verification keys do not match"
}

verify_evidence_signature() {
  local file="$1" signature="$1.sig"
  require_evidence_verify_key
  assert_private_regular_file "$signature" "evidence signature"
  openssl pkeyutl -verify -pubin -inkey "$BACKUP_EVIDENCE_VERIFY_KEY_FILE" \
    -rawin -in "$file" -sigfile "$signature" >/dev/null 2>&1 \
    || die "evidence signature verification failed: $file"
}

sign_evidence_file() {
  local file="$1" signature="$1.sig"
  require_evidence_signing_key
  openssl pkeyutl -sign -inkey "$BACKUP_EVIDENCE_SIGNING_KEY_FILE" \
    -rawin -in "$file" -out "$signature.partial" >/dev/null 2>&1 \
    || die "unable to sign evidence file: $file"
  chmod 600 "$signature.partial"
  mv -- "$signature.partial" "$signature"
  verify_evidence_signature "$file"
}

deployment_state_dir() {
  printf '%s/state\n' "$(dirname -- "$SPACETIMEDB_DATA_DIR")"
}

deployment_service_root() {
  local suffix="/project-conversation/$DEPLOY_ENVIRONMENT/spacetime"
  [[ "$SPACETIMEDB_DATA_DIR" == *"$suffix" ]] || die "cannot derive the fixed service root from the SpacetimeDB data path"
  printf '%s\n' "${SPACETIMEDB_DATA_DIR%"$suffix"}"
}

reviewed_image_pin_file() {
  printf '%s/spacetimedb-image-pin.env\n' "$(deployment_state_dir)"
}

require_state_dir() {
  local state_dir service_root
  service_root="$(deployment_service_root)"
  assert_environment_path_chain "$service_root" "$DEPLOY_ENVIRONMENT"
  state_dir="$(deployment_state_dir)"
  assert_trusted_directory "$state_dir" "state directory" true
  [[ -w "$state_dir" ]] || die "pre-provisioned state directory is not writable: $state_dir"
}

acquire_operations_lock() {
  local lock_file
  require_state_dir
  command -v flock >/dev/null 2>&1 || die "flock is required for mutating operations"
  lock_file="$(deployment_state_dir)/operations.lock"
  umask 077
  exec 9>"$lock_file"
  chmod 600 "$lock_file"
  [[ "$(file_uid "$lock_file")" == "$(id -u)" || "$(file_uid "$lock_file")" == 0 ]] \
    || die "operations lock is not owned by the runtime operator or root"
  flock -n 9 || die "another project-conversation operation is already active for $COMPOSE_PROJECT_NAME"
  OPERATIONS_LOCK_FILE="$lock_file"
  export OPERATIONS_LOCK_FILE
}

load_reviewed_spacetimedb_image_pin() {
  local required="${1:-false}" checksum
  REVIEWED_IMAGE_PIN_FILE="$(reviewed_image_pin_file)"
  if [[ ! -e "$REVIEWED_IMAGE_PIN_FILE" ]]; then
    [[ "$required" != true ]] || die "reviewed SpacetimeDB image pin is missing: $REVIEWED_IMAGE_PIN_FILE"
    return 1
  fi
  assert_private_regular_file "$REVIEWED_IMAGE_PIN_FILE" "reviewed image pin"
  checksum="$(verify_checksum_sidecar "$REVIEWED_IMAGE_PIN_FILE")"
  assert_metadata_keys "$REVIEWED_IMAGE_PIN_FILE" \
    format recorded_utc recorded_epoch compose_project environment spacetimedb_image reason transition_id
  [[ "$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" format)" == project-conversation-spacetimedb-image-pin-v2 ]] \
    || die "reviewed image pin format is unsupported"
  assert_epoch_utc_pair \
    "$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" recorded_epoch)" \
    "$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" recorded_utc)" \
    "reviewed image pin"
  [[ "$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" compose_project)" == "$COMPOSE_PROJECT_NAME" ]] \
    || die "reviewed image pin belongs to another Compose project"
  [[ "$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" environment)" == "$DEPLOY_ENVIRONMENT" ]] \
    || die "reviewed image pin belongs to another environment"
  SPACETIMEDB_IMAGE="$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" spacetimedb_image)"
  assert_immutable_image "$SPACETIMEDB_IMAGE" REVIEWED_SPACETIMEDB_IMAGE
  export SPACETIMEDB_IMAGE
  REVIEWED_IMAGE_PIN_SHA256="$checksum"
  export REVIEWED_IMAGE_PIN_FILE REVIEWED_IMAGE_PIN_SHA256
}

record_reviewed_spacetimedb_image_pin() {
  local image="$1" reason="$2" transition_id="${3:-standalone}" pin recorded_utc recorded_epoch
  assert_immutable_image "$image" REVIEWED_SPACETIMEDB_IMAGE
  [[ "$reason" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || die "invalid reviewed-image reason"
  [[ "$transition_id" =~ ^[a-zA-Z0-9._:-]{1,128}$ ]] || die "invalid image transition identifier"
  require_state_dir
  pin="$(reviewed_image_pin_file)"
  recorded_utc="$(date -u +%Y%m%dT%H%M%SZ)"
  recorded_epoch="$(utc_compact_to_epoch "$recorded_utc")"
  umask 077
  {
    printf 'format=project-conversation-spacetimedb-image-pin-v2\n'
    printf 'recorded_utc=%s\n' "$recorded_utc"
    printf 'recorded_epoch=%s\n' "$recorded_epoch"
    printf 'compose_project=%s\n' "$COMPOSE_PROJECT_NAME"
    printf 'environment=%s\n' "$DEPLOY_ENVIRONMENT"
    printf 'spacetimedb_image=%s\n' "$image"
    printf 'reason=%s\n' "$reason"
    printf 'transition_id=%s\n' "$transition_id"
  } > "$pin.partial"
  chmod 600 "$pin.partial"
  publish_checksummed_record "$pin.partial" "$pin"
  load_reviewed_spacetimedb_image_pin true >/dev/null
}

validate_backup_bundle() {
  local archive="$1" expected_project="$2" expected_environment="$3"
  local manifest="$archive.manifest" checksum manifest_checksum archive_name created_epoch now root_uid root_gid root_mode
  assert_private_regular_file "$archive" "backup archive"
  assert_not_future_mtime "$archive" "backup archive"
  checksum="$(verify_checksum_sidecar "$archive")"
  assert_private_regular_file "$manifest" "backup manifest"
  assert_not_future_mtime "$manifest" "backup manifest"
  manifest_checksum="$(verify_checksum_sidecar "$manifest")"
  verify_evidence_signature "$manifest"
  assert_metadata_keys "$manifest" \
    format created_utc created_epoch archive compose_project environment spacetimedb_image \
    image_pin_sha256 evidence_verify_key_sha256 archive_sha256 data_root_uid data_root_gid data_root_mode
  [[ "$(metadata_value "$manifest" format)" == project-conversation-spacetimedb-cold-backup-v3 ]] \
    || die "backup manifest format is unsupported"
  archive_name="$(metadata_value "$manifest" archive)"
  [[ "$archive_name" == "$(basename -- "$archive")" ]] || die "backup manifest names another archive"
  [[ "$(metadata_value "$manifest" compose_project)" == "$expected_project" ]] \
    || die "backup manifest belongs to another Compose project"
  [[ "$(metadata_value "$manifest" environment)" == "$expected_environment" ]] \
    || die "backup manifest belongs to another environment"
  [[ "$(metadata_value "$manifest" archive_sha256)" == "$checksum" ]] \
    || die "backup manifest checksum does not match the archive"
  created_epoch="$(metadata_value "$manifest" created_epoch)"
  assert_epoch_utc_pair "$created_epoch" "$(metadata_value "$manifest" created_utc)" "backup manifest creation"
  root_uid="$(metadata_value "$manifest" data_root_uid)"
  root_gid="$(metadata_value "$manifest" data_root_gid)"
  root_mode="$(metadata_value "$manifest" data_root_mode)"
  [[ "$root_uid" =~ ^[0-9]+$ && "$root_gid" =~ ^[0-9]+$ && "$root_mode" =~ ^[0-7]{3,4}$ ]] \
    || die "backup data-root ownership or mode metadata is invalid"
  (( (8#$root_mode & 002) == 0 )) || die "backup data-root mode is world-writable"
  BACKUP_BUNDLE_IMAGE="$(metadata_value "$manifest" spacetimedb_image)"
  assert_immutable_image "$BACKUP_BUNDLE_IMAGE" BACKUP_SPACETIMEDB_IMAGE
  BACKUP_BUNDLE_PIN_SHA256="$(metadata_value "$manifest" image_pin_sha256)"
  [[ "$BACKUP_BUNDLE_PIN_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "backup image-pin provenance is invalid"
  BACKUP_BUNDLE_VERIFY_KEY_SHA256="$(metadata_value "$manifest" evidence_verify_key_sha256)"
  [[ "$BACKUP_BUNDLE_VERIFY_KEY_SHA256" == "$(hash_file "$BACKUP_EVIDENCE_VERIFY_KEY_FILE")" ]] \
    || die "backup evidence verification-key provenance is invalid"
  BACKUP_BUNDLE_CHECKSUM="$checksum"
  BACKUP_BUNDLE_MANIFEST_SHA256="$manifest_checksum"
  BACKUP_BUNDLE_MANIFEST="$manifest"
  BACKUP_BUNDLE_CREATED_EPOCH="$created_epoch"
  export BACKUP_BUNDLE_IMAGE BACKUP_BUNDLE_PIN_SHA256 BACKUP_BUNDLE_CHECKSUM \
    BACKUP_BUNDLE_MANIFEST_SHA256 BACKUP_BUNDLE_MANIFEST BACKUP_BUNDLE_VERIFY_KEY_SHA256 \
    BACKUP_BUNDLE_CREATED_EPOCH
}

validate_restored_state_verification() {
  local record="$1" expected_identity="$2" expected_initial_program_hash="$3" expected_schema_sha256="$4"
  assert_private_regular_file "$record" "restored-state verification record"
  assert_metadata_keys "$record" \
    format database_identity initial_program_hash current_module_code module_schema_sha256 required_private_tables \
    required_private_table_count domain_invariants domain_invariant_count \
    outbox_lease_recovery_shape audit_continuity deletion_lifecycle_overlay \
    traffic_eligible result
  [[ "$(metadata_value "$record" format)" == project-conversation-restored-state-verification-v1 ]] \
    || die "restored-state verification format is unsupported"
  [[ "$(metadata_value "$record" database_identity)" == "$expected_identity" ]] \
    || die "restored-state verification names another database identity"
  [[ "$(metadata_value "$record" initial_program_hash)" == "$expected_initial_program_hash" ]] \
    || die "restored-state initialization provenance differs from the reviewed hash"
  [[ "$(metadata_value "$record" current_module_code)" == NotVerified ]] \
    || die "restored-state evidence must not claim current module code verification"
  [[ "$(metadata_value "$record" module_schema_sha256)" == "$expected_schema_sha256" ]] \
    || die "restored-state module/schema identity differs from the reviewed digest"
  [[ "$(metadata_value "$record" required_private_tables)" == Pass \
    && "$(metadata_value "$record" required_private_table_count)" == 78 ]] \
    || die "restored-state required private-table verification did not pass"
  [[ "$(metadata_value "$record" domain_invariants)" == Pass \
    && "$(metadata_value "$record" domain_invariant_count)" == 90 ]] \
    || die "restored-state domain invariants did not pass"
  [[ "$(metadata_value "$record" outbox_lease_recovery_shape)" == NotVerified ]] \
    || die "restored-state evidence must not claim outbox lease recovery verification"
  [[ "$(metadata_value "$record" audit_continuity)" == BoundedReferentialOnly ]] \
    || die "restored-state audit evidence overclaims or omits its bounded scope"
  [[ "$(metadata_value "$record" deletion_lifecycle_overlay)" == NotConfigured ]] \
    || die "restored-state deletion lifecycle overlay status is invalid"
  [[ "$(metadata_value "$record" traffic_eligible)" == false ]] \
    || die "bounded restored-state evidence must remain ineligible for traffic"
  [[ "$(metadata_value "$record" result)" == BoundedRestoreStateVerified ]] \
    || die "restored-state verification result is invalid"
}

validate_restore_marker() {
  local marker="$1" archive="$2" expected_project="$3" expected_environment="$4" expected_restore_image="$5"
  local marker_checksum completed_epoch
  assert_private_regular_file "$marker" "restore marker"
  assert_not_future_mtime "$marker" "restore marker"
  marker_checksum="$(verify_checksum_sidecar "$marker")"
  verify_evidence_signature "$marker"
  assert_metadata_keys "$marker" \
    format completed_utc completed_epoch compose_project source_environment archive \
    archive_sha256 backup_manifest_sha256 evidence_verify_key_sha256 source_spacetimedb_image restore_spacetimedb_image \
    ownership_mode database_identity initial_program_hash current_module_code module_schema_sha256 restored_state_verification \
    required_private_tables required_private_table_count domain_invariants domain_invariant_count \
    outbox_lease_recovery_shape audit_continuity deletion_lifecycle_overlay object_inventory \
    search_rebuild provider_checks traffic_eligible teardown upgrade_eligible result
  [[ "$(metadata_value "$marker" format)" == project-conversation-restore-drill-v4 ]] \
    || die "restore marker format is unsupported"
  [[ "$(metadata_value "$marker" compose_project)" == "$expected_project" ]] \
    || die "restore marker belongs to another Compose project"
  [[ "$(metadata_value "$marker" source_environment)" == "$expected_environment" ]] \
    || die "restore marker belongs to another environment"
  [[ "$(metadata_value "$marker" archive)" == "$(basename -- "$archive")" ]] \
    || die "restore marker names another archive"
  [[ "$(metadata_value "$marker" archive_sha256)" == "$BACKUP_BUNDLE_CHECKSUM" ]] \
    || die "restore marker archive checksum linkage is invalid"
  [[ "$(metadata_value "$marker" backup_manifest_sha256)" == "$BACKUP_BUNDLE_MANIFEST_SHA256" ]] \
    || die "restore marker backup-manifest linkage is invalid"
  [[ "$(metadata_value "$marker" evidence_verify_key_sha256)" == "$BACKUP_BUNDLE_VERIFY_KEY_SHA256" ]] \
    || die "restore marker verification-key linkage is invalid"
  [[ "$(metadata_value "$marker" source_spacetimedb_image)" == "$BACKUP_BUNDLE_IMAGE" ]] \
    || die "restore marker source-image provenance is invalid"
  [[ "$(metadata_value "$marker" restore_spacetimedb_image)" == "$expected_restore_image" ]] \
    || die "restore marker did not exercise the requested image"
  [[ "$(metadata_value "$marker" ownership_mode)" == operator-remapped-modes-preserved ]] \
    || die "restore marker ownership/mode evidence is invalid"
  [[ "$(metadata_value "$marker" database_identity)" == "$SPACETIMEDB_DATABASE_IDENTITY" \
    && "$(metadata_value "$marker" initial_program_hash)" == "$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH" \
    && "$(metadata_value "$marker" current_module_code)" == NotVerified \
    && "$(metadata_value "$marker" module_schema_sha256)" == "$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256" \
    && "$(metadata_value "$marker" restored_state_verification)" == Pass ]] \
    || die "restore marker initialization/schema identity evidence is invalid"
  [[ "$(metadata_value "$marker" required_private_tables)" == Pass \
    && "$(metadata_value "$marker" required_private_table_count)" == 78 \
    && "$(metadata_value "$marker" domain_invariants)" == Pass \
    && "$(metadata_value "$marker" domain_invariant_count)" == 90 \
    && "$(metadata_value "$marker" outbox_lease_recovery_shape)" == NotVerified ]] \
    || die "restore marker bounded invariant evidence is invalid"
  [[ "$(metadata_value "$marker" audit_continuity)" == BoundedReferentialOnly \
    && "$(metadata_value "$marker" deletion_lifecycle_overlay)" == NotConfigured \
    && "$(metadata_value "$marker" object_inventory)" == NotConfigured \
    && "$(metadata_value "$marker" search_rebuild)" == NotConfigured \
    && "$(metadata_value "$marker" provider_checks)" == NotConfigured \
    && "$(metadata_value "$marker" traffic_eligible)" == false ]] \
    || die "restore marker must retain explicit partial/not-traffic-eligible scope"
  [[ "$(metadata_value "$marker" teardown)" == completed ]] \
    || die "restore marker does not prove isolated project teardown"
  [[ "$(metadata_value "$marker" upgrade_eligible)" == false ]] \
    || die "bounded restored-state marker must not authorize a live upgrade"
  [[ "$(metadata_value "$marker" result)" == bounded-restored-state-not-traffic-eligible ]] \
    || die "restore marker result is invalid"
  completed_epoch="$(metadata_value "$marker" completed_epoch)"
  assert_epoch_utc_pair "$completed_epoch" "$(metadata_value "$marker" completed_utc)" "restore marker completion"
  awk -v completed="$completed_epoch" -v created="$BACKUP_BUNDLE_CREATED_EPOCH" \
    'BEGIN { exit !(completed >= created) }' || die "restore marker predates its signed backup creation"
  RESTORE_MARKER_SHA256="$marker_checksum"
  export RESTORE_MARKER_SHA256
}
