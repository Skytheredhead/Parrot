import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeClock,
  EffectIdentityConflictError,
  EffectOwnershipError,
  HandlerRegistry,
  InMemoryAuthorizationGate,
  InMemoryEffectLedger,
  InMemoryNotificationDeliveryAuthority,
  InMemoryNotificationProvider,
  InMemorySpanExporter,
  InMemoryTransactionalOutbox,
  OpenTelemetry,
  OutboxConsumer,
  RetryPolicy,
  StaleLeaseError,
  StructuredLogger,
  createNotificationDeliveryHandler,
  newJob,
  type JobHandler,
  type JsonValue,
  type LogRecord,
  type LogSink,
} from "../src/index.js";

class MemoryLogSink implements LogSink {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "memory-test-log-sink";
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

const setup = (workerId = "worker-a") => {
  const clock = new FakeClock(1_000);
  const store = new InMemoryTransactionalOutbox(clock);
  const ledger = new InMemoryEffectLedger(clock);
  const authorization = new InMemoryAuthorizationGate();
  const notificationAuthority = new InMemoryNotificationDeliveryAuthority();
  const provider = new InMemoryNotificationProvider();
  const registry = new HandlerRegistry().register(
    "notification.deliver",
    createNotificationDeliveryHandler(authorization, notificationAuthority, provider),
  );
  const retry = new RetryPolicy(
    { baseMs: 100, capMs: 10_000, jitterRatio: 0, maxAttempts: 4, maxAgeMs: 60_000 },
    () => 0.5,
  );
  const logSink = new MemoryLogSink();
  const consumer = new OutboxConsumer(
    { workerId, leaseMs: 1_000 },
    clock,
    store,
    ledger,
    registry,
    retry,
    new StructuredLogger("test-worker", "debug", logSink),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  return {
    clock,
    store,
    ledger,
    authorization,
    notificationAuthority,
    provider,
    registry,
    retry,
    consumer,
    logSink,
  };
};

const notificationJob = (id: string, intentId = `intent-${id}`) =>
  newJob(
    {
      id,
      workspaceId: "workspace-1",
      kind: "notification.deliver",
      payload: {
        intentId,
        recipientId: "person-1",
        channel: "email",
        resourceId: "post-1",
        authorizationEpoch: 2,
        deliveryRevision: 1,
        minimalMessage: "Activity needs your attention",
      },
    },
    1_000,
  );

const consumerForStore = (
  clock: FakeClock,
  store: InMemoryTransactionalOutbox,
  workerId: string,
  options: {
    readonly leaseMs?: number;
    readonly heartbeatMs?: number;
    readonly heartbeatTimeoutMs?: number;
    readonly claimTimeoutMs?: number;
    readonly shutdownTimeoutMs?: number;
  } = {},
) => {
  const ledger = new InMemoryEffectLedger(clock);
  const authorization = new InMemoryAuthorizationGate();
  const notificationAuthority = new InMemoryNotificationDeliveryAuthority();
  const provider = new InMemoryNotificationProvider();
  const registry = new HandlerRegistry().register(
    "notification.deliver",
    createNotificationDeliveryHandler(authorization, notificationAuthority, provider),
  );
  const retry = new RetryPolicy(
    { baseMs: 10, capMs: 100, jitterRatio: 0, maxAttempts: 4, maxAgeMs: 60_000 },
    () => 0.5,
  );
  const sink = new MemoryLogSink();
  const consumer = new OutboxConsumer(
    { workerId, leaseMs: 1_000, ...options },
    clock,
    store,
    ledger,
    registry,
    retry,
    new StructuredLogger("test-worker", "debug", sink),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  return { consumer, provider };
};

test("a late claim is retained, re-awaited, and never duplicated", async () => {
  const clock = new FakeClock(1_000);
  let releaseClaim: (() => void) | undefined;
  const claimGate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  class DelayedClaimStore extends InMemoryTransactionalOutbox {
    claims = 0;
    recoveries = 0;

    override async recoverOwned(...args: Parameters<InMemoryTransactionalOutbox["recoverOwned"]>) {
      this.recoveries += 1;
      return super.recoverOwned(...args);
    }

    override async claim(...args: Parameters<InMemoryTransactionalOutbox["claim"]>) {
      this.claims += 1;
      await claimGate;
      // Deliberately ignore the now-aborted signal: a remote atomic claim can already be committed.
      return super.claim(args[0], args[1]);
    }
  }
  const store = new DelayedClaimStore(clock);
  const { consumer, provider } = consumerForStore(clock, store, "worker-stable", {
    claimTimeoutMs: 5,
  });
  await store.enqueue(notificationJob("job-late-claim"));

  await assert.rejects(consumer.tick(), (error: Error) => error.name === "outbox_claim_timeout");
  await assert.rejects(consumer.tick(), (error: Error) => error.name === "outbox_claim_timeout");
  assert.equal(store.claims, 1);
  assert.equal(store.recoveries, 1);

  releaseClaim?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await consumer.tick(), true);
  assert.equal(store.claims, 1);
  assert.equal(store.recoveries, 1);
  assert.equal(provider.calls.length, 1);
  assert.equal((await store.get("job-late-claim"))?.state, "succeeded");
});

test("the stable worker id recovers and extends a response-lost lease before processing", async () => {
  const clock = new FakeClock(1_000);
  class TrackingStore extends InMemoryTransactionalOutbox {
    claims = 0;
    recoveries = 0;

    override async recoverOwned(...args: Parameters<InMemoryTransactionalOutbox["recoverOwned"]>) {
      this.recoveries += 1;
      return super.recoverOwned(...args);
    }

    override async claim(...args: Parameters<InMemoryTransactionalOutbox["claim"]>) {
      this.claims += 1;
      return super.claim(...args);
    }
  }
  const store = new TrackingStore(clock);
  await store.enqueue(notificationJob("job-response-lost"));
  const abandoned = await store.claim("worker-stable", 100);
  assert.ok(abandoned);
  clock.advance(80);
  const { consumer, provider } = consumerForStore(clock, store, "worker-stable", {
    leaseMs: 1_000,
  });

  assert.equal(await consumer.tick(), true);
  assert.equal(store.recoveries, 1);
  assert.equal(store.claims, 1);
  assert.equal(provider.calls.length, 1);
  assert.equal((await store.get("job-response-lost"))?.state, "succeeded");
  assert.equal((await store.get("job-response-lost"))?.leaseGeneration, 2);
});

test("restart recovery advances generation and invalidates every prior outbox mutation", async () => {
  const clock = new FakeClock(1_000);
  const store = new InMemoryTransactionalOutbox(clock);
  await store.enqueue(notificationJob("job-recovery-generation"));
  const prior = await store.claim("worker-stable", 1_000);
  assert.ok(prior);
  const recovered = await store.recoverOwned("worker-stable", 1_000);
  assert.ok(recovered);
  assert.equal(recovered.lease.generation, prior.lease.generation + 1);
  assert.equal(recovered.job.leaseGeneration, recovered.lease.generation);

  const staleMutations: readonly (() => Promise<unknown>)[] = [
    () => store.heartbeat(prior.lease, clock.now() + 1_000),
    () => store.complete(prior.lease),
    () => store.retry(prior.lease, clock.now() + 10, "stale_retry"),
    () => store.outcomeUnknown(prior.lease, clock.now() + 10, "stale_unknown"),
    () => store.deadLetter(prior.lease, "stale_dead_letter"),
  ];
  for (const mutate of staleMutations) await assert.rejects(mutate(), StaleLeaseError);

  await store.complete(recovered.lease);
  assert.equal((await store.get("job-recovery-generation"))?.state, "succeeded");
});

test("owned-lease recovery excludes expired and foreign leases", async () => {
  const clock = new FakeClock(1_000);
  const store = new InMemoryTransactionalOutbox(clock);
  await store.enqueue(notificationJob("job-expired-owned"));
  await store.enqueue(notificationJob("job-foreign-owned"));
  assert.ok(await store.claim("worker-stable", 10));
  assert.ok(await store.claim("worker-foreign", 1_000));

  clock.advance(11);
  assert.equal(await store.recoverOwned("worker-stable", 1_000), undefined);
  assert.equal(await store.recoverOwned("worker-other", 1_000), undefined);
  const foreign = await store.get("job-foreign-owned");
  assert.equal(foreign?.leaseWorkerSlotId, "worker-foreign");
  assert.equal(foreign?.state, "leased");
});

test("lease acknowledgements and recovery are fenced to the exact worker slot", async () => {
  const clock = new FakeClock(1_000);
  const store = new InMemoryTransactionalOutbox(clock);
  await store.enqueue(notificationJob("job-worker-slot-fence"));
  const claimed = await store.claim("worker-slot-a", 1_000);
  assert.ok(claimed);

  assert.equal(await store.recoverOwned("worker-slot-b", 1_000), undefined);
  await assert.rejects(
    store.complete({ ...claimed.lease, workerSlotId: "worker-slot-b" }),
    StaleLeaseError,
  );
  await store.complete(claimed.lease);
  assert.equal((await store.get("job-worker-slot-fence"))?.state, "succeeded");
});

test("consumer rejects an adapter result leased to a different worker slot", async () => {
  const clock = new FakeClock(1_000);
  class WrongSlotStore extends InMemoryTransactionalOutbox {
    override recoverOwned(
      _workerSlotId: string,
      leaseMs: number,
      signal?: AbortSignal,
    ): ReturnType<InMemoryTransactionalOutbox["recoverOwned"]> {
      return super.recoverOwned("worker-slot-a", leaseMs, signal);
    }
  }
  const store = new WrongSlotStore(clock);
  await store.enqueue(notificationJob("job-wrong-slot-result"));
  assert.ok(await store.claim("worker-slot-a", 1_000));
  const { consumer, provider } = consumerForStore(clock, store, "worker-slot-b");

  await assert.rejects(consumer.tick(), StaleLeaseError);
  assert.equal(provider.calls.length, 0);
  assert.equal((await store.get("job-wrong-slot-result"))?.leaseWorkerSlotId, "worker-slot-a");
});

test("shutdown aborts a retained claim wait without starting another claim", async () => {
  const clock = new FakeClock(1_000);
  let claimStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    claimStarted = resolve;
  });
  class HangingClaimStore extends InMemoryTransactionalOutbox {
    claims = 0;
    observedAbort = false;

    override async claim(_owner: string, _leaseMs: number, signal?: AbortSignal): Promise<never> {
      this.claims += 1;
      claimStarted?.();
      return new Promise<never>(() => {
        signal?.addEventListener(
          "abort",
          () => {
            this.observedAbort = true;
          },
          { once: true },
        );
      });
    }
  }
  const store = new HangingClaimStore(clock);
  const { consumer } = consumerForStore(clock, store, "worker-shutdown", {
    claimTimeoutMs: 1_000,
  });
  const controller = new AbortController();
  const running = consumer.tick(controller.signal);
  await started;

  const before = Date.now();
  controller.abort(new Error("worker_shutdown_timeout"));
  await assert.rejects(running, /worker_shutdown_timeout/);
  assert.equal(Date.now() - before < 100, true);
  assert.equal(store.claims, 1);
  assert.equal(store.observedAbort, true);
});

