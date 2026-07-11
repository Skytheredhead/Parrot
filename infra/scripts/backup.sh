#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

env_file=""; apply=false; confirmation=""
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || die "--env-file requires a path"; env_file="$2"; shift 2 ;;
    --apply) apply=true; shift ;;
    --confirm) [[ $# -ge 2 ]] || die "--confirm requires a value"; confirmation="$2"; shift 2 ;;
    -h|--help) printf 'Usage: %s --env-file PATH [--apply --confirm PROJECT]\n' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$env_file" ]] || die "--env-file is required"
load_env_file "$env_file" true; require_base_identity
note "Plan: reconcile any interrupted cold backup, then stop only $COMPOSE_PROJECT_NAME/spacetimedb, archive its complete /stdb bind root, and restart it."
require_apply_confirmation "$apply" "$confirmation" || exit 0
acquire_operations_lock
"$SCRIPT_DIR/validate-config.sh" --env-file "$env_file" --runtime
require_evidence_signing_key
load_reviewed_spacetimedb_image_pin true >/dev/null

journal="$(deployment_state_dir)/spacetimedb-backup.env"
backup_transition_id=""; backup_phase=""; archive=""; image=""

load_backup_journal() {
  [[ -e "$journal" ]] || return 1
  assert_private_regular_file "$journal" "backup journal"
  verify_checksum_sidecar "$journal" >/dev/null
  assert_metadata_keys "$journal" format recorded_utc recorded_epoch compose_project environment transition_id phase archive spacetimedb_image
  [[ "$(metadata_value "$journal" format)" == project-conversation-spacetimedb-backup-journal-v1 ]] || die "unsupported backup journal"
  [[ "$(metadata_value "$journal" compose_project)" == "$COMPOSE_PROJECT_NAME" \
    && "$(metadata_value "$journal" environment)" == "$DEPLOY_ENVIRONMENT" ]] || die "backup journal belongs to another project/environment"
  assert_epoch_utc_pair "$(metadata_value "$journal" recorded_epoch)" "$(metadata_value "$journal" recorded_utc)" "backup journal"
  backup_transition_id="$(metadata_value "$journal" transition_id)"
  backup_phase="$(metadata_value "$journal" phase)"
  archive="$(metadata_value "$journal" archive)"
  image="$(metadata_value "$journal" spacetimedb_image)"
  [[ "$backup_transition_id" =~ ^backup-[0-9]{8}T[0-9]{6}Z$ ]] || die "invalid backup transition id"
  [[ "$backup_phase" == prepared || "$backup_phase" == stop-requested || "$backup_phase" == stopped \
    || "$backup_phase" == archive-published || "$backup_phase" == restarted || "$backup_phase" == committed \
    || "$backup_phase" == recovered ]] || die "invalid backup journal phase"
  [[ "$archive" == "$BACKUP_DIR"/spacetimedb-"$DEPLOY_ENVIRONMENT"-[0-9]*T[0-9]*Z.tar.gz ]] || die "backup journal archive is outside the approved naming/path boundary"
  assert_immutable_image "$image" BACKUP_JOURNAL_IMAGE
}

write_backup_journal() {
  local phase="$1" recorded_utc recorded_epoch
  recorded_utc="$(date -u +%Y%m%dT%H%M%SZ)"; recorded_epoch="$(utc_compact_to_epoch "$recorded_utc")"
  umask 077
  {
    printf 'format=project-conversation-spacetimedb-backup-journal-v1\n'
    printf 'recorded_utc=%s\n' "$recorded_utc"
    printf 'recorded_epoch=%s\n' "$recorded_epoch"
    printf 'compose_project=%s\n' "$COMPOSE_PROJECT_NAME"
    printf 'environment=%s\n' "$DEPLOY_ENVIRONMENT"
    printf 'transition_id=%s\n' "$backup_transition_id"
    printf 'phase=%s\n' "$phase"
    printf 'archive=%s\n' "$archive"
    printf 'spacetimedb_image=%s\n' "$image"
  } > "$journal.partial"
  chmod 600 "$journal.partial"; publish_checksummed_record "$journal.partial" "$journal"
  backup_phase="$phase"
}

reconcile_interrupted_backup() {
  load_backup_journal || return 1
  [[ "$backup_phase" != committed && "$backup_phase" != recovered ]] || return 1
  note "Interrupted backup journal detected at phase $backup_phase; reconciling service availability before another backup."
  rm -f -- "$archive.partial" "$archive.sha256.partial" "$archive.manifest.partial" \
    "$archive.manifest.sha256.partial" "$archive.manifest.sig.partial"
  id="$(compose ps --all --quiet spacetimedb)"
  [[ -n "$id" && "$id" != *$'\n'* ]] || die "cannot reconcile backup: expected exactly one SpacetimeDB container"
  assert_owned_container_id "$id" spacetimedb; assert_spacetimedb_mount "$id"
  running="$(docker inspect --format '{{.State.Running}}' "$id")"
  if [[ "$running" != true ]] || ! wait_healthy_status spacetimedb 1; then
    export SPACETIMEDB_IMAGE="$image"
    compose up --detach --no-deps spacetimedb
    wait_healthy spacetimedb
  fi
  write_backup_journal recovered
  note "Interrupted backup reconciled and SpacetimeDB is healthy. Re-run the backup command to create a new archive."
  return 0
}

if reconcile_interrupted_backup; then exit 0; fi

id="$(owned_container_id spacetimedb)"; assert_spacetimedb_mount "$id"
image="$(docker inspect --format '{{.Config.Image}}' "$id")"
assert_immutable_image "$image" CURRENT_SPACETIMEDB_IMAGE
[[ "$image" == "$SPACETIMEDB_IMAGE" ]] || die "running SpacetimeDB image differs from the reviewed persistent pin"
data_kb="$(du -sk "$SPACETIMEDB_DATA_DIR" | awk '{print $1}')"
backup_free_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
(( backup_free_kb >= data_kb + 1024 * 1024 )) || die "backup filesystem lacks data-root size plus 1 GiB safety headroom"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
created_epoch="$(utc_compact_to_epoch "$timestamp")"
backup_transition_id="backup-$timestamp"
archive="$BACKUP_DIR/spacetimedb-$DEPLOY_ENVIRONMENT-$timestamp.tar.gz"
partial="$archive.partial"
[[ ! -e "$archive" && ! -e "$partial" && ! -e "$archive.sha256.partial" && ! -e "$archive.manifest.partial" ]] || die "backup artifact already exists"
write_backup_journal prepared

stopped=false
restart_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  rm -f -- "$partial" "$archive.sha256.partial" "$archive.manifest.partial" \
    "$archive.manifest.sha256.partial" "$archive.manifest.sig.partial"
  if [[ "$stopped" == true ]]; then
    note "Attempting narrow SpacetimeDB restart after interrupted backup."
    set +e
    export SPACETIMEDB_IMAGE="$image"
    compose up --detach --no-deps spacetimedb >/dev/null && wait_healthy_status spacetimedb
    restart_status=$?
    set -e
    if [[ "$restart_status" == 0 ]]; then write_backup_journal recovered; else note "ERROR: restart failed; the persistent backup journal requires next-run reconciliation"; fi
  fi
  exit "$status"
}
trap restart_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

