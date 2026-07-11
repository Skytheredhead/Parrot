# Production requirements matrix

Last updated: 2026-07-11

Status values: `complete`, `in progress`, `blocked on decision`, `not started`, `unverified`.

This matrix prevents a successful build or attractive screen from being mistaken for the requested production outcome.

| Area | Required proof | Status | Current evidence / next gate |
|---|---|---|---|
| Source thesis | Timestamped Theo analysis that separates requests, suggestions, criticisms, unknowns, and inferences | complete | `docs/research/theo-source-analysis.md` |
| Market/user research | 8 videos, 15 X posts, 20 Reddit discussions, official competitor evidence, contradictions and limitations | complete | `docs/research/source-ledger.md`, `user-pain-points.md`, `competitive-models.md` |
| Product model | User-selected or explicitly combined IA model | blocked on decision | Three models in `docs/decisions/initial-information-architecture.md` and three rendered boards shown in task |
| Visual system | User-selected or explicitly combined visual direction | blocked on decision | `docs/research/visual-directions.md` and rendered desktop/mobile boards |
| Public name | User-selected candidate plus professional legal clearance | blocked on decision | Preliminary shortlist only; `project-conversation` remains mandatory |
| Repository | Approved GitHub owner, name, private/public visibility, clean pushed history | blocked on decision | Local `codex/project-conversation`; no remote by design |
| Frontend | Selected Next.js App Router experience, marketing/legal/error pages, desktop/tablet/mobile/PWA | not started | UI implementation intentionally gated on selection |
| Authentication | Verified email, recovery, revocable sessions, invitations, onboarding and OIDC integration | in progress | Gateway discards JWT privilege claims, resolves current principals authoritatively, enforces access-token profile and session-bound CSRF; exact 2.6.1 standalone integration proves claim rejection, first-owner bootstrap, recipient-accepted platform handoff, SQL, and WebSocket auth; issuer/audience remain immutable online; selected provider and product flows remain |
| Workspaces/spaces | Multi-workspace roles, public/private spaces, membership, audit, presence and unread behavior | in progress | Rust role/private-space authority and caller-aware Views compile and publish on 2.6.1; presence/unread and UI remain |
| Post-first feed | Rich posts, types, files, mentions, reactions, following, bookmarks, lifecycle, sorting/filtering | in progress | Titled posts and authorized Views publish on 2.6.1; remaining social primitives and UI are pending |
| Threads/replies | Multiple bounded threads, contextual replies, realtime ordering, edits/deletes, recovery | in progress | Multiple named threads and full ancestry are represented; independent state/lease critic and browser recovery remain |
| Home/inbox | Needs-me, ambient unread, assignments, decisions, agent results, saved and catch-up | in progress | Notification ADR/module lane; UI pending |
| Search | Object-aware filters, permission-safe indexing/query/previews/counts and rebuild | in progress | Signed identity/query/workspace/epoch-bound cursors, field/response budgets, per-result reauthorization and worker shadow rebuilds are tested; durable adapters pending |
| DMs | One-to-one/group private conversation and consensual promotion to post | not started | Model/authorization defined; implementation pending |
| Files | Quarantined multipart upload, validation, scanning, previews, signed download, quota/deletion/cleanup | in progress | Mandatory checksums, first-write constraints, exact observed versions, lifecycle-oracle protection, authoritative worker plans and bounded streaming are tested; selected storage/scan provider proofs pending |
| Agents | Identity, installation, scopes, bounded context, run lifecycle, approvals, tools, budgets, provenance | in progress | Exact gateway tool scope, bounded/cancelable worker loop, context manifest, approvals and atomic final commit are tested; Rust authority P0 remediation and durable providers remain |
| Realtime reliability | Explicit connection state, idempotency, receipts, ordering, reconnect/recovery and concurrency | in progress | ADR and Rust module lane; browser integration pending |
| Notifications | Finite tiers, preferences, digest, deduplicated delivery, retry/dead letter | in progress | Rust/worker lanes; email/push providers pending |
| Administration | Members/roles/invites/private spaces/agents/sessions/audit/retention/export/delete | not started | Authority model in progress; UI and provider flows pending |
| Threat model | Repo-grounded final threat model validated against user context | blocked on decision | Assumption validation questions still required before final report |
| Automated tests | Rust/unit/integration/browser/security/accessibility/reliability/backup/production suites | in progress | Worker 67/67, gateway 43/43, Rust policy 30/30, exact 2.6.1 signed-OIDC reducer/SQL/WSS integration, fresh-host publish, binding drift, production-package, and signed infra-tamper gates pass; browser/staging fault-injection/full restore suites remain |
| Accessibility | WCAG 2.2 AA audit, keyboard, screen reader, reduced motion, mobile | not started | Requires selected UI |
| Security verification | Tenant isolation, upload/XSS/CSRF/SSRF/injection/secrets/dependency scans | in progress | Independent gateway/worker/Rust/infra reviews remediated provider-neutral P0/P1 findings; production audit and trackable-file secret scan pass; CodeQL, dependency audit, rejected-name, source, and full-history Gitleaks gates are configured; selected-provider and browser verification remain |
| Frontend deployment | Verified Vercel preview and production against real backend | blocked on decision | Vercel project/domain/access and selected UI required |
| Backend deployment | Isolated pinned Compose deployment, approved HTTPS/WSS domain and smoke tests | blocked on decision | Server audited; isolated Compose, persistent image intent, gateway recovery, telemetry network separation, and static safety tests are ready; dedicated domain, providers, capacity approval, and host-change approval remain |
| Monitoring | Logs, metrics, traces, error reporting, alerts and SLO evidence | in progress | Telemetry foundations in gateway/worker; production targets pending |
| Backups/restore | Supported or stopped atomic backup plus isolated restore drill and documented RPO/RTO | blocked on decision | Guarded cold backup and isolated restore drill use signed environment/image-bound evidence with tamper fixtures; real deployed restore, UID/GID mapping, offsite retention, RPO/RTO, and staging fault injection remain |
| Production handoff | URLs, repo, architecture, tests, limitations, restore, rotation and next steps | not started | Requires all preceding proof |

## Current blocking decisions

1. Product/visual option `1`, `2`, `3`, or a specific combination.
2. Final name candidate to advance to professional clearance.
3. GitHub owner/organization, repository name, and visibility (private is recommended).
4. Public frontend and dedicated backend domains.
5. Authentication, email, object storage, push, telemetry/error, search, and model-provider accounts.
6. Data sensitivity/regulated-data expectations, launch scale, retention, RPO, and RTO.

These decisions block public identity and production exposure, but they do not block safe local implementation and tests.
