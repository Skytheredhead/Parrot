#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source "$ROOT_DIR/infra/scripts/common.sh"

tmp="$(mktemp -d)"
tmp="$(cd -P -- "$(dirname -- "$tmp")" && pwd -P)/$(basename -- "$tmp")"
cleanup() { rm -rf -- "$tmp"; }
trap cleanup EXIT
umask 077

export BACKUP_EVIDENCE_SIGNING_KEY_FILE="$tmp/evidence-private.pem"
export BACKUP_EVIDENCE_VERIFY_KEY_FILE="$tmp/evidence-public.pem"
openssl genpkey -algorithm ED25519 -out "$BACKUP_EVIDENCE_SIGNING_KEY_FILE" >/dev/null 2>&1
openssl pkey -in "$BACKUP_EVIDENCE_SIGNING_KEY_FILE" -pubout \
  -out "$BACKUP_EVIDENCE_VERIFY_KEY_FILE" >/dev/null 2>&1
chmod 600 "$BACKUP_EVIDENCE_SIGNING_KEY_FILE" "$BACKUP_EVIDENCE_VERIFY_KEY_FILE"

image='clockworklabs/spacetime:v2.6.1@sha256:53100591a8bfd62c6e088e801b68e96871a8fc6e68eb4fb031bc6ac76f77a72e'
archive="$tmp/spacetimedb-staging-fixture.tar.gz"
printf 'fixture archive bytes\n' > "$archive"
chmod 600 "$archive"
write_checksum_sidecar "$archive"
archive_checksum="$(hash_file "$archive")"
pin_checksum='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
now_utc="$(date -u +%Y%m%dT%H%M%SZ)"
now="$(utc_compact_to_epoch "$now_utc")"

cat > "$archive.manifest" <<EOF
format=project-conversation-spacetimedb-cold-backup-v3
created_utc=$now_utc
created_epoch=$now
archive=$(basename -- "$archive")
compose_project=project-conversation-staging
environment=staging
spacetimedb_image=$image
image_pin_sha256=$pin_checksum
evidence_verify_key_sha256=$(hash_file "$BACKUP_EVIDENCE_VERIFY_KEY_FILE")
archive_sha256=$archive_checksum
data_root_uid=1000
data_root_gid=1000
data_root_mode=700
EOF
chmod 600 "$archive.manifest"
write_checksum_sidecar "$archive.manifest"
sign_evidence_file "$archive.manifest"

validate_backup_bundle "$archive" project-conversation-staging staging
[[ "$BACKUP_BUNDLE_CHECKSUM" == "$archive_checksum" ]]
[[ "$BACKUP_BUNDLE_IMAGE" == "$image" ]]

export SPACETIMEDB_DATABASE_IDENTITY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export RESTORE_EXPECTED_INITIAL_PROGRAM_HASH=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
export RESTORE_EXPECTED_MODULE_SCHEMA_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
verification="$tmp/restored-state.verification"
cat > "$verification" <<EOF
format=project-conversation-restored-state-verification-v1
database_identity=$SPACETIMEDB_DATABASE_IDENTITY
initial_program_hash=$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH
current_module_code=NotVerified
module_schema_sha256=$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256
required_private_tables=Pass
required_private_table_count=78
domain_invariants=Pass
domain_invariant_count=90
outbox_lease_recovery_shape=NotVerified
audit_continuity=BoundedReferentialOnly
deletion_lifecycle_overlay=NotConfigured
traffic_eligible=false
result=BoundedRestoreStateVerified
EOF
chmod 600 "$verification"
validate_restored_state_verification \
  "$verification" "$SPACETIMEDB_DATABASE_IDENTITY" \
  "$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH" "$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256"

invariant_failure="$tmp/invariant-failure.verification"
sed 's/domain_invariants=Pass/domain_invariants=Fail/' "$verification" > "$invariant_failure"
chmod 600 "$invariant_failure"
if (validate_restored_state_verification \
  "$invariant_failure" "$SPACETIMEDB_DATABASE_IDENTITY" \
  "$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH" "$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256" >/dev/null 2>&1); then
  die "fixture expected failed restored-state invariants to be rejected"
