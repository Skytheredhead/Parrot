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
      printf 'Usage: %s [--env-file PATH] [--runtime] [--profile gateway|telemetry]\n' "$0"
      exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

for profile in ${profiles[@]+"${profiles[@]}"}; do
  [[ "$profile" == gateway || "$profile" == telemetry ]] || die "profile is not deployable: $profile"
done

if [[ "$mode" == runtime ]]; then load_env_file "$env_file" true; else load_env_file "$env_file" false; fi
require_base_identity
[[ "${OTEL_COLLECTOR_IMAGE:-}" == "$EXPECTED_OTEL_IMAGE" ]] || die "OpenTelemetry collector image differs from the recorded digest"

if [[ "$mode" == runtime ]]; then
  assert_environment_path_chain /srv "$DEPLOY_ENVIRONMENT"
  assert_trusted_directory "$SPACETIMEDB_DATA_DIR" "SpacetimeDB data directory" true
  assert_trusted_directory "$BACKUP_DIR" "backup directory" true
  [[ -w "$SPACETIMEDB_DATA_DIR" && -w "$BACKUP_DIR" ]] || die "data and backup directories must be writable"
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
      telemetry)
        [[ "$OTEL_EXPORTER_OTLP_ENDPOINT" != *example.invalid* ]] || die "telemetry destination still contains a placeholder"
        ;;
    esac
  done
else
  [[ "${SPACETIMEDB_IMAGE:-}" == "$EXPECTED_SPACETIMEDB_IMAGE" ]] || die "baseline SpacetimeDB image differs from the audited 2.6.1 Linux/amd64 digest"
fi

args=(config --quiet)
for profile in ${profiles[@]+"${profiles[@]}"}; do args=(--profile "$profile" "${args[@]}"); done
compose "${args[@]}"
profile_summary="${profiles[*]-}"
note "Configuration is valid in $mode mode for $COMPOSE_PROJECT_NAME${profile_summary:+ (profiles: $profile_summary)}."