test("a crashed worker lease is reclaimed and completed by another worker", async () => {
  const setupA = setup("worker-a");
  await setupA.store.enqueue(notificationJob("job-crash"));
  const abandoned = await setupA.store.claim("worker-a", 1_000);
  assert.ok(abandoned);

  setupA.clock.advance(1_001);
  const consumerB = new OutboxConsumer(
    { workerId: "worker-b", leaseMs: 1_000 },
    setupA.clock,
    setupA.store,
    setupA.ledger,
    setupA.registry,
    setupA.retry,
    new StructuredLogger("test-worker", "debug", setupA.logSink),
    new OpenTelemetry(setupA.clock, new InMemorySpanExporter()),
  );
  assert.equal(await consumerB.tick(), true);
  assert.equal((await setupA.store.get("job-crash"))?.state, "succeeded");
  assert.equal(setupA.provider.calls.length, 1);
});

test("stale lease generations cannot acknowledge a reclaimed job", async () => {
  const { clock, store } = setup();
  await store.enqueue(notificationJob("job-stale"));
  const first = await store.claim("worker-a", 100);
  assert.ok(first);
  clock.advance(1_001);
  const second = await store.claim("worker-b", 100);
  assert.ok(second);
  await assert.rejects(store.complete(first.lease), StaleLeaseError);
  await store.complete(second.lease);
  assert.equal((await store.get("job-stale"))?.state, "succeeded");
});

