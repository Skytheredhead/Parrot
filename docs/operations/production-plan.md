# Production deployment, observability, backup, and restore plan

Date: 2026-07-11

Status: Proposed. This plan authorizes no provider provisioning, public DNS change, server mutation, deployment, or data migration.

## Release gates and required approvals

Production remains blocked until the user approves or supplies:

| Decision | Required approval/evidence |
| --- | --- |
| Product and domains | Final product name; frontend domain; a dedicated API/WSS backend domain. `shhh.skylarenns.com` remains an SSH hostname only. |
| Source/deploy ownership | GitHub owner/repository/visibility and Vercel team/project/domain access. |
| Identity and delivery | OIDC provider, email provider, sender domain, and any push provider. |
| Storage/search | Object provider/account/region/buckets/retention; any external search engine/provider. |
| Operations | Secret manager, telemetry destination, alert recipients, on-call owner, maintenance window, RPO/RTO, backup location/retention. |
| Compatibility | ADR 0001's exact SpacetimeDB 2.6.1 deployment preflight, pinned image digest/toolchain, and a rehearsed module migration/rollback path. |
| Recovery | A successful isolated restore drill using the exact production candidate and object-storage manifest. |

No public release proceeds on assumed provider accounts, DNS ownership, budgets, or data-residency preferences.

## Isolated self-hosted topology

The audited host runs unrelated production services and is disk-constrained. Before mutation, repeat a narrow inventory of ports, proxy/tunnel routes, current SpacetimeDB consumers, sustained CPU/memory/swap, free disk/inodes, backup destinations, and the existing monitoring/log-rotation conventions.

If the user approves this shared host after that review, deploy under a dedicated OS user and an isolated directory/Compose project (for example `/srv/<approved-product>`), with distinct production and staging networks, volumes, secrets, service accounts, ports, and resource limits. Do not reuse or upgrade the current SpacetimeDB service, Docker networks, volumes, proxy configuration, or host ports.

The production project contains pinned-digest SpacetimeDB, gateway, workers, malware scanner, and telemetry collector containers. The verified SpacetimeDB 2.6.1 Linux/amd64 image is `clockworklabs/spacetime:v2.6.1@sha256:53100591a8bfd62c6e088e801b68e96871a8fc6e68eb4fb031bc6ac76f77a72e`; any future platform or version requires a new manifest check and preflight. An external search container is added only after ADR approval. Internal services bind only to the Compose network or loopback. The existing reverse proxy may expose only the approved gateway/API and WSS routes after a reviewed change; SpacetimeDB publish, SQL, delete, logs, and administrative routes stay private. TLS/WSS, exact-origin CORS, body/connection/rate limits, health/readiness checks, restart policy, log rotation, and CPU/memory limits are mandatory.

Staging uses separate volumes, identities, buckets/prefixes, webhook endpoints, and delivery suppression. It cannot read production secrets or send real email/push.

## Vercel frontend delivery

After the Vercel project is approved, use Local, Preview, and Production environments with separate environment variables. Git branches/PRs create Preview deployments; previews point to staging or a deliberately restricted backend, never broad production credentials. The browser receives only public configuration and short-lived user capabilities—no storage, search, worker, OIDC client-secret, or service credentials.

CI pins the Vercel CLI and application lockfile, builds a production artifact once, runs unit/type/lint/security checks, deploys it without assigning production traffic, and runs browser smoke/E2E tests against that artifact. Production promotion assigns the tested artifact; it is not rebuilt with different inputs. Rollback reassigns the frontend domain to the last known-good deployment. Custom Vercel environments and Drains depend on plan/approval and are not assumed.

## Release procedure

1. Confirm approvals, incident owner, maintenance window, capacity headroom, current backup freshness, and tested rollback commands.
2. Build/sign or record immutable image digests and a software bill of materials; run dependency, secret, and container scans.
3. Restore the latest backup into isolated staging and run schema, authorization, realtime, file, search-rebuild, notification-suppression, and health tests.
4. Deploy backend changes compatibility-first: gateway/workers that tolerate both old/new schema, then the rehearsed module change, then consumers. Destructive schema changes require expand/migrate/contract across releases.
5. Verify readiness, WSS reconnect, reducer authorization, outbox leasing, file quarantine, and telemetry before enabling traffic.
6. Deploy the Vercel candidate, run end-to-end tests, then promote the same artifact.
7. Run post-release smoke tests and watch error, latency, queue/search lag, resource, and security dashboards through the agreed observation window.

Rollback the frontend by alias reassignment. Roll back containers by pinned digest only while schema remains backward compatible. If an irreversible module/data change has begun, use the rehearsed forward-repair or restore procedure; never improvise a downgrade against live data. Pause workers before rollback when their payload version is incompatible.

## Health, telemetry, and alerts

