# Project Conversation

`project-conversation` is the neutral internal codename for a post-first, agent-native team communication platform. No public product name has been approved.

The core model is:

```text
Workspace → Space → Post → Named thread → Contribution → Contextual reply
                         ↘ Decision / Task / File / Agent run
```

Spaces show substantial posts rather than an endless stream of every message. A post can contain several bounded threads, and human or agent work remains attached to its source context, outcomes, files, permissions, and audit history.

## Current status

The repository is in active development. Source research, product options, architecture ADRs, deployment planning, and the first backend foundations are being built before the selected frontend direction is implemented.

Do not use this repository as a production service yet.

## Repository map

- `docs/research/` — source analysis, user evidence, competitive models, naming research, and product thesis.
- `docs/decisions/` — architecture and product decision records.
- `docs/operations/` — server audit and production plan.
- `spacetimedb/` — Rust authoritative real-time module.
- `services/gateway/` — browser-facing security, file, search, and agent gateway.
- `services/worker/` — outbox-driven external effect workers.
- `apps/web/` — selected Next.js application direction; intentionally not scaffolded until the visual decision is made.

## Prerequisites

- Node.js 24.x
- pnpm 10.10.x
- Rust toolchain compatible with the pinned SpacetimeDB 2.6.1 module
- Docker for isolated local and deployment preflight environments

## Local checks

Install JavaScript dependencies after service manifests exist:

```bash
pnpm install
pnpm check
```

Rust commands are documented in `spacetimedb/README.md` once the module foundation lands.

## Security

- Never commit `.env` files, credentials, signing keys, provider tokens, or signed URLs.
- Sensitive multi-tenant state stays in private SpacetimeDB tables and is exposed only through authorized views or the gateway.
- Search, object storage, notifications, and model providers are derived systems and never authorization authorities.
- Agent actions use explicit scopes, approvals, idempotency, audit records, and revocation checks.

See the ADRs in `docs/decisions/` for the current design. Legal, privacy, retention, provider, domain, repository, and public-name choices remain approval-gated.