test("duplicate logical deliveries converge on one provider effect", async () => {
  const { store, consumer, provider } = setup();
  await store.enqueue(notificationJob("job-one", "intent-stable"));
  await store.enqueue(notificationJob("job-two", "intent-stable"));
  assert.equal(await consumer.tick(), true);
  assert.equal(await consumer.tick(), true);
  assert.equal(provider.calls.length, 1);
  assert.equal((await store.get("job-one"))?.state, "succeeded");
  assert.equal((await store.get("job-two"))?.state, "succeeded");
});

test("same semantic effect with changed payload fails closed as a conflict", async () => {
  const { store, consumer, provider } = setup();
  const first = notificationJob("job-conflict-a", "shared-intent");
  const second = newJob(
    {
      id: "job-conflict-b",
      workspaceId: "workspace-1",
      kind: "notification.deliver",
      payload: {
        intentId: "shared-intent",
        recipientId: "different-person",
        channel: "email",
        resourceId: "post-1",
        authorizationEpoch: 2,
        deliveryRevision: 1,
        minimalMessage: "Activity needs your attention",
      },
    },
    1_000,
  );
  assert.equal(first.effectKey, second.effectKey);
  await store.enqueue(first);
  await store.enqueue(second);
  await consumer.tick();
  await consumer.tick();
  assert.equal(provider.calls.length, 1);
  assert.equal((await store.get("job-conflict-b"))?.deadLetterReason, "effect_identity_conflict");
});

