import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeClock,
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
  StructuredLogger,
  createNotificationDeliveryHandler,
  newJob,
  type NotificationDeliveryAuthority,
  type NotificationDeliveryPlan,
  type NotificationPlanInput,
  type NotificationProviderResult,
} from "../src/index.js";

const notificationJob = (id = "notification-job", intentId = "intent-1") => ({
  ...newJob(
    {
      id,
      workspaceId: "workspace-1",
      kind: "notification.deliver",
      payload: {
        intentId,
        recipientId: "person-1",
        channel: "email",
        resourceId: "post-1",
        authorizationEpoch: 7,
        deliveryRevision: 1,
        minimalMessage: "  Activity needs your attention  ",
      },
    },
    1_000,
  ),
  state: "leased" as const,
  leaseOwner: "notification-service",
  leaseWorkerSlotId: "notification-worker-slot",
  leaseExpiresAt: 10_000,
  leaseGeneration: 1,
});

class TransformingAuthority implements NotificationDeliveryAuthority {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "transforming-notification-authority";

  constructor(
    private readonly transform: (input: NotificationPlanInput) => NotificationDeliveryPlan,
  ) {}

  async resolvePlan(
    input: NotificationPlanInput,
    signal: AbortSignal,
  ): Promise<NotificationDeliveryPlan> {
    if (signal.aborted) throw signal.reason;
    return this.transform(input);
  }

  async dispatchCurrentPlan<T>(
    _plan: NotificationDeliveryPlan & { readonly decision: "deliver" },
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }> {
    const pending = operation();
    return { current: true, value: await pending };
  }
}

test("notification send begins inside the final authorization fence", async () => {
  const authorization = new InMemoryAuthorizationGate();
  const provider = new InMemoryNotificationProvider();
  const authority = new TransformingAuthority((input) => {
    authorization.setAllowed(false);
    return { ...input, decision: "deliver", preferenceRevision: 3 };
  });
  const handler = createNotificationDeliveryHandler(authorization, authority, provider);

  assert.deepEqual(
    await handler.execute(notificationJob(), "ignored-effect-key", new AbortController().signal),
    { type: "permanent_failure", code: "delivery_revoked" },
  );
  assert.equal(provider.calls.length, 0);
  assert.equal(authorization.checks, 1);
});

test("recipient preference revocation after planning prevents provider dispatch", async () => {
  class RevokedBeforeDispatchAuthority extends TransformingAuthority {
    override async dispatchCurrentPlan<T>(
      _plan: NotificationDeliveryPlan & { readonly decision: "deliver" },
      _operation: () => Promise<T>,
    ): Promise<{ readonly current: false }> {
      return { current: false };
    }
  }

  const authorization = new InMemoryAuthorizationGate();
  const provider = new InMemoryNotificationProvider();
  const authority = new RevokedBeforeDispatchAuthority((input) => ({
    ...input,
    decision: "deliver",
    preferenceRevision: 3,
  }));
  const handler = createNotificationDeliveryHandler(authorization, authority, provider);

  assert.deepEqual(
    await handler.execute(notificationJob(), "ignored-effect-key", new AbortController().signal),
    { type: "transient_failure", code: "notification_plan_stale" },
  );
  assert.equal(provider.calls.length, 0);
});

test("recipient preference plans are exact-bound and suppression is a successful no-op", async () => {
  const authorization = new InMemoryAuthorizationGate();
  const provider = new InMemoryNotificationProvider();
  const mismatched = new TransformingAuthority((input) => ({
    ...input,
    recipientId: "other-person",
    decision: "deliver",
    preferenceRevision: 1,
  }));
  const invalid = createNotificationDeliveryHandler(authorization, mismatched, provider);
  assert.deepEqual(
    await invalid.execute(notificationJob(), "ignored", new AbortController().signal),
    { type: "permanent_failure", code: "notification_plan_invalid" },
  );
  assert.equal(provider.calls.length, 0);

  const suppressed = new TransformingAuthority((input) => ({
    ...input,
    decision: "suppress",
    preferenceRevision: 9,
    suppressionCode: "recipient_opted_out",
  }));
  const suppressionHandler = createNotificationDeliveryHandler(authorization, suppressed, provider);
  assert.deepEqual(
    await suppressionHandler.execute(notificationJob(), "ignored", new AbortController().signal),
    {
      type: "succeeded",
      result: { suppressed: true, code: "recipient_opted_out" },
    },
  );
  assert.equal(provider.calls.length, 0);
});

