#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

env_file=""; apply=false; confirmation=""; ack=false
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || die "--env-file requires a path"; env_file="$2"; shift 2 ;;
    --ack-schema-compatible) ack=true; shift ;;
    --apply) apply=true; shift ;;
    --confirm) [[ $# -ge 2 ]] || die "--confirm requires a value"; confirmation="$2"; shift 2 ;;
    -h|--help) printf 'Usage: %s --env-file PATH --ack-schema-compatible [--apply --confirm PROJECT]\n' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$env_file" ]] || die "--env-file is required"
load_env_file "$env_file" true; require_base_identity
[[ "$ack" == true ]] || die "--ack-schema-compatible is required; image rollback cannot undo data or module changes"
state_file="$(deployment_state_dir)/spacetimedb-upgrade.env"
note "Plan: resume or begin the recorded image-only rollback transaction. Data is not restored or downgraded."
require_apply_confirmation "$apply" "$confirmation" || exit 0
acquire_operations_lock
"$SCRIPT_DIR/validate-config.sh" --env-file "$env_file" --runtime

assert_private_regular_file "$state_file" "upgrade state file"; verify_checksum_sidecar "$state_file" >/dev/null
assert_metadata_keys "$state_file" format recorded_utc recorded_epoch compose_project environment transition_id phase \
  previous_image target_image prior_pin_sha256 target_pin_sha256 rollback_pin_sha256 backup_sha256 backup_manifest_sha256 \
  backup_manifest_signature_sha256 restore_marker_sha256 restore_marker_signature_sha256 evidence_verify_key_sha256
[[ "$(metadata_value "$state_file" format)" == project-conversation-spacetimedb-upgrade-state-v3 ]] || die "upgrade state format is unsupported"
[[ "$(metadata_value "$state_file" compose_project)" == "$COMPOSE_PROJECT_NAME" \
  && "$(metadata_value "$state_file" environment)" == "$DEPLOY_ENVIRONMENT" ]] || die "upgrade state belongs to another project/environment"
assert_epoch_utc_pair "$(metadata_value "$state_file" recorded_epoch)" "$(metadata_value "$state_file" recorded_utc)" "upgrade state"
transition_id="$(metadata_value "$state_file" transition_id)"; phase="$(metadata_value "$state_file" phase)"
previous_image="$(metadata_value "$state_file" previous_image)"; target_image="$(metadata_value "$state_file" target_image)"
prior_pin_sha256="$(metadata_value "$state_file" prior_pin_sha256)"; target_pin_sha256="$(metadata_value "$state_file" target_pin_sha256)"
rollback_pin_sha256="$(metadata_value "$state_file" rollback_pin_sha256)"
assert_immutable_image "$previous_image" PREVIOUS_SPACETIMEDB_IMAGE; assert_immutable_image "$target_image" TARGET_SPACETIMEDB_IMAGE
[[ "$phase" == committed || "$phase" == rollback-prepared || "$phase" == rollback-intent \
  || "$phase" == rollback-applied || "$phase" == rolled-back ]] || die "upgrade state is not in a rollback-compatible phase"
for key in prior_pin_sha256 target_pin_sha256 backup_sha256 backup_manifest_sha256 backup_manifest_signature_sha256 restore_marker_sha256 restore_marker_signature_sha256 evidence_verify_key_sha256; do
  [[ "$(metadata_value "$state_file" "$key")" =~ ^[a-f0-9]{64}$ ]] || die "upgrade state contains an invalid digest: $key"
done
[[ "$rollback_pin_sha256" == pending || "$rollback_pin_sha256" =~ ^[a-f0-9]{64}$ ]] || die "upgrade state contains an invalid rollback pin checksum"
backup_sha256="$(metadata_value "$state_file" backup_sha256)"; backup_manifest_sha256="$(metadata_value "$state_file" backup_manifest_sha256)"
backup_manifest_signature_sha256="$(metadata_value "$state_file" backup_manifest_signature_sha256)"
restore_marker_sha256="$(metadata_value "$state_file" restore_marker_sha256)"; restore_marker_signature_sha256="$(metadata_value "$state_file" restore_marker_signature_sha256)"
evidence_verify_key_sha256="$(metadata_value "$state_file" evidence_verify_key_sha256)"

write_rollback_state() {
  local next_phase="$1" recorded_utc recorded_epoch
  recorded_utc="$(date -u +%Y%m%dT%H%M%SZ)"; recorded_epoch="$(utc_compact_to_epoch "$recorded_utc")"
  umask 077
  {
    printf 'format=project-conversation-spacetimedb-upgrade-state-v3\n'; printf 'recorded_utc=%s\n' "$recorded_utc"; printf 'recorded_epoch=%s\n' "$recorded_epoch"
    printf 'compose_project=%s\n' "$COMPOSE_PROJECT_NAME"; printf 'environment=%s\n' "$DEPLOY_ENVIRONMENT"
    printf 'transition_id=%s\n' "$transition_id"; printf 'phase=%s\n' "$next_phase"
    printf 'previous_image=%s\n' "$previous_image"; printf 'target_image=%s\n' "$target_image"
    printf 'prior_pin_sha256=%s\n' "$prior_pin_sha256"; printf 'target_pin_sha256=%s\n' "$target_pin_sha256"; printf 'rollback_pin_sha256=%s\n' "$rollback_pin_sha256"
    printf 'backup_sha256=%s\n' "$backup_sha256"; printf 'backup_manifest_sha256=%s\n' "$backup_manifest_sha256"
    printf 'backup_manifest_signature_sha256=%s\n' "$backup_manifest_signature_sha256"
    printf 'restore_marker_sha256=%s\n' "$restore_marker_sha256"; printf 'restore_marker_signature_sha256=%s\n' "$restore_marker_signature_sha256"
    printf 'evidence_verify_key_sha256=%s\n' "$evidence_verify_key_sha256"
  } > "$state_file.partial"
  chmod 600 "$state_file.partial"; publish_checksummed_record "$state_file.partial" "$state_file"
  phase="$next_phase"
}

[[ "$phase" != prepared && "$phase" != intent-committed && "$phase" != applied ]] || die "forward upgrade is incomplete; resume it before considering rollback"
[[ "$phase" != rolled-back ]] || die "rollback transaction is already committed"
id="$(owned_container_id spacetimedb)"; assert_spacetimedb_mount "$id"
current_image="$(docker inspect --format '{{.Config.Image}}' "$id")"
if [[ "$phase" == committed ]]; then
  [[ "$current_image" == "$target_image" ]] || die "running image is not the committed upgrade target"
  load_reviewed_spacetimedb_image_pin true >/dev/null
  [[ "$SPACETIMEDB_IMAGE" == "$target_image" && "$REVIEWED_IMAGE_PIN_SHA256" == "$target_pin_sha256" ]] || die "target image intent pin is inconsistent"
  write_rollback_state rollback-prepared
fi
if [[ "$phase" == rollback-prepared ]]; then
  [[ "$current_image" == "$target_image" ]] || die "rollback preparation no longer matches the running target image"
  load_reviewed_spacetimedb_image_pin true >/dev/null
  if [[ "$SPACETIMEDB_IMAGE" == "$target_image" && "$REVIEWED_IMAGE_PIN_SHA256" == "$target_pin_sha256" ]]; then
    record_reviewed_spacetimedb_image_pin "$previous_image" image-rollback "rollback-$transition_id"
  else
    [[ "$SPACETIMEDB_IMAGE" == "$previous_image" \
      && "$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" reason)" == image-rollback \
      && "$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" transition_id)" == "rollback-$transition_id" ]] \
      || die "rollback preparation found an unrelated reviewed image pin"
  fi
  rollback_pin_sha256="$REVIEWED_IMAGE_PIN_SHA256"
  write_rollback_state rollback-intent
fi
if [[ "$phase" == rollback-intent ]]; then
  load_reviewed_spacetimedb_image_pin true >/dev/null
  [[ "$SPACETIMEDB_IMAGE" == "$previous_image" && "$REVIEWED_IMAGE_PIN_SHA256" == "$rollback_pin_sha256" ]] || die "rollback image intent pin is inconsistent"
  export SPACETIMEDB_IMAGE="$previous_image"
  compose pull spacetimedb
  compose up --detach --no-deps spacetimedb
  write_rollback_state rollback-applied
fi
if [[ "$phase" == rollback-applied ]]; then
  id="$(owned_container_id spacetimedb)"; assert_spacetimedb_mount "$id"
  [[ "$(docker inspect --format '{{.Config.Image}}' "$id")" == "$previous_image" ]] || die "rollback does not run the recorded previous image"
  wait_healthy spacetimedb
  write_rollback_state rolled-back
fi
note "Image rollback transaction is committed and healthy. This is not evidence that module/data state was reverted."
