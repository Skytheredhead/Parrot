#!/usr/bin/env bash
set -euo pipefail

forbidden_files="$({
  git ls-files
  git ls-files --others --exclude-standard
} | sort -u | rg '(^|/)(\.env($|\.)|secrets?/)|\.(rtf|pem|key|p12|pfx)$' | rg -v '(^|/)\.env\.example$' || true)"

if [[ -n "$forbidden_files" ]]; then
  echo "Forbidden secret-bearing file paths are present:" >&2
  echo "$forbidden_files" >&2
  exit 1
fi

roots=(.editorconfig .env.example .gitattributes .github .gitignore .npmrc README.md apps docs infra package.json packages pnpm-workspace.yaml scripts services spacetimedb)
existing=()

for root in "${roots[@]}"; do
  if [[ -e "$root" ]]; then
    existing+=("$root")
  fi
done

if rg -n -I --hidden \
  --glob '!.git/**' \
  --glob '!target/**' \
  --glob '!node_modules/**' \
  --glob '!dist/**' \
  --glob '!pnpm-lock.yaml' \
  '(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' \
  "${existing[@]}"; then
  echo "A high-confidence secret pattern was found." >&2
  exit 1
fi
