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
graph. Concrete provider choices remain intentionally disabled until identity, object storage,
email/push, search, model, telemetry, and secret-management providers are approved. The process host
itself is implemented: it requires an absolute `WORKER_ADAPTER_MODULE` exporting
`createWorkerPorts(config)`, validates and freezes the full production graph before polling, and
refuses test-only adapters, unreviewed handlers, mutable tools, missing conformance checks, or
missing live readiness checks.

## Guarantees

- Outbox, AgentRun, and external-effect leases heartbeat while work is active. Every renewal is
  generation-fenced, and ownership loss aborts provider/tool work before a stale outcome write.
- Heartbeat, shutdown, provider cancellation, handler execution, and reconciliation waits are
  bounded. Effect renewal precedes matching outbox renewal so partial renewal can only delay work,
  never create concurrent effect ownership.
- Every state write is owner/generation-bound; stale workers cannot acknowledge reclaimed jobs.
- Claim deadlines do not start overlapping store claims. A timed-out claim remains in flight and is
  re-awaited on the next poll. Before issuing a new claim, startup/replacement recovery atomically
  advances the generation and extends any still-valid lease owned by this worker identity. That
  invalidates every token held by the prior process while covering a committed claim whose response
  was lost or a process restart between claim and processing.
- Effect acquisition is atomic and bound to workspace, kind, semantic resource, and payload.
  Ambiguous non-idempotent effects reconcile and are never replayed blindly.
- Notification delivery requires a live authoritative preference/suppression plan exactly bound to
  workspace, intent, recipient, requested channel, resource, authorization epoch, and deterministic
  delivery key. Rendering is normalized plain text with independent character, byte, and control
  bounds. The provider call begins inside nested final authorization and exact current preference
  revision fences, so revocation after planning prevents dispatch. Transient, permanent, and
  ambiguous outcomes use a closed provider-neutral classification, with ambiguous sends reconciled
  by the same stable key before replay. Suppression is a durable successful no-op, while invalid
  plans, invalid rendering, revocation, and permanent provider failures dead-letter through the
  existing effect/outbox fences.
- File keys, cleanup prefixes, and versions come from authoritative plans. Cleanup uses durable
  deletion claims, claim generations, object-version preconditions, and explicit finalization.
- Search rebuilds use monotonic generations, capture concurrent deltas, and swap atomically. Every
  document carries an ACL revision and a resource revision; ordering is ACL-first, so content from an
  older authorization generation can never override a newer restriction even when its content
  revision is higher. Tombstone dominance resolves ties at the exact composite version.
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
- The process polls one claimed job at a time and exposes only minimal `/health/live` and
  `/health/ready` responses on its internal health listener. `SIGINT`/`SIGTERM` stops new claims,
  drains the active lease within the configured deadline, then aborts non-cooperative work so the
  lease can be safely reclaimed. Optional adapter cleanup is also bounded.

## Verify

```bash
pnpm --filter @project-conversation/worker typecheck
pnpm --filter @project-conversation/worker test
pnpm --filter @project-conversation/worker build
pnpm --filter @project-conversation/worker start
```

The supported and CI-verified runtime is Node 24.18.0.

`WORKER_ID` is the worker-slot component of the durable recovery protocol. Every authority lease is
fenced by both the adapter's authenticated service identity and this explicit slot ID. Assign one
stable ID to each logical worker slot, preserve it across restarts, and never run two processes
concurrently with the same ID under the same service identity. If an old process might still be
alive, fence or stop it before starting its replacement. A new random ID cannot recover a
response-lost lease and must wait for expiry; a duplicate live ID can make both processes believe
they own the same generation.

Store cancellation is advisory once a remote atomic claim has been dispatched. The consumer retains
that single in-flight operation across ordinary claim deadlines, while shutdown remains bounded even
if the store call does not cooperate. If the process exits after the claim commits, the same stable
`WORKER_ID` recovers a still-valid lease on restart by advancing its generation; it never shares the
prior process's generation. The matching external-effect fence advances with the recovered outbox
generation, so old effect heartbeats and outcome writes are rejected while the replacement
reconciles ambiguous work. Once a lease expires, any worker may reclaim it with a higher generation.
Consequently the outbox provides generation-fenced, at-least-once
orchestration—not exactly-once external effects; ambiguous provider outcomes still require the
handler's durable reconciliation protocol before any replay.

The canonical notification envelope now binds a stable authority-created intent/group and its
delivery revision. The Rust authority uses a bounded five-minute group window; revisions within the
same group share the provider key, while a later window receives a new intent and key. The delivery
authority must obtain the exact lease/slot/generation-bound permit immediately before provider
dispatch. Because reducers cannot perform external I/O, the real adapter must keep that final gap
bounded, honor the permit expiry, and re-run resolution after any stale-plan result; it must never
invent a group, revision, or permit locally.

In-memory adapters are for tests and local simulation only. They are not a persistence substitute
and must never be selected in a production environment.

The checked-in worker Dockerfile is a base candidate, not a runnable release image: it intentionally
contains no production adapter module or provider credentials. Build a derived image containing the
reviewed module, verify every adapter's readiness/conformance tests, then record the output image by
immutable registry digest. The Compose `worker` profile is opt-in, unexposed on the host, and is not
activated by the guarded deployment script.