Emit structured JSON with timestamp, level, environment, service/version, request/trace ID, workspace/resource opaque IDs, job/run ID, outcome, latency, and stable error code. Redact message/file content, filenames where unnecessary, email addresses, tokens, cookies, authorization headers, invite links, signed URLs, provider payloads, and secrets. Sampling never drops security/audit failures.

Use OpenTelemetry-compatible traces across the Vercel request boundary, gateway, reducer call correlation, worker lease, and provider request. The self-hosted baseline may use an isolated collector plus Prometheus/Grafana and a log backend only after capacity review. A managed telemetry/error provider and Vercel Drains each require user approval, data-residency review, retention/cost limits, and secret redaction. Without Drains, use Vercel's dashboard/runtime logs and documented CLI inspection.

Minimum metrics and alerts:

- API/WSS availability, p50/p95/p99 latency, 4xx/5xx, active connections, reconnect/catch-up lag, reducer denial/error rate;
- worker/outbox oldest age, lease expiry, retry/dead-letter count, provider error/rate-limit rate;
- search indexing/deletion lag, final-authorization rejects, query latency, rebuild age;
- upload/quarantine age, scan failures, orphan/deletion lag, storage growth;
- notification queue age, delivery failures, suppressions, digest lateness;
- host/container CPU, memory/OOM, swap, disk/inodes, certificate expiry, restart count;
- backup age/result, offsite copy age, last successful restore drill, measured RPO/RTO.

Provisional service targets for user approval: 99.9% monthly API/WSS availability; p95 API command acknowledgement under 500 ms excluding external jobs; 99% of ordinary outbox jobs started within 60 seconds; permission/deletion search lag under 60 seconds while live reauthorization remains immediate; backup RPO at most one hour and restore RTO at most four hours. Page on sustained user-impacting SLO burn, queue/security isolation failures, disk/OOM risk, backup failure, or certificate risk—not a single expected retry.

## Backup design

SpacetimeDB active state and object metadata are authoritative. Search is rebuilt, not backed up. Object data is backed up/versioned outside the database failure domain; notification/outbox state is included with the database. Secrets are exported only through the approved encrypted secret-management recovery process and are never bundled beside data under the same credentials.

Current public SpacetimeDB documentation does not establish a supported hot backup/restore workflow, and an upstream request still asks for basic commitlog backup tooling. Therefore:

- do not claim that copying live commit-log/data files is safe;
- pin the exact server version and obtain an upstream-supported method, or stop the isolated instance and snapshot/copy its complete data root atomically;
- validate filesystem/provider snapshots for application consistency rather than assuming crash consistency is sufficient;
- keep encrypted, integrity-checked, offsite copies under credentials separate from the host and production object writer;
- include a versioned manifest of database snapshot, module/image digests, configuration schema, object inventory/checksums, and recovery instructions.

Provisional retention, subject to user/legal approval: hourly for 48 hours, daily for 30 days, weekly for 12 weeks, and monthly for 12 months. Enable object versioning/immutability and lifecycle rules only after the selected provider's delete, legal hold, and cost semantics are reviewed. Alert when the newest verified backup is older than twice its interval.

## Restore drill

Run before launch, after every storage/database upgrade, after material schema changes, and at least monthly thereafter:

1. Create a fresh isolated staging environment with outbound email/push/webhooks disabled.
2. Verify manifest signatures/checksums and restore the complete SpacetimeDB root using the pinned server image/version.
3. Verify module load, row counts and domain invariants, tenant/private-space isolation, authorization epochs, audit continuity, and outbox lease recovery.
4. Restore/reconnect the clean-object manifest and verify existence plus checksum samples across tenants and file types; quarantined content remains inaccessible.
5. Rebuild search from SpacetimeDB and clean extracted text, then prove deletion, permission, DM, snippet, count, and cross-tenant behavior.
6. Run login/session, WSS reconnect, read/write, file download, worker idempotency, and notification-suppression smoke tests.
7. Record actual backup timestamp, data-loss window, restore duration, failures, operator, commands/runbook revision, and follow-up owner; destroy the drill environment securely.

Production readiness requires a demonstrated restore within the approved RPO/RTO. A green backup job without a restore drill is not recovery evidence. Alert when the last successful drill is older than 35 days.

## Current official evidence

Accessed 2026-07-11:

- [SpacetimeDB self-hosting](https://spacetimedb.com/docs/how-to/deploy/self-hosting/)
- [SpacetimeDB backup tooling feature request](https://spacetimedb.com/features/requests/50)
- [Vercel environments and preview behavior](https://vercel.com/docs/deployments/environments)
- [Vercel deployment promotion and rollback behavior](https://vercel.com/docs/deployments/promoting-a-deployment)
- [Vercel Observability](https://vercel.com/docs/observability)
- [Vercel Drains](https://vercel.com/docs/drains)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
