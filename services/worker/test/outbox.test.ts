import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeClock,
  EffectIdentityConflictError,
  EffectOwnershipError,
  HandlerRegistry,
  InMemoryAuthorizationGate,
  InMemoryEffectLedger,
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
  const provider = new InMemoryNotificationProvider();
  const registry = new HandlerRegistry().register(
    "notification.deliver",
    createNotificationDeliveryHandler(authorization, provider),
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
  return { clock, store, ledger, authorization, provider, registry, retry, consumer, logSink };
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
        minimalMessage: "Activity needs your attention",
      },
    },
    1_000,
  );

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
    "notification_message_too_large",
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

test("a newer owner generation cannot take over an unexpired effect lease", async () => {
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
  const newer = await ledger.acquire({
    effectKey: "effect:leased",
    identityFingerprint: "identity-leased",
    payloadFingerprint: "payload-leased",
    ownerId: "same-job",
    ownerGeneration: 2,
    leaseExpiresAt: 200,
    allowTakeover: true,
  });
  assert.equal(newer.acquired, false);
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