fi

cp "$verification" "$tmp/interrupted.verification.partial"
chmod 600 "$tmp/interrupted.verification.partial"
if (validate_restored_state_verification \
  "$tmp/interrupted.verification" "$SPACETIMEDB_DATABASE_IDENTITY" \
  "$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH" "$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256" >/dev/null 2>&1); then
  die "fixture expected an interrupted partial verifier record to be rejected"
fi

marker="$tmp/fixture.success"
cat > "$marker" <<EOF
format=project-conversation-restore-drill-v4
completed_utc=$now_utc
completed_epoch=$now
compose_project=project-conversation-staging
source_environment=staging
archive=$(basename -- "$archive")
archive_sha256=$archive_checksum
backup_manifest_sha256=$BACKUP_BUNDLE_MANIFEST_SHA256
evidence_verify_key_sha256=$BACKUP_BUNDLE_VERIFY_KEY_SHA256
source_spacetimedb_image=$image
restore_spacetimedb_image=$image
ownership_mode=operator-remapped-modes-preserved
database_identity=$SPACETIMEDB_DATABASE_IDENTITY
initial_program_hash=$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH
current_module_code=NotVerified
module_schema_sha256=$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256
restored_state_verification=Pass
required_private_tables=Pass
required_private_table_count=78
domain_invariants=Pass
domain_invariant_count=90
outbox_lease_recovery_shape=NotVerified
audit_continuity=BoundedReferentialOnly
deletion_lifecycle_overlay=NotConfigured
object_inventory=NotConfigured
search_rebuild=NotConfigured
provider_checks=NotConfigured
traffic_eligible=false
teardown=completed
upgrade_eligible=false
result=bounded-restored-state-not-traffic-eligible
EOF
chmod 600 "$marker"
write_checksum_sidecar "$marker"
sign_evidence_file "$marker"
validate_restore_marker "$marker" "$archive" project-conversation-staging staging "$image"

tampered="$tmp/tampered.success"
cp "$marker" "$tampered"
cp "$marker.sig" "$tampered.sig"
printf 'result=forged\n' >> "$tampered"
write_checksum_sidecar "$tampered"
if (verify_evidence_signature "$tampered" >/dev/null 2>&1); then
  die "fixture expected tampered signed evidence to be rejected"
fi

failed_marker="$tmp/failed-invariant.success"
sed 's/domain_invariants=Pass/domain_invariants=Fail/' "$marker" > "$failed_marker"
chmod 600 "$failed_marker"
write_checksum_sidecar "$failed_marker"
sign_evidence_file "$failed_marker"
if (validate_restore_marker "$failed_marker" "$archive" project-conversation-staging staging "$image" >/dev/null 2>&1); then
  die "fixture expected a signed marker with failed invariants to be rejected"
fi

verifier_line="$(grep -nF '"$SCRIPT_DIR/verify-restored-state.sh"' "$ROOT_DIR/infra/scripts/restore-drill.sh" | cut -d: -f1)"
cleanup_line="$(grep -nF 'cleanup_drill || die "restore-drill teardown failed; no success evidence was published"' "$ROOT_DIR/infra/scripts/restore-drill.sh" | cut -d: -f1)"
marker_line="$(grep -nF "printf 'format=project-conversation-restore-drill-v4" "$ROOT_DIR/infra/scripts/restore-drill.sh" | cut -d: -f1)"
[[ "$verifier_line" =~ ^[0-9]+$ && "$cleanup_line" =~ ^[0-9]+$ && "$marker_line" =~ ^[0-9]+$ \
  && "$verifier_line" -lt "$cleanup_line" && "$cleanup_line" -lt "$marker_line" ]] \
  || die "fixture expected verifier success and teardown before marker publication"
grep -Fq 'write_restore_journal verifying' "$ROOT_DIR/infra/scripts/restore-drill.sh" \
  || die "fixture expected interrupted restored-state verification to remain journal-visible"
