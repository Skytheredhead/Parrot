import assert from "node:assert/strict";
import test from "node:test";
import {
  type DigestClaim,
  type DigestDeliveryAuthority,
  type DigestDeliveryPlan,
  type DigestRecordedOutcome,
  DigestScheduler,
  digestDeliveryKey,
  InMemoryNotificationProvider,
  nextDailyDigestOccurrence,
} from "../src/index.js";

const occurrence = (after: string, localMinute: number, lastOccurrenceLocalDate?: string) =>
  nextDailyDigestOccurrence({
    after: new Date(after),
    timeZone: "America/New_York",
    localMinute,
    ...(lastOccurrenceLocalDate ? { lastOccurrenceLocalDate } : {}),
  });

test("daily occurrence shifts a nonexistent DST minute forward", () => {
  const next = occurrence("2026-03-08T05:00:00.000Z", 150);
  assert.equal(next.scheduledFor.toISOString(), "2026-03-08T07:00:00.000Z");
  assert.equal(next.localDate, "2026-03-08");
  assert.equal(next.shiftedByDst, true);
});

test("daily occurrence uses the first overlapping minute and a local-date cursor prevents replay", () => {
  const first = occurrence("2026-11-01T04:00:00.000Z", 90);
  assert.equal(first.scheduledFor.toISOString(), "2026-11-01T05:30:00.000Z");
  const next = occurrence("2026-11-01T05:31:00.000Z", 90, first.localDate);
  assert.equal(next.scheduledFor.toISOString(), "2026-11-02T06:30:00.000Z");
});

const claim = (overrides: Partial<DigestClaim> = {}): DigestClaim => ({
  claimId: "claim-1",
  workspaceId: "workspace-1",
  recipientId: "recipient-1",
  channel: "email",
  scheduleId: "schedule-1",
  localDate: "2026-07-12",
  scheduledForMs: Date.parse("2026-07-12T13:00:00.000Z"),
  preferenceRevision: 4,
  digestRevision: 7,
  authorizationEpoch: 3,
  workerSlotId: "digest-worker",
  leaseGeneration: 2,
  reconcileFirst: false,
  ...overrides,
});

class FakeAuthority implements DigestDeliveryAuthority {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "fake-digest-authority";
  claims: DigestClaim[] = [claim()];
  plan: DigestDeliveryPlan = {
    ...claim(),
    decision: "deliver",
    deliveryKey: digestDeliveryKey(claim()),
    body: "Your daily digest",
    itemCount: 2,
  };
  current = true;
  outcomes: DigestRecordedOutcome[] = [];

  async claimDue(): Promise<readonly DigestClaim[]> {
    return this.claims;
  }

  async resolvePlan(): Promise<DigestDeliveryPlan> {
    return this.plan;
  }

  async dispatchCurrentPlan<T>(
    _plan: DigestDeliveryPlan & { readonly decision: "deliver" },
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }> {
    return this.current ? { current: true, value: await operation() } : { current: false };
  }

  async recordOutcome(_claim: DigestClaim, outcome: DigestRecordedOutcome): Promise<boolean> {
    this.outcomes.push(outcome);
    return true;
  }
}

test("scheduler delivers inside the final authority fence with a stable per-day key", async () => {
  const authority = new FakeAuthority();
  const provider = new InMemoryNotificationProvider();
  const scheduler = new DigestScheduler(authority, provider, "digest-worker");
  const result = await scheduler.runOnce(
    new Date("2026-07-12T13:01:00.000Z"),
    new AbortController().signal,
  );
  assert.deepEqual(result, { claimed: 1, delivered: 1, suppressed: 0, deferred: 0, invalid: 0 });
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]?.idempotencyKey, digestDeliveryKey(claim()));
  assert.equal(provider.calls[0]?.request.preferenceRevision, 4);
  assert.equal(provider.calls[0]?.request.deliveryRevision, 7);
});

