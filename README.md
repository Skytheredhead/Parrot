# Project Conversation

`project-conversation` is the neutral internal codename for a post-first, agent-native team communication platform. No public product name has been approved.

The core model is:

```text
Workspace → Space → Post → Named thread → Contribution → Contextual reply
                         ↘ Decision / Task / File / Agent run
```

Spaces show substantial posts rather than an endless stream of every message. A post can contain several bounded threads, and human or agent work remains attached to its source context, outcomes, files, permissions, and audit history.

## Current status

The repository is in active development. Source research, product options, architecture ADRs, and
the provider-neutral database, gateway, worker, authentication-integration, and guarded operations
foundations are implemented and tested. Durable provider adapters and the selected frontend
direction remain before a release candidate exists.

Do not use this repository as a production service yet.

## Repository map

- `docs/research/` — source analysis, user evidence, competitive models, naming research, and product thesis.
- `docs/decisions/` — architecture and product decision records.
- `docs/operations/` — server audit, deployment, backup, restore, and recovery plans.
- `infra/` — provider-neutral, loopback-only Compose candidate with guarded operations scripts.
- `spacetimedb/` — Rust authoritative real-time module.
- `services/gateway/` — browser-facing security, file, search, and agent gateway.
- `services/worker/` — outbox-driven external effect workers.
- `packages/db-bindings/` — generated, caller-safe TypeScript bindings for the Rust module.
- `apps/web/` — selected Next.js application direction; intentionally not scaffolded until the visual decision is made.

## Prerequisites

- Node.js 24.x
- pnpm 10.10.x
- Rust 1.93.0 with `wasm32-unknown-unknown`, pinned for the SpacetimeDB 2.6.1 module
- Docker for isolated local and deployment preflight environments

## Local checks

Install the checksum-pinned Node.js runtime and JavaScript dependencies:

```bash
scripts/install-node.sh
scripts/install-spacetime-cli.sh
scripts/install-binaryen.sh
rustup toolchain install 1.93.0 --profile minimal --component rustfmt,clippy \
  --target wasm32-unknown-unknown
export PATH="$PWD/.tools/node/current/bin:$PWD/.tools/binaryen/version_130/bin:$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN=1.93.0
pnpm install
pnpm verify:toolchain
pnpm check
```

Rust and binding-generation commands are documented in `spacetimedb/README.md`.

## Security

- Never commit `.env` files, credentials, signing keys, provider tokens, or signed URLs.
- Sensitive multi-tenant state stays in private SpacetimeDB tables and is exposed only through authorized views or the gateway.
- Search, object storage, notifications, and model providers are derived systems and never authorization authorities.
- Agent actions use explicit scopes, approvals, idempotency, audit records, and revocation checks.

See the ADRs in `docs/decisions/` for the current design. Legal, privacy, retention, provider, domain, repository, and public-name choices remain approval-gated.