if ("$ROOT_DIR/infra/scripts/verify-restored-state.sh" \
  --endpoint https://database.example.invalid \
  --database-name project-conversation-staging \
  --database-identity "$SPACETIMEDB_DATABASE_IDENTITY" \
  --initial-program-hash "$RESTORE_EXPECTED_INITIAL_PROGRAM_HASH" \
  --schema-sha256 "$RESTORE_EXPECTED_MODULE_SCHEMA_SHA256" \
  --owner-token-file "$tmp/not-used" --output "$tmp/not-used.out" >/dev/null 2>&1); then
  die "fixture expected a non-loopback restored-state endpoint to be rejected"
fi
grep -Fq -- "--proto '=http' --noproxy '*' --max-redirs 0" \
  "$ROOT_DIR/infra/scripts/verify-restored-state.sh" \
  || die "fixture expected restored-state HTTP requests to prohibit egress and redirects"
grep -Fq 'schema?version=9' "$ROOT_DIR/infra/scripts/verify-restored-state.sh" \
  || die "fixture expected the restored schema wire format to be explicitly pinned"
grep -Fq '.initial_program == ("0x" + $initial_program_hash)' \
  "$ROOT_DIR/infra/scripts/verify-restored-state.sh" \
  || die "fixture expected restored initialization provenance to be checked"
grep -Fq 'current_module_code=NotVerified' \
  "$ROOT_DIR/infra/scripts/verify-restored-state.sh" \
  || die "fixture expected current module code verification to remain explicitly unverified"
grep -Fq 'FROM \"$table\"' "$ROOT_DIR/infra/scripts/verify-restored-state.sh" \
  || die "fixture expected reserved SQL table identifiers to be quoted"
if grep -Fq 'restore_outbox_invariant' "$ROOT_DIR/spacetimedb/src/views.rs"; then
  die "fixture forbids a public full-history restore invariant view"
fi
if grep -Fq 'SELECT lease_owner, worker_slot_id, lease_until FROM outbox_job' \
  "$ROOT_DIR/infra/scripts/verify-restored-state.sh"; then
  die "fixture forbids unbounded outbox row export during restored-state verification"
fi
grep -Fq 'restore evidence is bounded and cannot authorize a live database upgrade' \
  "$ROOT_DIR/infra/scripts/upgrade.sh" \
  || die "fixture expected bounded traffic-ineligible evidence to block live upgrade"

cp "$archive.manifest" "$tmp/bad.manifest"
printf 'unexpected=value\n' >> "$tmp/bad.manifest"
if (assert_metadata_keys "$tmp/bad.manifest" format created_utc >/dev/null 2>&1); then
  die "fixture expected unexpected metadata to be rejected"
fi

future="$tmp/future"
printf 'future\n' > "$future"
touch -t 209901010000 "$future"
if (assert_not_future_mtime "$future" fixture >/dev/null 2>&1); then
  die "fixture expected a future mtime to be rejected"
fi

if (assert_epoch_utc_pair 999999999999 "$now_utc" overflow >/dev/null 2>&1); then
  die "fixture expected an oversized epoch to be rejected"
fi
if (assert_epoch_utc_pair "$now" 19700101T000000Z mismatch >/dev/null 2>&1); then
  die "fixture expected mismatched signed timestamps to be rejected"
fi

transactional="$tmp/transactional-state"
printf 'old\n' > "$transactional"; chmod 600 "$transactional"; write_checksum_sidecar "$transactional"
printf 'new\n' > "$transactional"; chmod 600 "$transactional"
printf '%s  %s\n' "$(hash_file "$transactional")" "$(basename -- "$transactional")" > "$transactional.publish"
chmod 600 "$transactional.publish"
[[ "$(verify_checksum_sidecar "$transactional")" == "$(hash_file "$transactional")" ]] \
  || die "fixture expected publication-intent checksum recovery"

PUBLIC_WSS_REAL_IP_MODE=not-configured
PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS=192.0.2.1/32
if (require_public_wss_real_ip_config >/dev/null 2>&1); then
  die "fixture expected placeholder public WSS real-IP configuration to fail"
