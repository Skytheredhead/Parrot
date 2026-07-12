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
  --profile worker \
  --profile telemetry \
  config --format json)"

node -e '
  const config = JSON.parse(process.argv[1]);
  const database = config.services.spacetimedb.networks;
  const telemetry = config.services["otel-collector"].networks;
  const worker = config.services.worker.networks;
  if (!("backend" in database) || "telemetry" in database) process.exit(1);
  if (!("telemetry" in telemetry) || !("egress" in telemetry) || "backend" in telemetry) {
    process.exit(1);
  }
  if (!("backend" in worker) || !("telemetry" in worker) || !("egress" in worker)) {
    process.exit(1);
  }
  if (config.services.worker.ports) process.exit(1);
' "$rendered"

echo "Infrastructure static safety and network-isolation checks passed"
