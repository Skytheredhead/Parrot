# Security best-practices review

Date: 2026-07-11

## Executive summary

The provider-neutral backend foundation has no known unresolved P0 or P1 finding after repeated independent review and remediation. The repository is **not approved for production use yet**: it intentionally contains no production provider composition, has not been exposed on a public domain, and has not completed the environment-specific threat model, restore drill, or staging fault-injection program.

This review covers the checked-in Rust authority module, TypeScript gateway, worker runtime, client SDK, deployment configuration, and their tests. It does not assert compliance with a regulatory framework. The review used repository-specific secure-coding inspection, adversarial tests, secret and dependency gates, and independent reviewer passes; the available security guidance did not include a dedicated Fastify or SpacetimeDB checklist.

## Resolved findings

### S-001 — Search ACL revocation could leave stale content searchable (P0)

Resolved. Authoritative search work now carries separate ACL and resource revisions, with ACL-first ordering across live upserts, rebuilds, reconciliation, and stale-write rejection. A newer content revision with an older ACL revision cannot override a revocation.

Evidence:

- `spacetimedb/src/model.rs` defines both authority revisions on search jobs and snapshots.
- `spacetimedb/src/policy.rs` defines the ACL-first ordering key and equality fence.
- `services/worker/src/spacetime-outbox.ts` rejects wire rows whose payload revisions do not match the authoritative row.
- Worker tests cover adversarial stale-content/newer-ACL ordering.

### S-002 — Rust/worker job-envelope drift and missing agent dispatch (P1)

Resolved. The Rust authority and worker decoder share an exact eight-kind protocol, semantic payload validation, and a generated-envelope contract test. Starting an agent run atomically creates its `agent.run` outbox job; revocation and cancellation dead-letter nonterminal work.

Evidence:

- `scripts/job-envelope-contract.ts` links generated bindings to the production decoder.
- `scripts/test-job-envelope-contract.sh` runs the drift test in the repository gate.
- `spacetimedb/src/reducers.rs` validates and emits the canonical envelope.
- `services/worker/src/spacetime-outbox.ts` performs bounded, strict decoding.

### S-003 — Worker lease timeout and restart races could duplicate or strand work (P1)

Resolved. A timed-out in-process claim retains one stable promise instead of opening overlapping claims. Restart recovery is bound to authenticated worker identity and an explicit worker slot, and atomically advances the lease generation. Tokens from the old process cannot heartbeat, complete, or write effects after recovery.

Evidence:

- `spacetimedb/src/reducers.rs` binds recover, heartbeat, and completion to sender, slot, generation, and expiry.
- `services/worker/src/outbox.ts` retains and recovers the owned claim before acquiring new work.
- Worker and Rust policy tests cover late claim and restart-generation fencing.

### S-004 — Invitation and session-administration trust boundaries (P1)

Resolved. Invitations use 256-bit random bearer tokens, hash-only durable storage with key rotation, atomic redemption, verified-email binding, expiry/revocation/use limits, generic unavailable errors, and route-specific rate limits. Session administration uses an authoritative human principal, owner-only atomic adapters, generic unavailable errors, CSRF protection for cookie mutations, and `auth_time` rather than token issue time for fresh-auth revocation.

Evidence:

- `services/gateway/src/invitations/` contains token and atomic authority contracts.
- `services/gateway/src/sessions/` contains owner-scoped list and revocation services.
- `services/gateway/src/auth/request-auth.ts` derives security-sensitive session facts from verified identity rather than resolver output.
- `services/gateway/src/security/browser-boundary.ts` rejects mixed credentials and enforces exact-origin, session-bound CSRF checks.
- `services/gateway/src/app.ts` rejects incomplete or non-durable production composition.

### S-005 — Direct-message authorization and idempotency oracles (P1)

Resolved. Direct conversations are human-only and immutable in membership; leaving is irreversible, and neither owner, admin, nor service roles bypass participation. Private idempotency lookup is keyed by actor, operation, and request before target lookup, exact replay succeeds after access loss, conflicts converge with unavailable targets, and receipt views still filter by current workspace and resource visibility. Promotion to a public discussion requires unanimous immutable consent over unchanged source revisions and current participants and copies only approved title/body.

Evidence:

- `spacetimedb/src/reducers.rs` implements constant-time private receipt lookup and the DM/promotion reducers.
- `spacetimedb/src/views.rs` applies caller-aware DM, promotion, audit, and receipt filtering.
- Rust policy tests cover replay, access loss, unauthorized targets, and denial convergence.

### S-006 — Notification revocation, coalescing, presence bounds, and migration safety (P1)

Resolved in the provider-neutral authority contract. The legacy notification table remains unchanged
and the new controls are additive. Presence is capped per identity/workspace, scheduled for expiry,
and exposed through one aggregate authority row rather than raw or stale session scans. Notification
delivery uses bounded revisioned groups; each leased job is resolved through a service-only view and
must obtain a short job/owner/slot/generation-bound permit that rechecks current membership,
preference, resource revision, deletion, and private-space visibility immediately before provider
I/O. Legacy unversioned delivery work is suppressed during module update.

Evidence:

- `spacetimedb/src/model.rs` keeps `Notification` migration-compatible and adds private companion
  authority tables.
- `spacetimedb/src/reducers.rs` caps and schedules presence, creates bounded delivery groups, and
  issues exact short-lived delivery permits.
- `spacetimedb/src/views.rs` exposes aggregate presence and service-only delivery plans.
- `services/worker/src/spacetime-outbox.ts` binds the authoritative delivery revision into the
  decoded job, while `services/worker/src/adapters.ts` requires current-plan dispatch fencing.