fi
PUBLIC_WSS_REAL_IP_MODE=trusted-reverse-proxy
PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS=127.0.0.1/32
require_public_wss_real_ip_config
PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS=127.0.0.1/32,2606:4700::/32
require_public_wss_real_ip_config
for invalid_cidrs in '::::/' '10.0.0.999/24' '10.0.0.0/33' '1::2::3/64' \
  '2001:db8::/32' '2606:4700::/129' '127.0.0.1/32,,2606:4700::/32'; do
  PUBLIC_WSS_REAL_IP_TRUSTED_CIDRS="$invalid_cidrs"
  if (require_public_wss_real_ip_config >/dev/null 2>&1); then
    die "fixture expected malformed or placeholder public WSS CIDRs to fail: $invalid_cidrs"
  fi
done

path_fixture="$tmp/path-chain"
mkdir -m 755 "$path_fixture"
mkdir -m 755 "$path_fixture/project-conversation"
mkdir -m 700 "$path_fixture/project-conversation/staging"
assert_environment_path_chain "$path_fixture" staging
chmod 775 "$path_fixture/project-conversation"
if (assert_environment_path_chain "$path_fixture" staging >/dev/null 2>&1); then
  die "fixture expected a group-writable project path parent to fail"
fi
chmod 755 "$path_fixture/project-conversation"
chmod 750 "$path_fixture/project-conversation/staging"
if (assert_environment_path_chain "$path_fixture" staging >/dev/null 2>&1); then
  die "fixture expected a non-private environment root to fail"
fi
rm -rf "$path_fixture/project-conversation/staging"
mkdir -m 700 "$path_fixture/real-environment"
ln -s "$path_fixture/real-environment" "$path_fixture/project-conversation/staging"
if (assert_environment_path_chain "$path_fixture" staging >/dev/null 2>&1); then
  die "fixture expected a symlinked environment root to fail"
fi

old_epoch=0
require_upgrade_backup_freshness resume "$old_epoch"
if (require_upgrade_backup_freshness missing "$old_epoch" >/dev/null 2>&1); then
  die "fixture expected stale evidence to fail for a new upgrade transaction"
fi

rollback_prepared_line="$(grep -nF 'write_rollback_state rollback-prepared' "$ROOT_DIR/infra/scripts/rollback.sh" | cut -d: -f1)"
rollback_pin_line="$(grep -nF 'record_reviewed_spacetimedb_image_pin "$previous_image" image-rollback' "$ROOT_DIR/infra/scripts/rollback.sh" | cut -d: -f1)"
[[ "$rollback_prepared_line" =~ ^[0-9]+$ && "$rollback_pin_line" =~ ^[0-9]+$ \
  && "$rollback_prepared_line" -lt "$rollback_pin_line" ]] \
  || die "fixture expected rollback preparation to be journaled before the pin transition"
grep -Fq '"$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" transition_id)" == "rollback-$transition_id"' \
  "$ROOT_DIR/infra/scripts/rollback.sh" \
  || die "fixture expected rollback pin-transition recovery to bind the exact transition"
grep -Fq '"$(metadata_value "$REVIEWED_IMAGE_PIN_FILE" transition_id)" == "$transition_id"' \
  "$ROOT_DIR/infra/scripts/upgrade.sh" \
  || die "fixture expected forward pin-transition recovery to bind the exact transition"

chmod 640 "$marker"
if (assert_private_regular_file "$marker" marker >/dev/null 2>&1); then
  die "fixture expected group-readable evidence to be rejected"
fi

mkdir -m 700 "$tmp/real-parent"
printf 'trusted\n' > "$tmp/real-parent/input"; chmod 600 "$tmp/real-parent/input"
ln -s "$tmp/real-parent" "$tmp/symlink-parent"
if (assert_private_regular_file "$tmp/symlink-parent/input" input >/dev/null 2>&1); then
  die "fixture expected a symlinked parent path to be rejected"
fi

mkdir -m 700 -p "$tmp/operation-root/project-conversation/staging/spacetime" \
  "$tmp/operation-root/project-conversation/staging/state"
export COMPOSE_PROJECT_NAME=project-conversation-staging
export DEPLOY_ENVIRONMENT=staging
export SPACETIMEDB_DATA_DIR="$tmp/operation-root/project-conversation/staging/spacetime"
chmod 770 "$tmp/operation-root/project-conversation/staging"
if (require_state_dir >/dev/null 2>&1); then
  die "fixture expected state access to reject an unsafe environment parent before locking"
