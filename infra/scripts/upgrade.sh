#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

env_file=""; new_image=""; backup=""; marker=""; apply=false; confirmation=""; ack=false
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || die "--env-file requires a path"; env_file="$2"; shift 2 ;;
    --image) [[ $# -ge 2 ]] || die "--image requires a value"; new_image="$2"; shift 2 ;;
    --backup) [[ $# -ge 2 ]] || die "--backup requires a path"; backup="$2"; shift 2 ;;
    --restore-marker) [[ $# -ge 2 ]] || die "--restore-marker requires a path"; marker="$2"; shift 2 ;;
    --ack-forward-only) ack=true; shift ;;
    --apply) apply=true; shift ;;
    --confirm) [[ $# -ge 2 ]] || die "--confirm requires a value"; confirmation="$2"; shift 2 ;;
    -h|--help) printf 'Usage: %s --env-file PATH --image IMAGE@sha256:DIGEST --backup FILE --restore-marker FILE --ack-forward-only [--apply --confirm PROJECT]\n' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$env_file" && -n "$new_image" && -n "$backup" && -n "$marker" ]] || die "env, image, backup, and restore marker are required"
load_env_file "$env_file" true; require_base_identity
assert_immutable_image "$new_image" SPACETIMEDB_UPGRADE_IMAGE
[[ "$ack" == true ]] || die "--ack-forward-only is required; this script does not downgrade data or publish a module"
note "Plan: transactionally advance only $COMPOSE_PROJECT_NAME/spacetimedb to $new_image after signed backup and torn-down drill evidence checks."
require_apply_confirmation "$apply" "$confirmation" || exit 0
acquire_operations_lock
"$SCRIPT_DIR/preflight.sh" --env-file "$env_file"
load_reviewed_spacetimedb_image_pin true >/dev/null

backup="$(cd -- "$(dirname -- "$backup")" && pwd -P)/$(basename -- "$backup")"
[[ "$backup" == "$BACKUP_DIR"/* ]] || die "backup must resolve below $BACKUP_DIR"
[[ -f "$marker" && ! -L "$marker" ]] || die "restore marker is missing or unsafe"
marker="$(cd -- "$(dirname -- "$marker")" && pwd -P)/$(basename -- "$marker")"
[[ "$marker" == "$BACKUP_DIR/restore-drills/"* ]] || die "restore marker must resolve below $BACKUP_DIR/restore-drills"
validate_backup_bundle "$backup" "$COMPOSE_PROJECT_NAME" "$DEPLOY_ENVIRONMENT"
validate_restore_marker "$marker" "$backup" "$COMPOSE_PROJECT_NAME" "$DEPLOY_ENVIRONMENT" "$new_image"

state_file="$(deployment_state_dir)/spacetimedb-upgrade.env"
transition_id="upgrade-${new_image##*@sha256:}"; transition_id="${transition_id:0:24}-${BACKUP_BUNDLE_CHECKSUM:0:12}"
phase=""; previous_image=""; target_image=""; prior_pin_sha256=""; target_pin_sha256=pending; rollback_pin_sha256=pending

load_upgrade_state() {
  [[ -e "$state_file" ]] || return 1
  assert_private_regular_file "$state_file" "upgrade state file"; verify_checksum_sidecar "$state_file" >/dev/null
  assert_metadata_keys "$state_file" format recorded_utc recorded_epoch compose_project environment transition_id phase \
    previous_image target_image prior_pin_sha256 target_pin_sha256 rollback_pin_sha256 backup_sha256 backup_manifest_sha256 \
    backup_manifest_signature_sha256 restore_marker_sha256 restore_marker_signature_sha256 evidence_verify_key_sha256
  [[ "$(metadata_value "$state_file" format)" == project-conversation-spacetimedb-upgrade-state-v3 ]] || die "unsupported upgrade state"
  [[ "$(metadata_value "$state_file" compose_project)" == "$COMPOSE_PROJECT_NAME" \
    && "$(metadata_value "$state_file" environment)" == "$DEPLOY_ENVIRONMENT" ]] || die "upgrade state belongs to another project/environment"
  assert_epoch_utc_pair "$(metadata_value "$state_file" recorded_epoch)" "$(metadata_value "$state_file" recorded_utc)" "upgrade state"
  state_transition_id="$(metadata_value "$state_file" transition_id)"
  phase="$(metadata_value "$state_file" phase)"
  previous_image="$(metadata_value "$state_file" previous_image)"; target_image="$(metadata_value "$state_file" target_image)"
  prior_pin_sha256="$(metadata_value "$state_file" prior_pin_sha256)"; target_pin_sha256="$(metadata_value "$state_file" target_pin_sha256)"
  rollback_pin_sha256="$(metadata_value "$state_file" rollback_pin_sha256)"
  [[ "$phase" == prepared || "$phase" == intent-committed || "$phase" == applied || "$phase" == committed \
    || "$phase" == rollback-prepared || "$phase" == rollback-intent \
    || "$phase" == rollback-applied || "$phase" == rolled-back ]] || die "invalid upgrade phase"
  assert_immutable_image "$previous_image" PREVIOUS_SPACETIMEDB_IMAGE; assert_immutable_image "$target_image" TARGET_SPACETIMEDB_IMAGE
  for key in prior_pin_sha256 backup_sha256 backup_manifest_sha256 backup_manifest_signature_sha256 restore_marker_sha256 restore_marker_signature_sha256 evidence_verify_key_sha256; do
    [[ "$(metadata_value "$state_file" "$key")" =~ ^[a-f0-9]{64}$ ]] || die "invalid upgrade evidence digest: $key"
  done
  [[ "$target_pin_sha256" == pending || "$target_pin_sha256" =~ ^[a-f0-9]{64}$ ]] || die "invalid target pin checksum"
  [[ "$rollback_pin_sha256" == pending || "$rollback_pin_sha256" =~ ^[a-f0-9]{64}$ ]] || die "invalid rollback pin checksum"
  if [[ "$state_transition_id" != "$transition_id" \
    || "$target_image" != "$new_image" \
    || "$(metadata_value "$state_file" backup_sha256)" != "$BACKUP_BUNDLE_CHECKSUM" \
    || "$(metadata_value "$state_file" restore_marker_sha256)" != "$RESTORE_MARKER_SHA256" ]]; then
    [[ "$phase" == committed || "$phase" == rolled-back ]] && return 2
    die "another incomplete upgrade transaction is recorded; do not overwrite its recovery evidence"
  fi
}

write_upgrade_state() {
  local next_phase="$1" recorded_utc recorded_epoch
  recorded_utc="$(date -u +%Y%m%dT%H%M%SZ)"; recorded_epoch="$(utc_compact_to_epoch "$recorded_utc")"
  umask 077
  {
    printf 'format=project-conversation-spacetimedb-upgrade-state-v3\n'
    printf 'recorded_utc=%s\n' "$recorded_utc"; printf 'recorded_epoch=%s\n' "$recorded_epoch"
    printf 'compose_project=%s\n' "$COMPOSE_PROJECT_NAME"; printf 'environment=%s\n' "$DEPLOY_ENVIRONMENT"
    printf 'transition_id=%s\n' "$transition_id"; printf 'phase=%s\n' "$next_phase"
    printf 'previous_image=%s\n' "$previous_image"; printf 'target_image=%s\n' "$target_image"
    printf 'prior_pin_sha256=%s\n' "$prior_pin_sha256"; printf 'target_pin_sha256=%s\n' "$target_pin_sha256"; printf 'rollback_pin_sha256=%s\n' "$rollback_pin_sha256"
    printf 'backup_sha256=%s\n' "$BACKUP_BUNDLE_CHECKSUM"
    printf 'backup_manifest_sha256=%s\n' "$BACKUP_BUNDLE_MANIFEST_SHA256"
    printf 'backup_manifest_signature_sha256=%s\n' "$(hash_file "$BACKUP_BUNDLE_MANIFEST.sig")"
    printf 'restore_marker_sha256=%s\n' "$RESTORE_MARKER_SHA256"
    printf 'restore_marker_signature_sha256=%s\n' "$(hash_file "$marker.sig")"
    printf 'evidence_verify_key_sha256=%s\n' "$BACKUP_BUNDLE_VERIFY_KEY_SHA256"
  } > "$state_file.partial"
  chmod 600 "$state_file.partial"; publish_checksummed_record "$state_file.partial" "$state_file"
  phase="$next_phase"
}

id="$(owned_container_id spacetimedb)"; assert_spacetimedb_mount "$id"
current_image="$(docker inspect --format '{{.Config.Image}}' "$id")"; assert_immutable_image "$current_image" CURRENT_SPACETIMEDB_IMAGE
state_status=missing
if load_upgrade_state; then
  state_status=resume
else
  load_status=$?
  if [[ "$load_status" == 2 ]]; then
    state_status=terminal-prior
    history_file="$state_file.$state_transition_id"
    if [[ -e "$history_file" || -e "$history_file.sha256" ]]; then
      assert_private_regular_file "$history_file" "upgrade history"; verify_checksum_sidecar "$history_file" >/dev/null
      cmp -s "$state_file" "$history_file" || die "upgrade history destination contains different evidence"
    else
      cp -- "$state_file" "$history_file.partial"
      chmod 600 "$history_file.partial"
      mv -- "$history_file.partial" "$history_file"
      write_checksum_sidecar "$history_file"
    fi
    rm -f -- "$state_file" "$state_file.sha256"
  elif [[ "$load_status" != 1 ]]; then
    die "unable to load upgrade state"
  fi
fi
require_upgrade_backup_freshness "$state_status" "$BACKUP_BUNDLE_CREATED_EPOCH"
if [[ "$state_status" != resume ]]; then
  [[ "$current_image" == "$SPACETIMEDB_IMAGE" ]] || die "running image differs from the reviewed persistent pin"
  [[ "$BACKUP_BUNDLE_IMAGE" == "$current_image" ]] || die "backup was not created from the currently reviewed image"
  [[ "$BACKUP_BUNDLE_PIN_SHA256" == "$REVIEWED_IMAGE_PIN_SHA256" ]] || die "backup was not created from the current reviewed image-pin record"
  [[ "$current_image" != "$new_image" ]] || die "requested image is already running"
  previous_image="$current_image"; target_image="$new_image"; prior_pin_sha256="$REVIEWED_IMAGE_PIN_SHA256"; target_pin_sha256=pending
  rollback_pin_sha256=pending
  write_upgrade_state prepared
fi
[[ "$phase" != committed ]] || die "upgrade transaction is already committed"
[[ "$phase" != rollback-prepared && "$phase" != rollback-intent \
  && "$phase" != rollback-applied && "$phase" != rolled-back ]] || die "upgrade transaction is in rollback state"

if [[ "$phase" == prepared ]]; then
  [[ "$current_image" == "$previous_image" || "$current_image" == "$target_image" ]] \
    || die "prepared upgrade no longer matches either recorded image"
  load_reviewed_spacetimedb_image_pin true >/dev/null
  if [[ "$SPACETIMEDB_IMAGE" == "$previous_image" && "$REVIEWED_IMAGE_PIN_SHA256" == "$prior_pin_sha256" ]]; then
    [[ "$current_image" == "$previous_image" ]] \
      || die "prepared upgrade cannot run the target before its intent pin is recorded"
    record_reviewed_spacetimedb_image_pin "$target_image" image-upgrade "$transition_id"
  else
    [[ "$SPACETIMEDB_IMAGE" == "$target_image" \
      && "$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" reason)" == image-upgrade \
      && "$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" transition_id)" == "$transition_id" ]] \
      || die "prepared upgrade found an unrelated reviewed image pin"
  fi
  target_pin_sha256="$REVIEWED_IMAGE_PIN_SHA256"
  write_upgrade_state intent-committed
fi
if [[ "$phase" == intent-committed ]]; then
  load_reviewed_spacetimedb_image_pin true >/dev/null
  [[ "$SPACETIMEDB_IMAGE" == "$target_image" && "$REVIEWED_IMAGE_PIN_SHA256" == "$target_pin_sha256" ]] || die "target image intent pin is inconsistent"
  export SPACETIMEDB_IMAGE="$target_image"
  compose pull spacetimedb
  compose up --detach --no-deps spacetimedb
  write_upgrade_state applied
fi
if [[ "$phase" == applied ]]; then
  id="$(owned_container_id spacetimedb)"; assert_spacetimedb_mount "$id"
  [[ "$(docker inspect --format '{{.Config.Image}}' "$id")" == "$target_image" ]] || die "applied upgrade does not run the recorded target"
  wait_healthy spacetimedb
  write_upgrade_state committed
fi
note "Container image upgrade transaction is committed and healthy. No module/schema migration or public readiness was performed."
