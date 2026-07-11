# Background worker foundation

This package implements the crash-safe orchestration boundary for nondeterministic external work.
SpacetimeDB remains authoritative; adapters perform model calls, notifications, file processing,
search indexing, and provider reconciliation from durable outbox jobs.

The package provides tested durable-adapter contracts and explicitly test-only in-memory adapters.
Staging and production composition fails closed unless the complete executable graph uses durable
adapters, exposes every required runtime method, registers every job handler, enforces the exact
per-job-kind dependency contract (including all registered tools for `agent.run`), and contains only
policy-valid durable tools. Handler registration also requires module-private provenance issued only
by the reviewed notification, search, file, and AgentRun handler factories; a generic handler
cannot opt itself into production by declaring the expected dependencies. Tool registrations are
immutable snapshots, and a validated staging/production registry is permanently sealed before the
runtime is returned, so late registration or descriptor/method mutation cannot change the executing
graph. Concrete provider choices
and a process entrypoint remain intentionally disabled until identity, object storage, email/push,
search, model, telemetry, and secret-management providers are approved.

## Guarantees

- Outbox, AgentRun, and external-effect leases heartbeat while work is active. Every renewal is
  generation-fenced, and ownership loss aborts provider/tool work before a stale outcome write.
- Heartbeat, shutdown, provider cancellation, handler execution, and reconciliation waits are
  bounded. Effect renewal precedes matching outbox renewal so partial renewal can only delay work,
  never create concurrent effect ownership.
- Every state write is owner/generation-bound; stale workers cannot acknowledge reclaimed jobs.
- Effect acquisition is atomic and bound to workspace, kind, semantic resource, and payload.
  Ambiguous non-idempotent effects reconcile and are never replayed blindly.
- File keys, cleanup prefixes, and versions come from authoritative plans. Cleanup uses durable
  deletion claims, claim generations, object-version preconditions, and explicit finalization.
- Search rebuilds use monotonic generations, capture concurrent deltas, and swap atomically; strict
  versions and tombstone dominance prevent resurrection.
- Agent context is authorized before and after body fetch and again before provider use. Context,
  provider input, tool results, output, cost, call counts, JSON depth, and cumulative JSON nodes are
  independently bounded before serialization or canonical hashing. Provider limits charge the exact
  canonical UTF-8 wire payload, including framing, escaping, run identity, and remaining budgets.
  `AgentProvider.next` receives that canonical JSON string, rather than a mutable object, so adapters
  can transmit the same measured and fingerprinted bytes without reserialization drift.
- The reviewed `agent.run` outbox handler atomically claims or reclaims the separate durable AgentRun
  lease for the exact workspace/request before delegating to `AgentRunLoop`; active and terminal runs
  reconcile without starting a second model execution.
- Provider requests have deterministic durable identities and reconcile completed responses after a
  response/save crash. Recovery loads the stable run/turn dispatch before recollecting context and
  reuses its exact canonical input bytes, request identity, and context snapshot; changed or reordered
  source context therefore cannot generate a second request. An unreconciled existing request becomes
  outcome-unknown and is never regenerated. Before context delivery, the repository atomically checks
  the current lease, epoch, and cancellation state and persists an immutable dispatch fence containing
  the deterministic request ID, input fingerprint, canonical input, and exact context revision/hash set.
- Tool effect class and schema come from a trusted registry; exact approvals are bound to normalized
  arguments and replay state.
- Final agent content and success state commit atomically.
- Logs and telemetry accept only allowlisted, sanitized fields and redact credentials, URLs, and
  personal data before export.
- Synchronous, asynchronously rejected, and hung logging/span exporters are detached and isolated
  from durable business outcomes without producing unhandled promise rejections.

## Verify

```bash
pnpm --filter @project-conversation/worker typecheck
pnpm --filter @project-conversation/worker test
pnpm --filter @project-conversation/worker build
```

The supported and CI-verified runtime is Node 24.18.0.

In-memory adapters are for tests and local simulation only. They are not a persistence substitute
and must never be selected in a production environment.
