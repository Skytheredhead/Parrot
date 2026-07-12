#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

bash -n infra/scripts/*.sh infra/tests/*.sh
bash infra/tests/static-safety.sh
bash infra/scripts/validate-config.sh --env-file infra/env/validation.env
bash infra/scripts/validate-config.sh --env-file infra/env/validation.env --profile gateway
bash infra/scripts/validate-config.sh --env-file infra/env/validation.env --profile worker
bash infra/scripts/validate-config.sh --env-file infra/env/validation.env --profile telemetry
bash infra/scripts/validate-config.sh --env-file infra/env/validation.env \
  --profile gateway --profile worker --profile telemetry

rendered="$(docker compose \
  --project-name project-conversation-staging \
  --env-file infra/env/validation.env \
  --file infra/compose.yaml \
  --profile gateway \
  --profile edge \
  --profile worker \
  --profile telemetry \
  config --format json)"

edge_config="$(mktemp)"
trap 'rm -f "$edge_config"' EXIT
sed \
  -e 's#__APPROVED_REAL_IP_DIRECTIVES__#set_real_ip_from 127.0.0.1/32;\nreal_ip_header CF-Connecting-IP;\nreal_ip_recursive off;#' \
  -e 's#${EDGE_SERVER_NAME}#parrotapi.example.test#g' \
  -e 's#${SPACETIMEDB_DATABASE_NAME}#project-conversation-validation#g' \
  infra/nginx/edge.conf.template > "$edge_config"
if docker info >/dev/null 2>&1; then
  docker run --rm \
    --entrypoint nginx \
    --add-host gateway:127.0.0.1 \
    --add-host spacetimedb:127.0.0.1 \
    --volume "$edge_config:/etc/nginx/conf.d/default.conf:ro" \
    nginx:1.28.0-alpine@sha256:09ab424a8c788f8d0fe3a64429f6d19dfa526885c8609b748d0943a75dcb9f8c \
    -t
fi

node -e '
  const config = JSON.parse(process.argv[1]);
  const database = config.services.spacetimedb.networks;
  const telemetry = config.services["otel-collector"].networks;
  const worker = config.services.worker.networks;
  const edge = config.services.edge.networks;
  if (!("backend" in database) || "telemetry" in database) process.exit(1);
  if (!("telemetry" in telemetry) || !("egress" in telemetry) || "backend" in telemetry) {
    process.exit(1);
  }
  if (!("backend" in worker) || !("telemetry" in worker) || !("egress" in worker)) {
    process.exit(1);
  }
  if (config.services.worker.ports) process.exit(1);
  if (!("backend" in edge) || !("ingress" in edge) || "egress" in edge || "telemetry" in edge) {
    process.exit(1);
  }
' "$rendered"

echo "Infrastructure static safety and network-isolation checks passed"