test("non-idempotent ambiguous effects reconcile and never repeat blindly", async () => {
  const { clock, store, ledger, retry, logSink } = setup();
  let executions = 0;
  let reconciliations = 0;
  const handler: JobHandler = {
    retryWhenReconciledNotFound: false,
    async execute() {
      executions += 1;
      return { type: "outcome_unknown", code: "connection_lost_after_send" };
    },
    async reconcile() {
      reconciliations += 1;
      return { type: "not_found" };
    },
  };
  const registry = new HandlerRegistry().registerTestOnly("notification.deliver", handler);
  const consumer = new OutboxConsumer(
    { workerId: "worker-a", leaseMs: 1_000 },
    clock,
    store,
    ledger,
    registry,
    retry,
    new StructuredLogger("test-worker", "debug", logSink),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  await store.enqueue(notificationJob("job-ambiguous"));
  await consumer.tick();
  assert.equal((await store.get("job-ambiguous"))?.state, "outcome_unknown");
  clock.advance(1_001);
  await consumer.tick();
  assert.equal(executions, 1);
  assert.equal(reconciliations, 1);
  assert.equal((await store.get("job-ambiguous"))?.state, "outcome_unknown");
});

test("authorization revocation suppresses queued notification delivery", async () => {
  const { store, consumer, authorization, provider } = setup();
  authorization.setAllowed(false);
  await store.enqueue(notificationJob("job-revoked"));
  await consumer.tick();
  assert.equal(provider.calls.length, 0);
  assert.equal((await store.get("job-revoked"))?.state, "dead_letter");
});

test("notification bodies are bounded before provider delivery", async () => {
  const { store, consumer, provider } = setup();
  const oversized = newJob(
    {
      id: "job-oversized",
      workspaceId: "workspace-1",
      kind: "notification.deliver",
      payload: {
        intentId: "oversized-intent",
        recipientId: "person-1",
        channel: "email",
        resourceId: "post-1",
        authorizationEpoch: 2,
        deliveryRevision: 1,
        minimalMessage: "x".repeat(1_001),
      },
    },
    1_000,
  );
  await store.enqueue(oversized);
  await consumer.tick();
  assert.equal(provider.calls.length, 0);
  assert.equal(
    (await store.get("job-oversized"))?.deadLetterReason,
    "notification_message_invalid",
  );
});

test("heartbeats keep a long-running effect exclusively leased", async () => {
  const { clock, store, ledger, retry, logSink } = setup();
  let releaseEffect: (() => void) | undefined;
  let effectStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    effectStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseEffect = resolve;
  });
  let executions = 0;
  const registry = new HandlerRegistry().registerTestOnly("notification.deliver", {
    retryWhenReconciledNotFound: true,
    async execute(_job, _key, signal) {
      executions += 1;
      effectStarted?.();
      await release;
      assert.equal(signal.aborted, false);
      return { type: "succeeded" };
    },
    async reconcile() {
      return { type: "not_found" };
    },
  });
  const consumer = new OutboxConsumer(
    { workerId: "worker-a", leaseMs: 60, heartbeatMs: 5 },
    clock,
    store,
    ledger,
    registry,
    retry,
    new StructuredLogger("test-worker", "debug", logSink),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  await store.enqueue(notificationJob("job-heartbeat"));
  const running = consumer.tick();
  await started;
  clock.advance(50);
  await new Promise((resolve) => setTimeout(resolve, 12));
  clock.advance(20);
  assert.equal(await store.claim("worker-b", 60), undefined);
  releaseEffect?.();
  await running;
  assert.equal(executions, 1);
  assert.equal((await store.get("job-heartbeat"))?.state, "succeeded");
});

