#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
validator="${root}/scripts/validate-production-bootstrap-env.mjs"

expect_rejected() {
  local label="$1" issuer="$2" audience="$3" subject="$4"
  if PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER="$issuer" \
    PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE="$audience" \
    PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT="$subject" \
    node "$validator" >/dev/null 2>&1; then
    echo "Production build guard accepted $label" >&2
    exit 1
  fi
}

expect_rejected "known synthetic values" \
  https://issuer.test project-conversation-ci ci-owner
expect_rejected "a reserved example issuer" \
  https://identity.example.com/tenant project-conversation-production operator-123
expect_rejected "a percent-encoded issuer" \
  https://identity.production-check.dev/%74enant project-conversation-production operator-123
expect_rejected "a Unicode issuer" \
  https://idéntity.production-check.dev/tenant project-conversation-production operator-123
long_issuer="https://identity.production-check.dev/$(printf 'a%.0s' {1..480})"
expect_rejected "an issuer longer than the Rust limit" \
  "$long_issuer" project-conversation-production operator-123

PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER=https://identity.production-check.dev/tenant \
  PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE=project-conversation-production \
  PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT=operator-123 \
  node "$validator" >/dev/null

echo "Production bootstrap build guard rejects synthetic configuration"
