#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

endpoint=""; database_name=""; expected_identity=""; expected_initial_program_hash=""; expected_schema_sha256=""; owner_token_file=""; output=""
while (($#)); do
  case "$1" in
    --endpoint) [[ $# -ge 2 ]] || die "--endpoint requires a URL"; endpoint="$2"; shift 2 ;;
    --database-name) [[ $# -ge 2 ]] || die "--database-name requires a value"; database_name="$2"; shift 2 ;;
    --database-identity) [[ $# -ge 2 ]] || die "--database-identity requires a value"; expected_identity="$2"; shift 2 ;;
    --initial-program-hash) [[ $# -ge 2 ]] || die "--initial-program-hash requires a value"; expected_initial_program_hash="$2"; shift 2 ;;
    --schema-sha256) [[ $# -ge 2 ]] || die "--schema-sha256 requires a value"; expected_schema_sha256="$2"; shift 2 ;;
    --owner-token-file) [[ $# -ge 2 ]] || die "--owner-token-file requires a path"; owner_token_file="$2"; shift 2 ;;
    --output) [[ $# -ge 2 ]] || die "--output requires a path"; output="$2"; shift 2 ;;
    -h|--help)
      printf 'Usage: %s --endpoint http://127.0.0.1:PORT --database-name NAME --database-identity HEX --initial-program-hash HEX --schema-sha256 HEX --owner-token-file PATH --output PATH\n' "$0"
      exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$endpoint" =~ ^http://127\.0\.0\.1:[0-9]{4,5}$ ]] \
  || die "restored-state verification endpoint must be an explicit loopback HTTP port"
[[ "$database_name" =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]] || die "invalid database name"
[[ "$expected_identity" =~ ^[a-f0-9]{64}$ ]] || die "invalid expected database identity"
[[ "$expected_initial_program_hash" =~ ^[a-f0-9]{64}$ ]] || die "invalid expected initial program hash"
[[ "$expected_schema_sha256" =~ ^[a-f0-9]{64}$ ]] || die "invalid expected schema digest"
[[ -n "$output" && ! -e "$output" && ! -L "$output" \
  && ! -e "$output.partial" && ! -L "$output.partial" ]] \
  || die "verification output and partial path must not already exist"
assert_trusted_directory "$(dirname -- "$output")" "restored-state verification output directory" true
assert_private_regular_file "$owner_token_file" "restore verifier database-owner token"
command -v curl >/dev/null 2>&1 || die "curl is required for restored-state verification"
command -v jq >/dev/null 2>&1 || die "jq is required for restored-state verification"

token=""; token_line_count="$(awk 'END { print NR + 0 }' "$owner_token_file")"
IFS= read -r token < "$owner_token_file" || true
[[ "$token_line_count" == 1 && -n "$token" && ${#token} -le 16384 && "$token" != *[[:space:]]* \
  && "$token" == *.*.* ]] || die "restore verifier token must be one bounded JWT line"

workdir="$(mktemp -d "$(dirname -- "$output")/.restored-state-verifier.XXXXXX")"
chmod 700 "$workdir"
cleanup() { rm -f -- "$output.partial"; rm -rf -- "$workdir"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
header_file="$workdir/authorization.header"
printf 'Authorization: Bearer %s\n' "$token" > "$header_file"
chmod 600 "$header_file"
unset token

curl_get() {
  local path="$1" destination="$2"
  curl --proto '=http' --noproxy '*' --max-redirs 0 --connect-timeout 5 --max-time 30 \
    --fail --silent --show-error --output "$destination" "$endpoint$path"
  chmod 600 "$destination"
}

sql_response() {
  local query="$1" destination="$2" request="$workdir/request.sql"
  printf '%s\n' "$query" > "$request"
  chmod 600 "$request"
  curl --proto '=http' --noproxy '*' --max-redirs 0 --connect-timeout 5 --max-time 60 \
    --fail --silent --show-error --header "@$header_file" --header 'Content-Type: text/plain' \
    --data-binary "@$request" --output "$destination" \
    "$endpoint/v1/database/$database_name/sql"
  chmod 600 "$destination"
  : > "$request"
}

sql_count() {
  local query="$1" response="$workdir/sql-response.json" count
  sql_response "$query" "$response"
  count="$(jq -er '
    if (type == "array" and length == 1
      and (.[0].rows | type) == "array" and (.[0].rows | length) == 1
      and (.[0].rows[0] | type) == "array" and (.[0].rows[0] | length) == 1)
    then .[0].rows[0][0] | tostring
    else error("unexpected aggregate result shape")
    end
  ' "$response")" || die "restored-state aggregate result shape is unsupported"
  : > "$response"
  [[ "$count" =~ ^[0-9]{1,16}$ ]] || die "restored-state aggregate is invalid or exceeds the bounded count range"
  printf '%s\n' "$count"
}

database_info="$workdir/database.json"
curl_get "/v1/database/$database_name" "$database_info"
jq -e --arg identity "$expected_identity" --arg initial_program_hash "$expected_initial_program_hash" \
  '.database_identity.__identity__ == ("0x" + $identity)
    and (.host_type | type == "object" and has("Wasm"))
    and .initial_program == ("0x" + $initial_program_hash)' \
  "$database_info" >/dev/null || die "restored database identity or initialization provenance does not match"
: > "$database_info"

schema="$workdir/schema.json"; canonical_schema="$workdir/schema.canonical.json"
curl_get "/v1/database/$database_name/schema?version=9" "$schema"
jq -S -c . "$schema" > "$canonical_schema" || die "restored module schema is not valid JSON"
chmod 600 "$canonical_schema"
actual_schema_sha256="$(hash_file "$canonical_schema")"
[[ "$actual_schema_sha256" == "$expected_schema_sha256" ]] \
  || die "restored module/schema digest differs from the reviewed digest"
jq -e '
  [.reducers[]?.name] as $reducers
  | all(["claim_outbox_job", "heartbeat_outbox_job", "recover_outbox_job", "complete_outbox_job"][];
      . as $required | $reducers | index($required) != null)
' "$schema" >/dev/null || die "restored module lacks the reviewed outbox lease recovery reducers"
: > "$schema"; : > "$canonical_schema"

required_private_table_count=0
while IFS= read -r table; do
  [[ -n "$table" ]] || continue
  sql_count "SELECT COUNT(*) AS n FROM \"$table\"" > "$workdir/count-$table"
  chmod 600 "$workdir/count-$table"
  required_private_table_count=$((required_private_table_count + 1))
done <<'TABLES'
auth_policy
bootstrap_authority
platform_authority
pending_operator_transfer
platform_command_receipt
platform_audit_log
user
workspace
workspace_lifecycle
workspace_lifecycle_drain_schedule
workspace_member
space
space_member
post
post_tag
post_mention
post_reaction
post_user_state
post_pin
post_activity
poll
poll_option
poll_vote
named_thread
contribution
reply_ancestry
direct_conversation
direct_participant
direct_message
direct_reply_ancestry
direct_read_state
dm_promotion_proposal
dm_promotion_source
dm_promotion_consent
decision_record
task_item
notification
notification_control
notification_group
notification_delivery_permit
notification_preference
presence_session
current_presence
presence_expiry_schedule
service_principal
service_grant
agent_installation
agent_scope
agent_tool_policy
trusted_tool
agent_run
agent_run_event
agent_context_manifest
agent_tool_call
approval_request
effect_ledger
outbox_job
search_document_snapshot
file_record
file_version
file_upload
audit_log
command_receipt
TABLES
[[ "$required_private_table_count" == 63 ]] || die "internal required private-table inventory drifted"

domain_invariant_count=0
while IFS='|' read -r child parent child_column parent_column; do
  [[ -n "$child" ]] || continue
  child_count="$(<"$workdir/count-$child")"
  matched_count="$(sql_count "SELECT COUNT(*) AS n FROM \"$child\" child JOIN \"$parent\" parent ON child.\"$child_column\" = parent.\"$parent_column\"")"
  [[ "$child_count" == "$matched_count" ]] \
    || die "restored-state cross-reference invariant failed: $child.$child_column -> $parent.$parent_column"
  domain_invariant_count=$((domain_invariant_count + 1))
done <<'INVARIANTS'
workspace_member|workspace|workspace_id|id
workspace_lifecycle|workspace|workspace_id|id
workspace_lifecycle_drain_schedule|workspace_lifecycle|workspace_id|workspace_id
space|workspace|workspace_id|id
space_member|space|space_id|id
post|workspace|workspace_id|id
post|space|space_id|id
post_tag|post|post_id|id
post_mention|post|post_id|id
post_reaction|post|post_id|id
post_user_state|post|post_id|id
post_pin|post|post_id|id
post_activity|post|post_id|id
poll|post|post_id|id
poll_option|poll|post_id|post_id
poll_vote|poll|post_id|post_id
poll_vote|poll_option|option_id|id
named_thread|workspace|workspace_id|id
named_thread|space|space_id|id
named_thread|post|root_post_id|id
contribution|workspace|workspace_id|id
contribution|named_thread|thread_id|id
reply_ancestry|named_thread|thread_id|id
direct_conversation|workspace|workspace_id|id
direct_participant|direct_conversation|conversation_id|id
direct_participant|workspace|workspace_id|id
direct_message|direct_conversation|conversation_id|id
direct_message|workspace|workspace_id|id
direct_reply_ancestry|direct_conversation|conversation_id|id
direct_read_state|direct_conversation|conversation_id|id
dm_promotion_proposal|direct_conversation|conversation_id|id
dm_promotion_source|dm_promotion_proposal|proposal_id|id
dm_promotion_consent|dm_promotion_proposal|proposal_id|id
decision_record|workspace|workspace_id|id
task_item|workspace|workspace_id|id
notification|workspace|workspace_id|id
notification_control|notification|notification_id|id
notification_control|workspace|workspace_id|id
notification_group|notification|notification_id|id
notification_delivery_permit|outbox_job|job_id|id
notification_delivery_permit|notification|notification_id|id
notification_delivery_permit|workspace|workspace_id|id
notification_preference|workspace|workspace_id|id
presence_session|workspace|workspace_id|id
current_presence|workspace|workspace_id|id
presence_expiry_schedule|presence_session|presence_key|key
service_grant|workspace|workspace_id|id
agent_installation|workspace|workspace_id|id
agent_scope|agent_installation|installation_id|id
agent_tool_policy|agent_installation|installation_id|id
agent_run|workspace|workspace_id|id
agent_run|agent_installation|installation_id|id
agent_run_event|agent_run|run_id|id
agent_context_manifest|agent_run|run_id|id
agent_tool_call|agent_run|run_id|id
approval_request|agent_run|run_id|id
effect_ledger|agent_tool_call|tool_call_id|id
outbox_job|workspace|workspace_id|id
search_document_snapshot|workspace|workspace_id|id
search_document_snapshot|space|space_id|id
file_record|workspace|workspace_id|id
file_record|space|space_id|id
file_version|file_record|file_id|id
file_version|workspace|workspace_id|id
file_upload|file_record|file_id|id
file_upload|workspace|workspace_id|id
audit_log|workspace|workspace_id|id
INVARIANTS
[[ "$domain_invariant_count" == 67 ]] || die "internal restored-state invariant inventory drifted"

umask 077
{
  printf 'format=project-conversation-restored-state-verification-v1\n'
  printf 'database_identity=%s\n' "$expected_identity"
  printf 'initial_program_hash=%s\n' "$expected_initial_program_hash"
  printf 'current_module_code=NotVerified\n'
  printf 'module_schema_sha256=%s\n' "$actual_schema_sha256"
  printf 'required_private_tables=Pass\n'
  printf 'required_private_table_count=%s\n' "$required_private_table_count"
  printf 'domain_invariants=Pass\n'
  printf 'domain_invariant_count=%s\n' "$domain_invariant_count"
  printf 'outbox_lease_recovery_shape=NotVerified\n'
  printf 'audit_continuity=BoundedReferentialOnly\n'
  printf 'deletion_lifecycle_overlay=NotConfigured\n'
  printf 'traffic_eligible=false\n'
  printf 'result=BoundedRestoreStateVerified\n'
} > "$output.partial"
chmod 600 "$output.partial"
validate_restored_state_verification \
  "$output.partial" "$expected_identity" "$expected_initial_program_hash" "$expected_schema_sha256"
mv -- "$output.partial" "$output"
note "Bounded restored-state verification passed without emitting table rows or cardinalities."