fi
chmod 700 "$tmp/operation-root/project-conversation/staging"
record_reviewed_spacetimedb_image_pin "$image" fixture fixture-transition
load_reviewed_spacetimedb_image_pin true >/dev/null
[[ "$SPACETIMEDB_IMAGE" == "$image" && "$REVIEWED_IMAGE_PIN_SHA256" =~ ^[a-f0-9]{64}$ ]]

if command -v flock >/dev/null 2>&1; then
  acquire_operations_lock
  if (exec 9>&-; acquire_operations_lock >/dev/null 2>&1); then
    die "fixture expected the shared operations lock to reject a concurrent mutator"
  fi
fi

dry_env="$tmp/validation.env"
cp "$ROOT_DIR/infra/env/validation.env" "$dry_env"
chmod 600 "$dry_env"
for command in \
  "$ROOT_DIR/infra/scripts/deploy.sh --env-file $dry_env --with-edge --with-worker --with-scanner --with-telemetry" \
  "$ROOT_DIR/infra/scripts/backup.sh --env-file $dry_env" \
  "$ROOT_DIR/infra/scripts/upgrade.sh --env-file $dry_env --image $image --backup /not-used --restore-marker /not-used --ack-forward-only" \
  "$ROOT_DIR/infra/scripts/rollback.sh --env-file $dry_env --ack-schema-compatible"; do
  output="$(bash -c "$command" 2>&1)"
  grep -Fq 'DRY RUN: no mutation performed' <<< "$output" || die "fixture expected guarded dry-run output"
done

grep -Fq '127.0.0.1:${EDGE_LOOPBACK_PORT' "$ROOT_DIR/infra/compose.yaml" \
  || die "fixture expected the edge listener to remain loopback-only"
grep -Fq '__APPROVED_REAL_IP_DIRECTIVES__' "$ROOT_DIR/infra/nginx/edge.conf.template" \
  || die "fixture expected the repository edge template to fail closed before real-IP review"
grep -Fq 'location = /v1/database/${SPACETIMEDB_DATABASE_NAME}/subscribe' \
  "$ROOT_DIR/infra/nginx/edge.conf.template" \
  || die "fixture expected one exact public database subscription route"
[[ "$(grep -Fc 'proxy_pass http://parrot_spacetimedb;' "$ROOT_DIR/infra/nginx/edge.conf.template")" == 1 ]] \
  || die "fixture expected exactly one direct SpacetimeDB proxy route"
grep -Fq 'location / { return 404; }' "$ROOT_DIR/infra/nginx/edge.conf.template" \
  || die "fixture expected the edge to deny unmatched routes"
grep -Fq '/mnt/bigboi/project-conversation/production/backups' \
  "$ROOT_DIR/infra/env/production.env.example" \
  || die "fixture expected production backups on /mnt/bigboi"
grep -Fq 'ConditionPathExists=/srv/project-conversation/%i/state/ALLOW_IMAGE_ROLLBACK' \
  "$ROOT_DIR/infra/systemd/parrot-rollback@.service" \
  || die "fixture expected the rollback unit to require an operator-created one-shot gate"
grep -Fq 'OnCalendar=hourly' "$ROOT_DIR/infra/systemd/parrot-cold-backup@.timer" \
  || die "fixture expected hourly cold-backup scheduling for the approved RPO"
for mount in GATEWAY_STATE_DIR WORKER_STATE_DIR OBJECT_DATA_DIR EXPORT_DATA_DIR; do
  grep -Fq 'source: ${'"$mount" "$ROOT_DIR/infra/compose.yaml" \
    || die "fixture expected an explicit durable provider mount: $mount"
done
[[ "$(grep -Fc 'target: /var/lib/parrot/objects' "$ROOT_DIR/infra/compose.yaml")" == 2 ]] \
  || die "fixture expected gateway and worker to share the exact private object-store mount"
