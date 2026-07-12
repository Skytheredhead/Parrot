#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

env_file=""; apply=false; confirmation=""; with_gateway=false; with_edge=false
with_worker=false; with_scanner=false; with_telemetry=false
reconcile_gateway=false; accept_current_gateway_config=false
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || die "--env-file requires a path"; env_file="$2"; shift 2 ;;
    --with-gateway) with_gateway=true; shift ;;
    --with-edge) with_edge=true; with_gateway=true; shift ;;
    --with-worker) with_worker=true; shift ;;
    --with-scanner) with_scanner=true; shift ;;
    --with-telemetry) with_telemetry=true; shift ;;
    --reconcile-gateway) reconcile_gateway=true; with_gateway=true; shift ;;
    --accept-current-gateway-config) accept_current_gateway_config=true; shift ;;
    --apply) apply=true; shift ;;
    --confirm) [[ $# -ge 2 ]] || die "--confirm requires a value"; confirmation="$2"; shift 2 ;;
    -h|--help)
      printf 'Usage: %s --env-file PATH [--with-gateway] [--with-edge] [--with-worker] [--with-scanner] [--with-telemetry] [--reconcile-gateway --accept-current-gateway-config] [--apply --confirm PROJECT]\n' "$0"
      exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$env_file" ]] || die "--env-file is required"
load_env_file "$env_file" true
require_base_identity
profiles=(); services=(spacetimedb)
$with_gateway && profiles+=(gateway) && services+=(gateway)
$with_edge && profiles+=(edge) && services+=(edge)
if $with_worker; then
  profiles+=(worker)
  services+=(clamav worker ollama-loopback)
elif $with_scanner; then
  profiles+=(scanner)
  services+=(clamav)
fi
$with_telemetry && profiles+=(telemetry) && services+=(otel-collector)

if [[ "$reconcile_gateway" == true ]]; then
  note "Plan: reconcile a persisted gateway deployment journal after independent staging/config review; no prior configuration is reconstructed."
else
  note "Plan: deploy only ${services[*]} in Compose project $COMPOSE_PROJECT_NAME."
fi
note "No module publication, host Nginx, Cloudflare tunnel, firewall, DNS, or unrelated service is in scope."
require_apply_confirmation "$apply" "$confirmation" || exit 0
acquire_operations_lock

preflight=("$SCRIPT_DIR/preflight.sh" --env-file "$env_file")
for profile in ${profiles[@]+"${profiles[@]}"}; do preflight+=(--profile "$profile"); done
"${preflight[@]}"
pin_was_present=false
if load_reviewed_spacetimedb_image_pin false >/dev/null; then pin_was_present=true; fi
profile_args=()
for profile in ${profiles[@]+"${profiles[@]}"}; do profile_args+=(--profile "$profile"); done

gateway_state_file="$(deployment_state_dir)/gateway-deploy.env"
gateway_phase=""; gateway_prior_present=""; gateway_prior_running=""; gateway_prior_image=""
gateway_target_image=""; gateway_target_env_sha256=""; gateway_transition_id=""

load_gateway_state() {
  [[ -e "$gateway_state_file" ]] || return 1
  assert_private_regular_file "$gateway_state_file" "gateway deployment journal"
  verify_checksum_sidecar "$gateway_state_file" >/dev/null
  assert_metadata_keys "$gateway_state_file" format recorded_utc recorded_epoch compose_project environment \
    transition_id phase prior_present prior_running prior_image target_image target_env_sha256
  [[ "$(metadata_value "$gateway_state_file" format)" == project-conversation-gateway-deploy-state-v2 ]] \
    || die "gateway deployment journal format is unsupported"
  [[ "$(metadata_value "$gateway_state_file" compose_project)" == "$COMPOSE_PROJECT_NAME" \
    && "$(metadata_value "$gateway_state_file" environment)" == "$DEPLOY_ENVIRONMENT" ]] \
    || die "gateway deployment journal belongs to another project/environment"
  assert_epoch_utc_pair "$(metadata_value "$gateway_state_file" recorded_epoch)" \
    "$(metadata_value "$gateway_state_file" recorded_utc)" "gateway deployment journal"
  gateway_transition_id="$(metadata_value "$gateway_state_file" transition_id)"
  gateway_phase="$(metadata_value "$gateway_state_file" phase)"
  gateway_prior_present="$(metadata_value "$gateway_state_file" prior_present)"
  gateway_prior_running="$(metadata_value "$gateway_state_file" prior_running)"
  gateway_prior_image="$(metadata_value "$gateway_state_file" prior_image)"
  gateway_target_image="$(metadata_value "$gateway_state_file" target_image)"
  gateway_target_env_sha256="$(metadata_value "$gateway_state_file" target_env_sha256)"
  [[ "$gateway_transition_id" =~ ^gateway-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]] || die "invalid gateway transition id"
  [[ "$gateway_phase" == prepared || "$gateway_phase" == applied || "$gateway_phase" == committed || "$gateway_phase" == abandoned ]] \
    || die "invalid gateway deployment phase"
  [[ "$gateway_prior_present" == true || "$gateway_prior_present" == false ]] || die "invalid prior gateway presence"
  [[ "$gateway_prior_running" == true || "$gateway_prior_running" == false ]] || die "invalid prior gateway running state"
  [[ "$gateway_target_env_sha256" =~ ^[a-f0-9]{64}$ ]] || die "invalid target environment checksum"
  assert_immutable_image "$gateway_target_image" TARGET_GATEWAY_IMAGE
  if [[ "$gateway_prior_present" == true ]]; then assert_immutable_image "$gateway_prior_image" PRIOR_GATEWAY_IMAGE; else [[ "$gateway_prior_image" == none ]] || die "invalid absent prior image"; fi
}

write_gateway_state() {
  local phase="$1" recorded_utc recorded_epoch
  recorded_utc="$(date -u +%Y%m%dT%H%M%SZ)"; recorded_epoch="$(utc_compact_to_epoch "$recorded_utc")"
  umask 077
  {
    printf 'format=project-conversation-gateway-deploy-state-v2\n'
    printf 'recorded_utc=%s\n' "$recorded_utc"
    printf 'recorded_epoch=%s\n' "$recorded_epoch"
    printf 'compose_project=%s\n' "$COMPOSE_PROJECT_NAME"
    printf 'environment=%s\n' "$DEPLOY_ENVIRONMENT"
    printf 'transition_id=%s\n' "$gateway_transition_id"
    printf 'phase=%s\n' "$phase"
    printf 'prior_present=%s\n' "$gateway_prior_present"
    printf 'prior_running=%s\n' "$gateway_prior_running"
    printf 'prior_image=%s\n' "$gateway_prior_image"
    printf 'target_image=%s\n' "$gateway_target_image"
    printf 'target_env_sha256=%s\n' "$gateway_target_env_sha256"
  } > "$gateway_state_file.partial"
  chmod 600 "$gateway_state_file.partial"
  publish_checksummed_record "$gateway_state_file.partial" "$gateway_state_file"
  gateway_phase="$phase"
}

if [[ "$reconcile_gateway" == true ]]; then
  load_gateway_state || die "no gateway deployment journal exists"
  [[ "$gateway_phase" != committed && "$gateway_phase" != abandoned ]] \
    || die "gateway journal is already terminal: $gateway_phase"
  [[ "$accept_current_gateway_config" == true ]] \
    || die "--accept-current-gateway-config is required after independently verifying the staged environment and current container configuration"
  [[ "$(hash_file "$ENV_FILE")" == "$gateway_target_env_sha256" ]] \
    || die "the supplied environment file is not the exact staged target recorded by the gateway journal"
  gateway_id="$(compose --profile gateway ps --all --quiet gateway)"
  [[ "$gateway_id" != *$'\n'* ]] || die "multiple gateway containers found"
  if [[ -n "$gateway_id" ]]; then
    assert_owned_container_id "$gateway_id" gateway
    current_image="$(docker inspect --format '{{.Config.Image}}' "$gateway_id")"
    current_running="$(docker inspect --format '{{.State.Running}}' "$gateway_id")"
  else
    current_image=none; current_running=false
  fi
  if [[ "$current_image" == "$gateway_target_image" && "$current_running" == true ]] && wait_healthy_status gateway; then
    write_gateway_state committed
    note "Gateway journal committed to the independently accepted current target configuration."
    exit 0
  fi
  if [[ "$gateway_phase" == prepared && "$current_image" == "$gateway_prior_image" ]]; then
    write_gateway_state abandoned
    note "Gateway journal marked abandoned because the recorded prior image is still present. No configuration was reconstructed."
    exit 0
  fi
  if [[ "$gateway_prior_present" == false && "$current_image" == none && "$current_running" == false ]]; then
    write_gateway_state abandoned
    note "Gateway journal marked abandoned after confirming the failed first deployment left no gateway container."
    exit 0
  fi
  die "gateway state is neither a healthy target nor the untouched recorded prior image; repair in staging before any new deployment"
fi

if [[ "$with_gateway" == true ]]; then
  if load_gateway_state; then
    [[ "$gateway_phase" == committed || "$gateway_phase" == abandoned ]] \
      || die "incomplete gateway journal ($gateway_phase); run explicit --reconcile-gateway after staging/config review"
  fi
  assert_immutable_image "$GATEWAY_IMAGE" GATEWAY_IMAGE
  gateway_prior_id="$(compose --profile gateway ps --all --quiet gateway)"
  [[ "$gateway_prior_id" != *$'\n'* ]] || die "multiple gateway containers found"
  gateway_prior_present=false; gateway_prior_running=false; gateway_prior_image=none
  if [[ -n "$gateway_prior_id" ]]; then
    assert_owned_container_id "$gateway_prior_id" gateway
    gateway_prior_present=true
    gateway_prior_image="$(docker inspect --format '{{.Config.Image}}' "$gateway_prior_id")"
    gateway_prior_running="$(docker inspect --format '{{.State.Running}}' "$gateway_prior_id")"
    assert_immutable_image "$gateway_prior_image" PRIOR_GATEWAY_IMAGE
  fi
  gateway_target_image="$GATEWAY_IMAGE"
  gateway_target_env_sha256="$(hash_file "$ENV_FILE")"
  gateway_transition_id="gateway-$(date -u +%Y%m%dT%H%M%SZ)-${gateway_target_env_sha256:0:8}"
  write_gateway_state prepared
fi

compose "${profile_args[@]}" up --detach "${services[@]}"
if [[ "$with_gateway" == true ]]; then write_gateway_state applied; fi
wait_healthy spacetimedb
if [[ "$pin_was_present" != true ]]; then
  record_reviewed_spacetimedb_image_pin "$SPACETIMEDB_IMAGE" initial-deploy "initial-$(date -u +%Y%m%dT%H%M%SZ)"
fi
$with_gateway && wait_healthy gateway
$with_edge && wait_healthy edge
$with_worker && wait_healthy worker
$with_scanner && wait_healthy clamav
$with_telemetry && wait_healthy otel-collector
if [[ "$with_gateway" == true ]]; then write_gateway_state committed; fi
note "Requested services are healthy on loopback. Public release readiness is not implied."