test("heartbeat loss aborts the handler and suppresses stale ledger and outbox writes", async () => {
  const clock = new FakeClock(1_000);
  class FailingHeartbeatStore extends InMemoryTransactionalOutbox {
    override async heartbeat(): Promise<never> {
      throw new StaleLeaseError("job-heartbeat-loss");
    }
  }
  const store = new FailingHeartbeatStore(clock);
  class TrackingEffectLedger extends InMemoryEffectLedger {
    heartbeats = 0;

    override async heartbeat(
      ...input: Parameters<InMemoryEffectLedger["heartbeat"]>
    ): Promise<void> {
      this.heartbeats += 1;
      await super.heartbeat(...input);
    }
  }
  const ledger = new TrackingEffectLedger(clock);
  let observedAbort = false;
  const registry = new HandlerRegistry().registerTestOnly("notification.deliver", {
    retryWhenReconciledNotFound: true,
    async execute(_job, _key, signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true },
        );
      });
      return { type: "succeeded" };
    },
    async reconcile() {
      return { type: "not_found" };
    },
  });
  const consumer = new OutboxConsumer(
    { workerId: "worker-a", leaseMs: 60, heartbeatMs: 5 },
    clock,
    store,
    ledger,
    registry,
    new RetryPolicy(
      { baseMs: 10, capMs: 100, jitterRatio: 0, maxAttempts: 3, maxAgeMs: 1_000 },
      () => 0.5,
    ),
    new StructuredLogger("test", "debug", {
      adapterKind: "test-only",
      adapterName: "null-test-log-sink",
      write() {},
    }),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  await store.enqueue(notificationJob("job-heartbeat-loss"));
  await consumer.tick();
  assert.equal(observedAbort, true);
  assert.equal(ledger.heartbeats >= 1, true);
  assert.equal((await store.get("job-heartbeat-loss"))?.state, "leased");
  assert.equal(
    (await ledger.get(notificationJob("job-heartbeat-loss").effectKey))?.state,
    "started",
  );
});

