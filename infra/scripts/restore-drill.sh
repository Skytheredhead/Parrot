#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

env_file=""; archive=""; drill_port=""; drill_image=""; drill_image_explicit=false; apply=false; confirmation=""; keep=false
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || die "--env-file requires a path"; env_file="$2"; shift 2 ;;
    --archive) [[ $# -ge 2 ]] || die "--archive requires a path"; archive="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die "--port requires a value"; drill_port="$2"; shift 2 ;;
    --image) [[ $# -ge 2 ]] || die "--image requires a value"; drill_image="$2"; drill_image_explicit=true; shift 2 ;;
    --keep) keep=true; shift ;;
    --apply) apply=true; shift ;;
    --confirm) [[ $# -ge 2 ]] || die "--confirm requires a value"; confirmation="$2"; shift 2 ;;
    -h|--help) printf 'Usage: %s --env-file PATH --archive FILE [--image IMAGE@sha256:DIGEST] [--port PORT] [--keep] [--apply --confirm PROJECT]\n' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$env_file" && -n "$archive" ]] || die "--env-file and --archive are required"
load_env_file "$env_file" true; require_base_identity
base_project="$COMPOSE_PROJECT_NAME"; base_environment="$DEPLOY_ENVIRONMENT"
[[ -f "$archive" && ! -L "$archive" ]] || die "archive must be a regular, non-symlink file"
archive="$(cd -- "$(dirname -- "$archive")" && pwd -P)/$(basename -- "$archive")"
[[ "$archive" == "$BACKUP_DIR"/* ]] || die "archive must be inside the approved backup directory"
validate_backup_bundle "$archive" "$base_project" "$base_environment"
if [[ "$drill_image_explicit" != true ]]; then drill_image="$BACKUP_BUNDLE_IMAGE"; fi
assert_immutable_image "$drill_image" RESTORE_DRILL_SPACETIMEDB_IMAGE
drill_port="${drill_port:-$([[ "$base_environment" == production ]] && printf 39200 || printf 39300)}"
[[ "$drill_port" =~ ^[0-9]{4,5}$ ]] || die "invalid drill port"
(( drill_port >= 39200 && drill_port <= 39999 && drill_port != 4789 )) || die "drill port must be in the reserved 39200-39999 range"
[[ "$drill_port" != "$SPACETIMEDB_LOOPBACK_PORT" && "$drill_port" != "$GATEWAY_LOOPBACK_PORT" ]] || die "drill port collides with the base project"

note "Plan: verify and restore $(basename -- "$archive") with $drill_image into a new isolated project on 127.0.0.1:$drill_port."
note "The base project and audited port 4789 are never stopped or mounted."
require_apply_confirmation "$apply" "$confirmation" || exit 0
acquire_operations_lock
require_evidence_signing_key
"$SCRIPT_DIR/preflight.sh" --env-file "$env_file"

restore_parent="/srv/project-conversation/restore-drills/$base_environment"
assert_trusted_directory "$restore_parent" "restore-drill parent" true
[[ -w "$restore_parent" ]] || die "restore-drill parent is not writable"
journal="$(deployment_state_dir)/restore-drill.env"

detect_orphan_drills() {
  local ids roots
  ids="$(docker ps --all --quiet \
    --filter 'label=com.project-conversation.stack=true' \
    --filter 'label=com.project-conversation.environment=restore-drill')"
  roots="$(find "$restore_parent" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [[ -z "$ids" && -z "$roots" ]] || die "an orphaned or explicitly kept restore drill exists; tear down its exact labeled Compose project and remove its reviewed root before continuing"
  if [[ -e "$journal" ]]; then
    assert_private_regular_file "$journal" "restore-drill journal"
    verify_checksum_sidecar "$journal" >/dev/null
    assert_metadata_keys "$journal" format recorded_utc recorded_epoch compose_project environment transition_id phase drill_project drill_root drill_port restore_image keep
    [[ "$(metadata_value "$journal" format)" == project-conversation-restore-drill-journal-v1 ]] || die "unsupported restore-drill journal"
    [[ "$(metadata_value "$journal" compose_project)" == "$base_project" \
      && "$(metadata_value "$journal" environment)" == "$base_environment" ]] || die "restore-drill journal belongs to another project/environment"
    assert_epoch_utc_pair "$(metadata_value "$journal" recorded_epoch)" "$(metadata_value "$journal" recorded_utc)" "restore-drill journal"
    old_phase="$(metadata_value "$journal" phase)"
    [[ "$old_phase" == completed || "$old_phase" == kept || "$old_phase" == torn-down ]] \
      || die "incomplete restore-drill journal detected at phase $old_phase; inspect and tear down the recorded project/root before continuing"
  fi
}
detect_orphan_drills

while IFS= read -r member; do
  case "$member" in /*|..|../*|*/../*|*/..) die "unsafe archive member: $member" ;; esac
done < <(tar -tzf "$archive")
if tar -tvzf "$archive" | awk '
  substr($1,1,1) != "-" && substr($1,1,1) != "d" { unsafe=1 }
  $1 ~ /[sStT]/ || substr($1,9,1) == "w" { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
'; then die "restore archives may contain only regular files/directories without special or world-writable modes"; fi
if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$drill_port" | grep -q .; then die "drill port $drill_port is already in use"; fi
uncompressed_bytes="$(tar --numeric-owner -tvzf "$archive" | awk '{sum += $3} END {printf "%.0f", sum}')"
[[ "$uncompressed_bytes" =~ ^[0-9]{1,16}$ ]] || die "archive expanded-size estimate is invalid or too large"
restore_free_kb="$(df -Pk "$restore_parent" | awk 'NR==2 {print $4}')"
awk -v free_kb="$restore_free_kb" -v bytes="$uncompressed_bytes" \
  'BEGIN { exit !(free_kb * 1024 >= bytes + 1073741824) }' || die "restore filesystem lacks archive size plus 1 GiB safety headroom"

started_utc="$(date -u +%Y%m%dT%H%M%SZ)"
timestamp_lc="$(printf '%s' "$started_utc" | tr '[:upper:]' '[:lower:]')"
transition_id="restore-$started_utc"
drill_project="project-conversation-restore-drill-${base_environment}-${timestamp_lc}"
drill_root="$restore_parent/${base_environment}-${timestamp_lc}"
[[ "$drill_project" =~ ^project-conversation-restore-drill-(production|staging)-[0-9]{8}t[0-9]{6}z$ ]] || die "internal drill project guard failed"
[[ "$drill_root" == "$restore_parent"/* && ! -e "$drill_root" ]] || die "internal drill path guard failed"
restore_image="$drill_image"

write_restore_journal() {
  local phase="$1" recorded_utc recorded_epoch
  recorded_utc="$(date -u +%Y%m%dT%H%M%SZ)"; recorded_epoch="$(utc_compact_to_epoch "$recorded_utc")"
  umask 077
  {
    printf 'format=project-conversation-restore-drill-journal-v1\n'
    printf 'recorded_utc=%s\n' "$recorded_utc"
    printf 'recorded_epoch=%s\n' "$recorded_epoch"
    printf 'compose_project=%s\n' "$base_project"
    printf 'environment=%s\n' "$base_environment"
    printf 'transition_id=%s\n' "$transition_id"
    printf 'phase=%s\n' "$phase"
    printf 'drill_project=%s\n' "$drill_project"
    printf 'drill_root=%s\n' "$drill_root"
    printf 'drill_port=%s\n' "$drill_port"
    printf 'restore_image=%s\n' "$restore_image"
    printf 'keep=%s\n' "$keep"
  } > "$journal.partial"
  chmod 600 "$journal.partial"; publish_checksummed_record "$journal.partial" "$journal"
}

write_restore_journal prepared
export SPACETIMEDB_DATA_DIR="$drill_root" SPACETIMEDB_LOOPBACK_PORT="$drill_port" SPACETIMEDB_IMAGE="$restore_image" DEPLOY_ENVIRONMENT=restore-drill
drill_compose=(docker compose --project-name "$drill_project" --env-file "$ENV_FILE" --file "$COMPOSE_FILE")
cleanup_attempted=false
cleanup_drill() {
  cleanup_attempted=true
  "${drill_compose[@]}" down --remove-orphans --volumes >/dev/null
  [[ -z "$("${drill_compose[@]}" ps --all --quiet)" ]] || return 1
  [[ "$drill_root" == "$restore_parent"/* && ! -L "$drill_root" ]] || return 1
  rm -rf -- "$drill_root"
  [[ ! -e "$drill_root" ]] || return 1
  write_restore_journal torn-down
}
cleanup_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$keep" != true && "$cleanup_attempted" != true ]]; then cleanup_drill || note "ERROR: restore-drill cleanup failed; persistent journal and root require operator reconciliation"; fi
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
mkdir -m 700 -- "$drill_root"
tar --no-same-owner --same-permissions -xzf "$archive" -C "$drill_root"
write_restore_journal extracted
"${drill_compose[@]}" up --detach spacetimedb
write_restore_journal running

healthy=false
for ((i=1; i<=60; i++)); do
  id="$("${drill_compose[@]}" ps --quiet spacetimedb)"
  if [[ -n "$id" && "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" == healthy ]]; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]] || die "isolated restored SpacetimeDB did not become healthy"
write_restore_journal healthy

write_restore_journal verifying
verification_record="$drill_root/.restored-state-verification"
"$SCRIPT_DIR/verify-restored-state.sh" \
  --endpoint "http://127.0.0.1:$drill_port" \
  --database-name "$SPACETIMEDB_DATABASE_NAME" \
  --database-identity "$SPACETIMEDB_DATABASE_IDENTITY" \
  --initial-program-hash "$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH" \
  --schema-sha256 "$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256" \
  --owner-token-file "$RESTORE_VERIFIER_DATABASE_OWNER_TOKEN_FILE" \
  --output "$verification_record"
validate_restored_state_verification \
  "$verification_record" "$SPACETIMEDB_DATABASE_IDENTITY" \
  "$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH" "$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256"
verification_required_table_count="$(metadata_value "$verification_record" required_private_table_count)"
verification_domain_invariant_count="$(metadata_value "$verification_record" domain_invariant_count)"
write_restore_journal verified

marker_dir="$BACKUP_DIR/restore-drills"
if [[ ! -e "$marker_dir" ]]; then mkdir -m 700 -- "$marker_dir"; fi
assert_trusted_directory "$marker_dir" "restore marker directory" true

if [[ "$keep" == true ]]; then
  completed_utc="$(date -u +%Y%m%dT%H%M%SZ)"; completed_epoch="$(utc_compact_to_epoch "$completed_utc")"
  marker="$marker_dir/${timestamp_lc}.kept"
  teardown=not-performed; upgrade_eligible=false; result=bounded-restored-state-kept-not-upgrade-evidence
else
  cleanup_drill || die "restore-drill teardown failed; no success evidence was published"
  completed_utc="$(date -u +%Y%m%dT%H%M%SZ)"; completed_epoch="$(utc_compact_to_epoch "$completed_utc")"
  marker="$marker_dir/${timestamp_lc}.success"
  teardown=completed; upgrade_eligible=false; result=bounded-restored-state-not-traffic-eligible
fi

{
  printf 'format=project-conversation-restore-drill-v4\n'
  printf 'completed_utc=%s\n' "$completed_utc"
  printf 'completed_epoch=%s\n' "$completed_epoch"
  printf 'compose_project=%s\n' "$base_project"
  printf 'source_environment=%s\n' "$base_environment"
  printf 'archive=%s\n' "$(basename -- "$archive")"
  printf 'archive_sha256=%s\n' "$BACKUP_BUNDLE_CHECKSUM"
  printf 'backup_manifest_sha256=%s\n' "$BACKUP_BUNDLE_MANIFEST_SHA256"
  printf 'evidence_verify_key_sha256=%s\n' "$BACKUP_BUNDLE_VERIFY_KEY_SHA256"
  printf 'source_spacetimedb_image=%s\n' "$BACKUP_BUNDLE_IMAGE"
  printf 'restore_spacetimedb_image=%s\n' "$restore_image"
  printf 'ownership_mode=operator-remapped-modes-preserved\n'
  printf 'database_identity=%s\n' "$SPACETIMEDB_DATABASE_IDENTITY"
  printf 'initial_program_hash=%s\n' "$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH"
  printf 'current_module_code=NotVerified\n'
  printf 'module_schema_sha256=%s\n' "$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256"
  printf 'restored_state_verification=Pass\n'
  printf 'required_private_tables=Pass\n'
  printf 'required_private_table_count=%s\n' "$verification_required_table_count"
  printf 'domain_invariants=Pass\n'
  printf 'domain_invariant_count=%s\n' "$verification_domain_invariant_count"
  printf 'outbox_lease_recovery_shape=NotVerified\n'
  printf 'audit_continuity=BoundedReferentialOnly\n'
  printf 'deletion_lifecycle_overlay=NotConfigured\n'
  printf 'object_inventory=NotConfigured\n'
  printf 'search_rebuild=NotConfigured\n'
  printf 'provider_checks=NotConfigured\n'
  printf 'traffic_eligible=false\n'
  printf 'teardown=%s\n' "$teardown"
  printf 'upgrade_eligible=%s\n' "$upgrade_eligible"
  printf 'result=%s\n' "$result"
} > "$marker.partial"
chmod 600 "$marker.partial"; mv -- "$marker.partial" "$marker"
write_checksum_sidecar "$marker"; sign_evidence_file "$marker"
if [[ "$keep" == true ]]; then
  write_restore_journal kept
  trap - EXIT INT TERM
  note "Restore drill is intentionally kept; signed evidence is marked ineligible for upgrades: $marker"
else
  write_restore_journal completed
  trap - EXIT INT TERM
  note "Restore drill passed and teardown completed before success evidence was published: $marker"
fi
note "Evidence remains explicitly ineligible for traffic: deletion lifecycle overlay, object inventory, search rebuild, provider checks, authorization behavior, and RPO/RTO are not proven."