test("stale revisions and an invalid item bound fail closed before provider I/O", async () => {
  const authority = new FakeAuthority();
  assert.equal(authority.plan.decision, "deliver");
  if (authority.plan.decision !== "deliver") throw new Error("expected delivery plan");
  authority.plan = { ...authority.plan, preferenceRevision: 5, itemCount: 51 };
  const provider = new InMemoryNotificationProvider();
  const result = await new DigestScheduler(authority, provider, "digest-worker").runOnce(
    new Date("2026-07-12T13:01:00.000Z"),
    new AbortController().signal,
  );
  assert.equal(result.invalid, 1);
  assert.equal(provider.calls.length, 0);
});

test("a final authority revision fence blocks provider I/O", async () => {
  const authority = new FakeAuthority();
  authority.current = false;
  const provider = new InMemoryNotificationProvider();
  const result = await new DigestScheduler(authority, provider, "digest-worker").runOnce(
    new Date("2026-07-12T13:01:00.000Z"),
    new AbortController().signal,
  );
  assert.equal(result.deferred, 1);
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(authority.outcomes, []);
});

test("suppression is durably recorded and does not call the provider", async () => {
  const authority = new FakeAuthority();
  authority.plan = {
    ...claim(),
    decision: "suppress",
    deliveryKey: digestDeliveryKey(claim()),
    suppressionCode: "recipient_opted_out",
  };
  const provider = new InMemoryNotificationProvider();
  const result = await new DigestScheduler(authority, provider, "digest-worker").runOnce(
    new Date("2026-07-12T13:01:00.000Z"),
    new AbortController().signal,
  );
  assert.equal(result.suppressed, 1);
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(authority.outcomes, [{ type: "suppressed", code: "recipient_opted_out" }]);
});

test("ambiguous claims reconcile by the same key before any replay", async () => {
  const authority = new FakeAuthority();
  const ambiguousClaim = claim({ reconcileFirst: true });
  authority.claims = [ambiguousClaim];
  authority.plan = {
    ...authority.plan,
    reconcileFirst: true,
    deliveryKey: digestDeliveryKey(ambiguousClaim),
  };
  const provider = new InMemoryNotificationProvider();
  await provider.send(
    {
      intentId: "schedule-1",
      recipientId: "recipient-1",
      channel: "email",
      resourceId: "schedule-1",
      authorizationEpoch: 3,
      deliveryRevision: 7,
      preferenceRevision: 4,
      content: { format: "plain_text", body: "prior send" },
      deliveryKey: digestDeliveryKey(claim()),
      coalescingKey: digestDeliveryKey(claim()),
    },
    digestDeliveryKey(claim()),
    new AbortController().signal,
  );
  const result = await new DigestScheduler(authority, provider, "digest-worker").runOnce(
    new Date("2026-07-12T13:01:00.000Z"),
    new AbortController().signal,
  );
  assert.equal(result.delivered, 1);
  assert.equal(provider.calls.length, 1);
});

test("claim batches are bounded even if an authority violates the contract", async () => {
  const authority = new FakeAuthority();
  authority.claims = Array.from({ length: 3 }, (_, index) =>
    claim({ claimId: `claim-${index}`, scheduleId: `schedule-${index}` }),
  );
  await assert.rejects(
    new DigestScheduler(authority, new InMemoryNotificationProvider(), "digest-worker").runOnce(
      new Date("2026-07-12T13:01:00.000Z"),
      new AbortController().signal,
      2,
    ),
    /digest_claim_bound_exceeded/,
  );
});

test("malformed provider results fail closed before durable recording", async () => {
  const authority = new FakeAuthority();
  const provider = new InMemoryNotificationProvider();
  provider.nextResult = {
    type: "succeeded",
    providerReference: "unsafe reference",
  };
  const result = await new DigestScheduler(authority, provider, "digest-worker").runOnce(
    new Date("2026-07-12T13:01:00.000Z"),
    new AbortController().signal,
  );
  assert.equal(result.invalid, 1);
  assert.deepEqual(authority.outcomes, []);
});

test("calendar-invalid local dates cannot enter idempotency keys", () => {
  assert.throws(() => digestDeliveryKey(claim({ localDate: "2025-02-29" })), /local_date/);
});