test("a non-cooperative heartbeat and shutdown are bounded", async () => {
  const clock = new FakeClock(1_000);
  class HangingHeartbeatStore extends InMemoryTransactionalOutbox {
    override async heartbeat(): Promise<never> {
      return new Promise<never>(() => undefined);
    }
  }
  const store = new HangingHeartbeatStore(clock);
  const ledger = new InMemoryEffectLedger(clock);
  let observedAbort = false;
  const registry = new HandlerRegistry().registerTestOnly("notification.deliver", {
    retryWhenReconciledNotFound: false,
    async execute(_job, _key, signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true },
        );
      });
      return { type: "succeeded" };
    },
    async reconcile() {
      return { type: "unknown" };
    },
  });
  const consumer = new OutboxConsumer(
    {
      workerId: "worker-hanging-heartbeat",
      leaseMs: 100,
      heartbeatMs: 5,
      heartbeatTimeoutMs: 5,
      shutdownTimeoutMs: 5,
    },
    clock,
    store,
    ledger,
    registry,
    new RetryPolicy(
      { baseMs: 10, capMs: 100, jitterRatio: 0, maxAttempts: 3, maxAgeMs: 1_000 },
      () => 0.5,
    ),
    new StructuredLogger("test", "debug", {
      adapterKind: "test-only",
      adapterName: "null-test-log-sink",
      write() {},
    }),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  await store.enqueue(notificationJob("job-hanging-heartbeat"));
  const startedAt = Date.now();
  await consumer.tick();
  assert.equal(observedAbort, true);
  assert.equal(Date.now() - startedAt < 250, true);
  assert.equal((await store.get("job-hanging-heartbeat"))?.state, "leased");
});

test("effect acquisition is atomic and stale owners cannot publish outcomes", async () => {
  const clock = new FakeClock(10);
  const ledger = new InMemoryEffectLedger(clock);
  const [first, second] = await Promise.all([
    ledger.acquire({
      effectKey: "effect:race",
      identityFingerprint: "identity-race",
      payloadFingerprint: "payload-race",
      ownerId: "job-a",
      ownerGeneration: 1,
      leaseExpiresAt: 100,
      allowTakeover: true,
    }),
    ledger.acquire({
      effectKey: "effect:race",
      identityFingerprint: "identity-race",
      payloadFingerprint: "payload-race",
      ownerId: "job-b",
      ownerGeneration: 1,
      leaseExpiresAt: 100,
      allowTakeover: true,
    }),
  ]);
  assert.equal(Number(first.acquired) + Number(second.acquired), 1);
  const winner = first.acquired ? first : second.acquired ? second : undefined;
  assert.ok(winner);
  clock.advance(100);
  const takeover = await ledger.acquire({
    effectKey: "effect:race",
    identityFingerprint: "identity-race",
    payloadFingerprint: "payload-race",
    ownerId: "job-c",
    ownerGeneration: 2,
    leaseExpiresAt: 300,
    allowTakeover: true,
  });
  assert.equal(takeover.acquired, true);
  await assert.rejects(ledger.succeeded(winner.claim), EffectOwnershipError);
  if (takeover.acquired) await ledger.succeeded(takeover.claim);
  assert.equal((await ledger.get("effect:race"))?.state, "succeeded");
});

