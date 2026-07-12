#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

env_file=""
profiles=()
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || die "--env-file requires a path"; env_file="$2"; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || die "--profile requires a name"; profiles+=("$2"); shift 2 ;;
    -h|--help) printf 'Usage: %s --env-file PATH [--profile gateway|edge|worker|scanner|telemetry]\n' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$env_file" ]] || die "--env-file is required"

validation=("$SCRIPT_DIR/validate-config.sh" --env-file "$env_file" --runtime)
for profile in ${profiles[@]+"${profiles[@]}"}; do validation+=(--profile "$profile"); done
"${validation[@]}"
load_env_file "$env_file"
require_base_identity
load_reviewed_spacetimedb_image_pin false >/dev/null || true

docker_arch="$(docker info --format '{{.Architecture}}')"
[[ "$docker_arch" == x86_64 || "$docker_arch" == amd64 ]] || die "the recorded SpacetimeDB digest is Linux/amd64-only; Docker reports $docker_arch"
docker compose version
note "Host: $(uname -srm)"
note "Disk for /srv:"
df -h /srv
note "Inodes for /srv:"
df -i /srv
note "Backup filesystem on /mnt/bigboi:"
df -h /mnt/bigboi
df -i /mnt/bigboi

read -r disk_available_kb disk_used_percent < <(df -Pk /srv | awk 'NR==2 {gsub(/%/,"",$5); print $4, $5}')
(( disk_available_kb >= 25 * 1024 * 1024 )) || die "less than the provisional 25 GiB free-disk floor remains on /srv"
(( disk_used_percent < 90 )) || die "/srv filesystem is at or above the provisional 90% usage ceiling"
inode_used_percent="$(df -Pi /srv | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
(( inode_used_percent < 90 )) || die "/srv filesystem is at or above the provisional 90% inode ceiling"
read -r backup_available_kb backup_used_percent < <(df -Pk /mnt/bigboi | awk 'NR==2 {gsub(/%/,"",$5); print $4, $5}')
(( backup_available_kb >= 25 * 1024 * 1024 )) || die "less than the provisional 25 GiB backup headroom remains on /mnt/bigboi"
(( backup_used_percent < 90 )) || die "/mnt/bigboi filesystem is at or above the provisional 90% usage ceiling"

while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  label="$(docker inspect --format '{{ index .Config.Labels "com.project-conversation.stack" }}' "$id")"
  environment="$(docker inspect --format '{{ index .Config.Labels "com.project-conversation.environment" }}' "$id")"
  role="$(docker inspect --format '{{ index .Config.Labels "com.project-conversation.role" }}' "$id")"
  [[ "$label" == true && "$environment" == "$DEPLOY_ENVIRONMENT" ]] || die "Compose project name is already used by a container outside this environment: $id"
  case "$role" in spacetimedb|gateway|edge|telemetry|worker|clamav|ollama-loopback) ;; *) die "unrecognized role in approved Compose project: $role" ;; esac
done < <(docker ps --all --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")

for network in "${COMPOSE_PROJECT_NAME}_ingress" "${COMPOSE_PROJECT_NAME}_backend" "${COMPOSE_PROJECT_NAME}_telemetry" "${COMPOSE_PROJECT_NAME}_egress"; do
  if docker network inspect "$network" >/dev/null 2>&1; then
    label="$(docker network inspect --format '{{ index .Labels "com.project-conversation.stack" }}' "$network")"
    environment="$(docker network inspect --format '{{ index .Labels "com.project-conversation.environment" }}' "$network")"
    [[ "$label" == true && "$environment" == "$DEPLOY_ENVIRONMENT" ]] || die "network name collision outside the approved project: $network"
  fi
done


for role in clamav-database clamav-runtime; do
  volume="${COMPOSE_PROJECT_NAME}_${role}"
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    label="$(docker volume inspect --format '{{ index .Labels "com.project-conversation.stack" }}' "$volume")"
    environment="$(docker volume inspect --format '{{ index .Labels "com.project-conversation.environment" }}' "$volume")"
    observed_role="$(docker volume inspect --format '{{ index .Labels "com.project-conversation.role" }}' "$volume")"
    [[ "$label" == true && "$environment" == "$DEPLOY_ENVIRONMENT" && "$observed_role" == "$role" ]] \
      || die "volume name collision outside the approved project: $volume"
  fi
done

for port in "$SPACETIMEDB_LOOPBACK_PORT" "$GATEWAY_LOOPBACK_PORT" "$EDGE_LOOPBACK_PORT"; do
  if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$port" | grep -q .; then
    if ! compose ps --format json 2>/dev/null | grep -q "127.0.0.1:$port"; then
      die "loopback port $port is already in use outside the approved Compose project"
    fi
    note "Port $port is already held by this Compose project."
  fi
done

if command -v ss >/dev/null 2>&1 && ss -ltnH 'sport = :4789' | grep -q .; then
  note "Observed audited unrelated service on port 4789; it is intentionally untouched."
else
  note "Port 4789 is reserved for the audited unrelated service even though no listener was observed."
fi
note "Read-only preflight passed. No service, proxy, firewall, DNS, or data was changed."
