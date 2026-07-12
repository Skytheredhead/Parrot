#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

env_file="$INFRA_DIR/env/validation.env"
mode=static
profiles=()
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || die "--env-file requires a path"; env_file="$2"; shift 2 ;;
    --runtime) mode=runtime; shift ;;
    --profile) [[ $# -ge 2 ]] || die "--profile requires a name"; profiles+=("$2"); shift 2 ;;
    -h|--help)
      printf 'Usage: %s [--env-file PATH] [--runtime] [--profile gateway|edge|worker|scanner|telemetry]\n' "$0"
      exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

for profile in ${profiles[@]+"${profiles[@]}"}; do
  [[ "$profile" == gateway || "$profile" == edge || "$profile" == worker \
    || "$profile" == scanner || "$profile" == telemetry ]] || die "profile is not deployable: $profile"
done

if [[ "$mode" == runtime ]]; then load_env_file "$env_file" true; else load_env_file "$env_file" false; fi
require_base_identity
[[ "${OTEL_COLLECTOR_IMAGE:-}" == "$EXPECTED_OTEL_IMAGE" ]] || die "OpenTelemetry collector image differs from the recorded digest"

if [[ "$mode" == runtime ]]; then
  assert_environment_path_chain /srv "$DEPLOY_ENVIRONMENT"
  assert_environment_path_chain /mnt/bigboi "$DEPLOY_ENVIRONMENT"
  assert_trusted_directory "$SPACETIMEDB_DATA_DIR" "SpacetimeDB data directory" true
  assert_trusted_directory "$BACKUP_DIR" "backup directory" true
  for state_path in "$GATEWAY_STATE_DIR" "$WORKER_STATE_DIR" "$OBJECT_DATA_DIR" "$EXPORT_DATA_DIR" "$OLLAMA_BRIDGE_DIR"; do
    assert_container_state_directory "$state_path" "provider state directory"
  done
  [[ -w "$SPACETIMEDB_DATA_DIR" && -w "$BACKUP_DIR" ]] \
    || die "data and backup directories must be writable"
  require_state_dir
  load_reviewed_spacetimedb_image_pin false >/dev/null || \
    [[ "$SPACETIMEDB_IMAGE" == "$EXPECTED_SPACETIMEDB_IMAGE" ]] \
    || die "an initial deployment must use the audited baseline image"
  assert_trusted_regular_file "$OTEL_CONFIG_PATH" "OTel config"
  [[ -r "$OTEL_CONFIG_PATH" ]] || die "OTel config is not readable"
  for profile in ${profiles[@]+"${profiles[@]}"}; do
    case "$profile" in
      gateway)
        assert_immutable_image "$GATEWAY_IMAGE" GATEWAY_IMAGE
        [[ -r "$GATEWAY_READINESS_TOKEN_FILE" && ! -L "$GATEWAY_READINESS_TOKEN_FILE" ]] || die "gateway readiness secret must be a non-symlink readable file"
        assert_private_regular_file "$GATEWAY_READINESS_TOKEN_FILE" "gateway readiness secret"
        assert_private_regular_file "$OBJECT_CAPABILITY_HMAC_SECRET_FILE" "object capability HMAC secret"
        [[ "$(wc -c < "$OBJECT_CAPABILITY_HMAC_SECRET_FILE")" -ge 32 ]] || die "object capability HMAC secret is too short"
        [[ "$GATEWAY_ADAPTER_MODULE" != /app/adapter/index.js ]] || die "gateway adapter remains the unimplemented placeholder"
        [[ -n "$TRUSTED_PROXY_CIDRS" && "$TRUSTED_PROXY_CIDRS" != *192.0.2.* ]] || die "gateway trusted-proxy CIDRs remain unset or use the TEST-NET placeholder"
        require_public_wss_real_ip_config
        [[ "$ALLOWED_ORIGINS" != *example.invalid* \
          && "$OIDC_ISSUER" != *example.invalid* \
          && "$OIDC_JWKS_URI" != *example.invalid* \
          && "$AGENT_STREAM_ORIGINS" != *example.invalid* \
          && "$FILE_CAPABILITY_ORIGINS" != *example.invalid* ]] \
          || die "gateway provider/domain configuration still contains placeholders"
        ;;
      edge)
        [[ "$EDGE_IMAGE" == "$EXPECTED_EDGE_IMAGE" ]] || die "edge image differs from the recorded Linux/amd64 digest"
        [[ "$EDGE_SERVER_NAME" != *example.invalid ]] || die "edge server name still contains a placeholder"
        assert_immutable_image "$GATEWAY_IMAGE" GATEWAY_IMAGE
        [[ "$GATEWAY_ADAPTER_MODULE" != /app/adapter/index.js ]] || die "edge requires a gateway with a production adapter"
        assert_trusted_regular_file "$EDGE_CONFIG_TEMPLATE_PATH" "edge Nginx configuration template"
        [[ -r "$EDGE_CONFIG_TEMPLATE_PATH" ]] || die "edge Nginx configuration template is not readable"
        grep -Fq 'location = /v1/database/${SPACETIMEDB_DATABASE_NAME}/subscribe' "$EDGE_CONFIG_TEMPLATE_PATH" \
          || die "edge configuration lacks the exact database subscription allowlist"
        ;;
      worker)
        assert_immutable_image "$WORKER_IMAGE" WORKER_IMAGE
        [[ "$SOCAT_IMAGE" == "$EXPECTED_SOCAT_IMAGE" ]] || die "Ollama loopback image differs from the recorded Linux/amd64 digest"
        [[ "$OLLAMA_MODEL" != REPLACE_* ]] || die "Ollama model remains an unreviewed placeholder"
        assert_trusted_regular_file "$CLAMAV_CONFIG_PATH" "ClamAV configuration"
        [[ -S "$OLLAMA_BRIDGE_DIR/ollama.sock" ]] || die "worker remains fail-closed until the native Ollama Unix bridge is active"
        [[ "$WORKER_ADAPTER_MODULE" =~ ^/app/[A-Za-z0-9._/-]{1,900}\.(js|mjs)$ \
          && "$WORKER_ADAPTER_MODULE" != /app/adapter/index.js ]] \
          || die "worker adapter module remains missing or uses the unimplemented placeholder"
        ;;
      scanner)
        [[ "$CLAMAV_IMAGE" == "$EXPECTED_CLAMAV_IMAGE" ]] || die "ClamAV image differs from the recorded Linux/amd64 digest"
        ;;
      telemetry)
        [[ "$OTEL_EXPORTER_OTLP_ENDPOINT" != *example.invalid* ]] || die "telemetry destination still contains a placeholder"
        ;;
    esac
  done
else
  [[ "${SPACETIMEDB_IMAGE:-}" == "$EXPECTED_SPACETIMEDB_IMAGE" ]] || die "baseline SpacetimeDB image differs from the audited 2.6.1 Linux/amd64 digest"
  [[ "${EDGE_IMAGE:-}" == "$EXPECTED_EDGE_IMAGE" ]] || die "baseline edge image differs from the recorded Linux/amd64 digest"
  [[ "${CLAMAV_IMAGE:-}" == "$EXPECTED_CLAMAV_IMAGE" ]] || die "baseline ClamAV image differs from the recorded Linux/amd64 digest"
  [[ "${SOCAT_IMAGE:-}" == "$EXPECTED_SOCAT_IMAGE" ]] || die "baseline Ollama loopback image differs from the recorded Linux/amd64 digest"
fi

args=(config --quiet)
for profile in ${profiles[@]+"${profiles[@]}"}; do args=(--profile "$profile" "${args[@]}"); done
compose "${args[@]}"
profile_summary="${profiles[*]-}"
note "Configuration is valid in $mode mode for $COMPOSE_PROJECT_NAME${profile_summary:+ (profiles: $profile_summary)}."