test("rendering and intent-bound delivery identity are deterministic and bounded", async () => {
  const authorization = new InMemoryAuthorizationGate();
  const authority = new InMemoryNotificationDeliveryAuthority();
  const provider = new InMemoryNotificationProvider();
  const handler = createNotificationDeliveryHandler(authorization, authority, provider);
  const job = notificationJob();

  await handler.execute(job, "effect-a", new AbortController().signal);
  await handler.execute(job, "effect-b", new AbortController().signal);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0]?.idempotencyKey, provider.calls[1]?.idempotencyKey);
  assert.equal(provider.calls[0]?.request.deliveryKey, provider.calls[0]?.request.coalescingKey);
  assert.equal(provider.calls[0]?.request.content.format, "plain_text");
  assert.equal(provider.calls[0]?.request.content.body, "Activity needs your attention");

  await handler.execute(
    notificationJob("notification-job-2", "intent-2"),
    "effect-c",
    new AbortController().signal,
  );
  assert.notEqual(provider.calls[0]?.idempotencyKey, provider.calls[2]?.idempotencyKey);

  const controlCharacterJob = {
    ...newJob(
      {
        id: "notification-control",
        workspaceId: "workspace-1",
        kind: "notification.deliver",
        payload: {
          intentId: "intent-control",
          recipientId: "person-1",
          channel: "push",
          resourceId: "post-1",
          authorizationEpoch: 7,
          deliveryRevision: 1,
          minimalMessage: "unsafe\u0000body",
        },
      },
      1_000,
    ),
    state: "leased" as const,
    leaseOwner: "notification-service",
    leaseWorkerSlotId: "notification-worker-slot",
    leaseExpiresAt: 10_000,
    leaseGeneration: 1,
  };
  assert.deepEqual(
    await handler.execute(controlCharacterJob, "effect-d", new AbortController().signal),
    { type: "permanent_failure", code: "notification_message_invalid" },
  );
  assert.equal(provider.calls.length, 3);
});

test("provider outcomes are classified and ambiguous delivery reconciles by stable key", async () => {
  const authorization = new InMemoryAuthorizationGate();
  const authority = new InMemoryNotificationDeliveryAuthority();
  const provider = new InMemoryNotificationProvider();
  const handler = createNotificationDeliveryHandler(authorization, authority, provider);
  const job = notificationJob();

  provider.nextResult = { type: "transient_failure", code: "rate_limited", retryAfterMs: 2_000 };
  assert.deepEqual(await handler.execute(job, "ignored", new AbortController().signal), {
    type: "transient_failure",
    code: "rate_limited",
    retryAfterMs: 2_000,
  });

  provider.nextResult = {
    type: "transient_failure",
    code: "rate_limited",
    retryAfterMs: 86_400_001,
  };
  assert.deepEqual(await handler.execute(job, "ignored", new AbortController().signal), {
    type: "permanent_failure",
    code: "provider_retry_invalid",
  });

  provider.nextResult = {
    type: "transient_failure",
    code: "invented_provider_code",
  } as unknown as NotificationProviderResult;
  assert.deepEqual(await handler.execute(job, "ignored", new AbortController().signal), {
    type: "permanent_failure",
    code: "provider_result_invalid",
  });

  provider.nextResult = {
    type: "outcome_unknown",
    code: "connection_lost_after_send",
  };
  assert.deepEqual(await handler.execute(job, "ignored", new AbortController().signal), {
    type: "outcome_unknown",
    code: "connection_lost_after_send",
  });
  const deliveryKey = provider.calls.at(-1)?.idempotencyKey;
  assert.ok(deliveryKey);
  assert.deepEqual(await handler.reconcile("ignored", job, new AbortController().signal), {
    type: "not_found",
  });
  provider.nextResult = { type: "succeeded", providerReference: "provider-reference-1" };
  await handler.execute(job, "ignored", new AbortController().signal);
  assert.equal(provider.calls.at(-1)?.idempotencyKey, deliveryKey);
  assert.deepEqual(await handler.reconcile("ignored", job, new AbortController().signal), {
    type: "succeeded",
    providerReference: "provider-reference-1",
  });
});