- A real SpacetimeDB 2.6.1 automatic publish from the previous committed schema to the new schema
  completed successfully.

### S-007 — Workspace deletion authority and stale-runtime access (P1)

Resolved for authoritative access fencing, not physical erasure. Every workspace has an additive,
fail-closed lifecycle row. Only the active owner with an active owner membership can configure
bounded retention/grace inputs or transition the lifecycle. A deletion request immediately removes
human and service visibility and increments the lifecycle epoch in a bounded transaction. During the
reversible grace window, generation-bound scheduler batches clear notification permits and both raw
and aggregate presence while durable jobs/agent state remain paused for safe cancellation and effect
reconciliation. Post-grace finalization is irreversible and then drains durable work, normalizing
open approval/tool/effect state before terminal run revocation.

Evidence:

- `spacetimedb/src/authz.rs` requires an active lifecycle for membership and service authority.
- `spacetimedb/src/views.rs` filters every human/service content surface while retaining a
  content-free lifecycle status view for current members.
- `spacetimedb/src/reducers.rs` backfills lifecycle rows, validates transition invariants, commits
  access fencing before size-bounded epoch-checked runtime drains.
- Rust policy tests cover bounded configuration, grace enforcement, cancellation, and irreversible
  final fencing; exact 2.6.1 fresh publish and automatic committed-schema migration pass.

## Open release blockers

### B-001 — Production provider composition and conformance (High)

The repository deliberately contains interfaces, in-memory test adapters, and fail-closed composition checks—not real identity, object-storage, search, email, model, telemetry, or durable worker/gateway adapter modules. Production startup rejects missing or non-durable adapters, but each selected provider still needs a reviewed implementation and conformance tests.

Required before release:

1. Select providers and document their data flows, regions, retention, credentials, quotas, and failure modes.
2. Implement production gateway and worker composition modules outside the public/test adapter path.
3. Run the full conformance, integration, failure-injection, and revocation suites against those exact providers.
4. Keep all provider credentials in the deployment secret manager; never add them to repository files or images.

### B-002 — Agent tool network and secret-broker boundary (High)

The worker constrains tool registration, budgets, authorization epochs, approvals, leases, and effect idempotency, but actual network I/O belongs to the future provider adapters. A malicious URL, redirect, DNS rebinding, private-address target, oversized response, or over-broad secret grant must be rejected by that adapter boundary.

Required before enabling external tools:

1. Default-deny tool egress by scheme, hostname, resolved address, and port.
2. Re-resolve and revalidate every redirect; block loopback, link-local, private, metadata, multicast, and unsupported address classes for both IPv4 and IPv6.
3. Pin request, redirect, response-byte, decompression, concurrency, and total-run budgets.
4. Use installation-scoped, short-lived credentials; expose secrets only to the selected tool adapter and never to model context, logs, checkpoints, or client responses.
5. Add DNS-rebinding, redirect, credential-leak, and oversized-response tests to the production adapter conformance suite.

### B-003 — Environment-specific threat model and data classification (High)

The final repository threat model remains intentionally pending because launch scale, signup posture, and data sensitivity have not been confirmed. Those answers affect abuse controls, audit retention, encryption/key-management expectations, and operational staffing.

Required before release: record the confirmed assumptions, complete the repository-grounded threat model, assign each mitigation, and block launch on unresolved high-risk abuse paths.

### B-004 — Deployment, monitoring, and recovery evidence (High)

No public domain, TLS deployment, selected production host, or production-capacity approval exists.
Static container and configuration checks pass, but the local environment did not provide a Docker
daemon for an actual image build. Backup documentation and a bounded restored-state verifier exist,
but a real deployed backup/restore drill and measured RPO/RTO have not been completed. The bounded
verifier intentionally remains ineligible for traffic or live upgrades until current module code
can be independently bound, outbox lease recovery can be verified without a public global scan, and
downstream deletion propagation, object, search, provider, and authorization-behavior checks exist.

Required before release:

1. Build and scan the exact images in CI, pin them by digest, and verify provenance.
2. Deploy to an isolated staging environment with production-equivalent policy and no production data.
3. Exercise readiness, graceful drain, retry, provider outage, lease recovery, revocation, and rollback paths.
4. Complete and timestamp a restore drill; record measured RPO/RTO.
5. Configure redacted logs, metrics, traces, alert ownership, escalation, and SLOs before public traffic.

### B-005 — Direct-message attachments (Medium)

DM attachment references are deferred. The current file authority is space-scoped and cannot guarantee that every DM participant retains access after later space ACL changes. Do not expose attachments in DMs until a participant-bound immutable authorization model and deletion/retention behavior are designed and tested.

## Verification performed

The repository gate covers format, lint, TypeScript, SDK/gateway/worker tests, Rust policy tests, exact job-envelope drift tests, builds, configuration checks, and gateway package verification. Additional completed checks include a production dependency audit, full-history secret scanning, release WASM compilation, fresh SpacetimeDB publish, anonymous denial, signed OIDC reducer/SQL/WebSocket integration, and regenerated binding typecheck.

Current passing test counts at this review checkpoint are:

- Client SDK: 11/11
- Gateway: 62/62
- Worker: 90/90
- Rust policy and reducer-contract tests: 49/49
- Job-envelope contract: 2/2

The counts are evidence for the checked-in provider-neutral implementation only; they are not substitutes for the open environment-specific release gates above.