write_backup_journal stop-requested
stopped=true
compose stop --timeout 120 spacetimedb
write_backup_journal stopped
umask 077
tar --numeric-owner -C "$SPACETIMEDB_DATA_DIR" -czf "$partial" .
mv -- "$partial" "$archive"
checksum="$(hash_file "$archive")"
printf '%s  %s\n' "$checksum" "$(basename -- "$archive")" > "$archive.sha256.partial"
chmod 600 "$archive.sha256.partial"; mv -- "$archive.sha256.partial" "$archive.sha256"
{
  printf 'format=project-conversation-spacetimedb-cold-backup-v3\n'
  printf 'created_utc=%s\n' "$timestamp"
  printf 'created_epoch=%s\n' "$created_epoch"
  printf 'archive=%s\n' "$(basename -- "$archive")"
  printf 'compose_project=%s\n' "$COMPOSE_PROJECT_NAME"
  printf 'environment=%s\n' "$DEPLOY_ENVIRONMENT"
  printf 'spacetimedb_image=%s\n' "$image"
  printf 'image_pin_sha256=%s\n' "$REVIEWED_IMAGE_PIN_SHA256"
  printf 'evidence_verify_key_sha256=%s\n' "$(hash_file "$BACKUP_EVIDENCE_VERIFY_KEY_FILE")"
  printf 'archive_sha256=%s\n' "$checksum"
  printf 'data_root_uid=%s\n' "$(file_uid "$SPACETIMEDB_DATA_DIR")"
  printf 'data_root_gid=%s\n' "$(file_gid "$SPACETIMEDB_DATA_DIR")"
  printf 'data_root_mode=%s\n' "$(file_mode "$SPACETIMEDB_DATA_DIR")"
} > "$archive.manifest.partial"
chmod 600 "$archive.manifest.partial"; mv -- "$archive.manifest.partial" "$archive.manifest"
write_checksum_sidecar "$archive.manifest"; sign_evidence_file "$archive.manifest"
write_backup_journal archive-published
compose up --detach --no-deps spacetimedb
stopped=false
wait_healthy spacetimedb
write_backup_journal restarted
write_backup_journal committed
trap - EXIT INT TERM
note "Cold backup created: $archive"
note "This local archive is not an offsite copy or restore proof."