test("authority failure retries safely and a thrown provider dispatch is outcome-unknown", async () => {
  const authorization = new InMemoryAuthorizationGate();
  const unavailableAuthority: NotificationDeliveryAuthority = {
    adapterKind: "test-only",
    adapterName: "unavailable-notification-authority",
    async resolvePlan(): Promise<never> {
      throw new Error("authority_unavailable");
    },
    async dispatchCurrentPlan(): Promise<never> {
      throw new Error("unreachable");
    },
  };
  const provider = new InMemoryNotificationProvider();
  const unavailableHandler = createNotificationDeliveryHandler(
    authorization,
    unavailableAuthority,
    provider,
  );
  assert.deepEqual(
    await unavailableHandler.execute(notificationJob(), "ignored", new AbortController().signal),
    { type: "transient_failure", code: "notification_plan_unavailable" },
  );
  assert.equal(provider.calls.length, 0);

  class ThrowingProvider extends InMemoryNotificationProvider {
    override async send(): Promise<never> {
      throw new Error("socket_closed_after_write");
    }
  }
  const throwingProvider = new ThrowingProvider();
  const handler = createNotificationDeliveryHandler(
    authorization,
    new InMemoryNotificationDeliveryAuthority(),
    throwingProvider,
  );
  assert.deepEqual(
    await handler.execute(notificationJob(), "ignored", new AbortController().signal),
    { type: "outcome_unknown", code: "provider_dispatch_exception" },
  );
});

test("permanent provider classification durably dead-letters through the outbox", async () => {
  const clock = new FakeClock(1_000);
  const store = new InMemoryTransactionalOutbox(clock);
  const ledger = new InMemoryEffectLedger(clock);
  const authorization = new InMemoryAuthorizationGate();
  const authority = new InMemoryNotificationDeliveryAuthority();
  const provider = new InMemoryNotificationProvider();
  provider.nextResult = { type: "permanent_failure", code: "invalid_recipient" };
  const handlers = new HandlerRegistry().register(
    "notification.deliver",
    createNotificationDeliveryHandler(authorization, authority, provider),
  );
  const consumer = new OutboxConsumer(
    { workerId: "notification-worker", leaseMs: 1_000 },
    clock,
    store,
    ledger,
    handlers,
    new RetryPolicy(
      { baseMs: 10, capMs: 100, jitterRatio: 0, maxAttempts: 3, maxAgeMs: 60_000 },
      () => 0.5,
    ),
    new StructuredLogger("notification-test", "error", {
      adapterKind: "test-only",
      adapterName: "notification-test-log-sink",
      write() {},
    }),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  const {
    leaseOwner: _leaseOwner,
    leaseWorkerSlotId: _leaseWorkerSlotId,
    leaseExpiresAt: _leaseExpiresAt,
    ...queued
  } = notificationJob("notification-dead-letter");
  await store.enqueue({ ...queued, state: "pending" });

  assert.equal(await consumer.tick(), true);
  assert.equal((await store.get("notification-dead-letter"))?.state, "dead_letter");
  assert.equal(
    (await store.get("notification-dead-letter"))?.deadLetterReason,
    "invalid_recipient",
  );
});