grep -Fq 'LOCAL_OBJECT_ROOT: /var/lib/parrot/objects' "$ROOT_DIR/infra/compose.yaml" \
  || die "fixture expected gateway capabilities to use the shared object-store root"
grep -Fq 'PARROT_BIG_ROOT: /var/lib/parrot' "$ROOT_DIR/infra/compose.yaml" \
  || die "fixture expected worker providers to resolve the shared object-store root"
grep -Fq 'CLAMAV_SOCKET: /run/clamav/clamd.sock' "$ROOT_DIR/infra/compose.yaml" \
  || die "fixture expected worker scanning through the private Unix socket"
if grep -Fq 'CLAMAV_PORT:' "$ROOT_DIR/infra/compose.yaml"; then
  die "fixture forbids the stale ClamAV TCP provider configuration"
fi
grep -Fq 'OLLAMA_ENDPOINT: http://127.0.0.1:11434' "$ROOT_DIR/infra/compose.yaml" \
  || die "fixture expected the worker provider to retain its loopback-only endpoint"
grep -Fq 'up --detach --no-deps --force-recreate ollama-loopback' \
  "$ROOT_DIR/infra/scripts/deploy.sh" \
  || die "fixture expected every worker deployment to rebind its loopback sidecar"
grep -Fq 'up --detach --no-deps --force-recreate edge' "$ROOT_DIR/infra/scripts/deploy.sh" \
  || die "fixture expected every gateway-and-edge deployment to refresh edge DNS state"
grep -Fq 'external edge liveness gate failed' "$ROOT_DIR/infra/scripts/deploy.sh" \
  || die "fixture expected an external liveness gate after edge recreation"
grep -Fq 'UNIX-LISTEN:/srv/project-conversation/%i/state/worker/ollama-bridge/ollama.sock' \
  "$ROOT_DIR/infra/systemd/parrot-ollama-bridge@.service" \
  || die "fixture expected a native Unix-only Ollama bridge"
grep -Fq 'OIDC_ALLOW_MISSING_TYP=false' "$ROOT_DIR/infra/env/staging.env.example" \
  || die "fixture expected missing JOSE typ to remain explicit and disabled in the public example"
grep -Fq 'OIDC_ALLOW_CLIENT_ID_AUDIENCE=false' "$ROOT_DIR/infra/env/staging.env.example" \
  || die "fixture expected client-ID audience compatibility to remain explicit and disabled in the public example"
grep -Fq 'object-capabilities/(?:upload|download)/[A-Za-z0-9_-]{40,4096}' \
  "$ROOT_DIR/infra/nginx/edge.conf.template" \
  || die "fixture expected only bounded signed object data-plane routes at the edge"
grep -Fq 'valueSecretFiles = new Map([["READINESS_TOKEN_FILE", "READINESS_TOKEN"]])' \
  "$ROOT_DIR/infra/docker/gateway-entrypoint.mjs" \
  || die "fixture expected secret dereferencing to use an exact allowlist"
if grep -Fq 'name.endsWith("_FILE")' "$ROOT_DIR/infra/docker/gateway-entrypoint.mjs"; then
  die "fixture forbids dereferencing arbitrary secret-file references into environment values"
fi

bad_env="$tmp/bad-backup.env"
sed 's#BACKUP_DIR=/mnt/bigboi/project-conversation/staging/backups#BACKUP_DIR=/srv/project-conversation/staging/backups#' \
  "$dry_env" > "$bad_env"
chmod 600 "$bad_env"
if ("$ROOT_DIR/infra/scripts/validate-config.sh" --env-file "$bad_env" >/dev/null 2>&1); then
  die "fixture expected backups outside /mnt/bigboi to fail"
fi

bad_ports="$tmp/bad-ports.env"
sed 's/EDGE_LOOPBACK_PORT=39190/EDGE_LOOPBACK_PORT=4789/' "$dry_env" > "$bad_ports"
chmod 600 "$bad_ports"
if ("$ROOT_DIR/infra/scripts/validate-config.sh" --env-file "$bad_ports" >/dev/null 2>&1); then
  die "fixture expected the unrelated SpacetimeDB port to be rejected for the edge"
fi

printf 'Static infrastructure safety fixtures passed.\n'
