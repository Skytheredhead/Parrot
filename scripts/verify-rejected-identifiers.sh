#!/usr/bin/env bash
set -euo pipefail

roots=(apps services packages spacetimedb infra .github)
existing=()

for root in "${roots[@]}"; do
  if [[ -e "$root" ]]; then
    existing+=("$root")
  fi
done

if [[ ${#existing[@]} -eq 0 ]]; then
  exit 0
fi

if rg -n -I --hidden \
  --glob '!target/**' \
  --glob '!node_modules/**' \
  --glob '!dist/**' \
  '(?i)(@slic/|\bslic[-_]|\bslick\b)' \
  "${existing[@]}"; then
  echo "Rejected legacy product identifiers found. Use Parrot publicly or project-conversation internally." >&2
  exit 1
fi