test("overlapping same-slot recovery cannot share unexpired effect ownership", async () => {
  const clock = new FakeClock(10);
  const ledger = new InMemoryEffectLedger(clock);
  const first = await ledger.acquire({
    effectKey: "effect:leased",
    identityFingerprint: "identity-leased",
    payloadFingerprint: "payload-leased",
    ownerId: "same-job",
    ownerGeneration: 1,
    leaseExpiresAt: 100,
    allowTakeover: true,
  });
  assert.equal(first.acquired, true);
  if (!first.acquired) return;
  const newer = await ledger.acquire({
    effectKey: "effect:leased",
    identityFingerprint: "identity-leased",
    payloadFingerprint: "payload-leased",
    ownerId: "same-job",
    ownerGeneration: 2,
    leaseExpiresAt: 200,
    allowTakeover: true,
  });
  assert.equal(newer.acquired, true);
  if (!newer.acquired) return;
  assert.equal(newer.claim.ownerGeneration, 2);
  assert.equal(newer.previousState, "started");
  await assert.rejects(ledger.heartbeat(first.claim, 200), EffectOwnershipError);
  await assert.rejects(ledger.succeeded(first.claim), EffectOwnershipError);
  await assert.rejects(ledger.outcomeUnknown(first.claim), EffectOwnershipError);
  await assert.rejects(ledger.failedPermanent(first.claim), EffectOwnershipError);
  await ledger.succeeded(newer.claim);
});

test("effect keys reject payload fingerprint conflicts", async () => {
  const ledger = new InMemoryEffectLedger(new FakeClock(10));
  await ledger.acquire({
    effectKey: "effect:bound",
    identityFingerprint: "identity",
    payloadFingerprint: "payload-a",
    ownerId: "job-a",
    ownerGeneration: 1,
    leaseExpiresAt: 100,
  });
  await assert.rejects(
    ledger.acquire({
      effectKey: "effect:bound",
      identityFingerprint: "identity",
      payloadFingerprint: "payload-b",
      ownerId: "job-b",
      ownerGeneration: 1,
      leaseExpiresAt: 100,
    }),
    EffectIdentityConflictError,
  );
});

test("effect payload complexity, bytes, and semantic identifiers are bounded before hashing", () => {
  let deep: JsonValue = "leaf";
  for (let index = 0; index < 40; index += 1) deep = { nested: deep };
  assert.throws(
    () =>
      newJob(
        {
          id: "deep-effect",
          workspaceId: "workspace-1",
          kind: "agent.run",
          payload: { runId: "run-1", deep },
        },
        0,
      ),
    /effect_payload_too_complex/,
  );
  assert.throws(
    () => notificationJob("long-identity", "x".repeat(257)),
    /invalid_effect_identity_intentId/,
  );
  assert.throws(
    () =>
      newJob(
        {
          id: "large-effect",
          workspaceId: "workspace-1",
          kind: "notification.deliver",
          payload: {
            intentId: "large-intent",
            recipientId: "person-1",
            channel: "email",
            resourceId: "post-1",
            authorizationEpoch: 2,
            deliveryRevision: 1,
            minimalMessage: "x".repeat(300_000),
          },
        },
        0,
      ),
    /effect_payload_too_large/,
  );
});

test("a non-cooperative handler is bounded and its late outcome is ignored", async () => {
  const { clock, store, ledger, retry, logSink } = setup();
  let executions = 0;
  let reconciliations = 0;
  const registry = new HandlerRegistry().registerTestOnly("notification.deliver", {
    retryWhenReconciledNotFound: true,
    async execute() {
      executions += 1;
      return new Promise<never>(() => undefined);
    },
    async reconcile() {
      reconciliations += 1;
      return { type: "not_found" };
    },
  });
  const consumer = new OutboxConsumer(
    { workerId: "worker-timeout", leaseMs: 1_000, handlerTimeoutMs: 5 },
    clock,
    store,
    ledger,
    registry,
    retry,
    new StructuredLogger("test-worker", "debug", logSink),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  await store.enqueue(notificationJob("job-timeout"));
  await consumer.tick();
  assert.equal((await store.get("job-timeout"))?.state, "outcome_unknown");
  assert.equal((await store.get("job-timeout"))?.lastErrorCode, "handler_timeout");
  assert.equal(
    (await ledger.get(notificationJob("job-timeout").effectKey))?.state,
    "outcome_unknown",
  );
  clock.advance(1_001);
  await consumer.tick();
  assert.equal(executions, 1);
  assert.equal(reconciliations, 1);
  assert.equal((await store.get("job-timeout"))?.state, "outcome_unknown");
});
