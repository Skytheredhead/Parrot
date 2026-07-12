import { createHash } from "node:crypto";
import type {
  Clock,
  EffectClaim,
  EffectRecord,
  EffectResult,
  EffectState,
  JsonValue,
  LeaseToken,
  OutboxJob,
  ReconciliationResult,
} from "./domain.js";
import { StaleLeaseError, errorCode } from "./domain.js";
import type { StructuredLogger, OpenTelemetry } from "./telemetry.js";
import { isReviewedHandler } from "./reviewed-handlers.js";

const MAX_EFFECT_PAYLOAD_BYTES = 256 * 1024;
const MAX_EFFECT_PAYLOAD_DEPTH = 32;
const MAX_EFFECT_PAYLOAD_NODES = 10_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,256}$/;
const JOB_KINDS = new Set<OutboxJob["kind"]>([
  "notification.deliver",
  "search.upsert",
  "search.tombstone",
  "search.rebuild",
  "file.scan",
  "file.extract",
  "file.cleanup",
  "agent.run",
]);

const validateEffectPayload = (value: JsonValue): void => {
  const pending: Array<{ value: JsonValue; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_EFFECT_PAYLOAD_NODES || current.depth > MAX_EFFECT_PAYLOAD_DEPTH) {
      throw new Error("effect_payload_too_complex");
    }
    if (typeof current.value === "number" && !Number.isSafeInteger(current.value)) {
      throw new Error("invalid_effect_payload");
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    for (const [key, nested] of Object.entries(current.value)) {
      if (
        key.length === 0 ||
        key.length > 128 ||
        ["__proto__", "constructor", "prototype"].includes(key)
      ) {
        throw new Error("invalid_effect_payload_key");
      }
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
};

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("invalid_effect_payload");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`)
    .join(",")}}`;
};

const payloadField = (payload: JsonValue, key: string): string => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("invalid_effect_payload");
  }
  const value = (payload as Readonly<Record<string, JsonValue>>)[key];
  if ((typeof value !== "string" || value.length === 0) && !Number.isSafeInteger(value)) {
    throw new Error(`missing_effect_identity_${key}`);
  }
  const normalized = String(value);
  if (!SAFE_IDENTIFIER.test(normalized)) throw new Error(`invalid_effect_identity_${key}`);
  return normalized;
};

const semanticResource = (job: Pick<OutboxJob, "kind" | "payload">): string => {
  switch (job.kind) {
    case "notification.deliver":
      return `intent:${payloadField(job.payload, "intentId")}`;
    case "search.upsert":
    case "search.tombstone":
      return `resource:${payloadField(job.payload, "resourceId")}:acl:${payloadField(job.payload, "aclRevision")}:revision:${payloadField(job.payload, "resourceRevision")}`;
    case "search.rebuild":
      return `rebuild:${payloadField(job.payload, "rebuildId")}:generation:${payloadField(job.payload, "generation")}`;
    case "file.scan":
    case "file.extract":
    case "file.cleanup":
      return `file:${payloadField(job.payload, "fileId")}:version:${payloadField(job.payload, "version")}`;
    case "agent.run":
      return `run:${payloadField(job.payload, "runId")}`;
  }
};

export interface DerivedEffectIdentity {
  readonly effectKey: string;
  readonly identityFingerprint: string;
  readonly payloadFingerprint: string;
  readonly semanticResource: string;
}

export const deriveEffectIdentity = (
  job: Pick<OutboxJob, "workspaceId" | "kind" | "payload">,
): DerivedEffectIdentity => {
  if (!SAFE_IDENTIFIER.test(job.workspaceId)) throw new Error("invalid_effect_workspace");
  if (!JOB_KINDS.has(job.kind)) throw new Error("invalid_effect_kind");
  validateEffectPayload(job.payload);
  const resource = semanticResource(job);
  const canonicalPayload = canonicalJson(job.payload);
  if (Buffer.byteLength(canonicalPayload, "utf8") > MAX_EFFECT_PAYLOAD_BYTES) {
    throw new Error("effect_payload_too_large");
  }
  const identityMaterial = `${job.workspaceId}\0${job.kind}\0${resource}`;
  const identityFingerprint = createHash("sha256").update(identityMaterial).digest("hex");
  const payloadFingerprint = createHash("sha256").update(canonicalPayload).digest("hex");
  return {
    effectKey: `effect:${identityFingerprint}`,
    identityFingerprint,
    payloadFingerprint,
    semanticResource: resource,
  };
};

const runWithDeadline = async <T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutCode = "handler_timeout",
): Promise<T> => {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectAbort?.(reason);
  };
  const onParentAbort = (): void => abort(parentSignal.reason ?? new StaleLeaseError("unknown"));
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  timeout = setTimeout(() => {
    const error = new Error(timeoutCode);
    error.name = timeoutCode;
    abort(error);
  }, timeoutMs);
  timeout.unref?.();
  const pending = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([pending, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal.removeEventListener("abort", onParentAbort);
    void pending.catch(() => undefined);
  }
};

export interface RetryPolicyOptions {
  readonly baseMs: number;
  readonly capMs: number;
  readonly jitterRatio: number;
  readonly maxAttempts: number;
  readonly maxAgeMs: number;
}

export type AdapterKind = "test-only" | "durable";

export interface RuntimeAdapter {
  readonly adapterKind: AdapterKind;
  readonly adapterName: string;
  /** Side-effect-free executable contract self-test; production composition invokes it. */
  assertProductionReady?(): boolean;
  /** Bounded live dependency check used by the process readiness endpoint. */
  ready?(signal: AbortSignal): Promise<boolean>;
  /** Optional bounded resource cleanup invoked after polling has drained or aborted. */
  close?(signal: AbortSignal): Promise<void>;
}

export class RetryPolicy {
  constructor(
    readonly options: RetryPolicyOptions,
    private readonly random: () => number = Math.random,
  ) {}

  delayMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.max(0, retryAfterMs);
    const raw = Math.min(this.options.capMs, this.options.baseMs * 2 ** Math.max(0, attempt - 1));
    const spread = raw * this.options.jitterRatio;
    return Math.round(raw - spread + this.random() * spread * 2);
  }

  exhausted(job: OutboxJob, now: number): boolean {
    return job.attempt >= this.options.maxAttempts || now - job.createdAt >= this.options.maxAgeMs;
  }
}

export interface OutboxStore extends RuntimeAdapter {
  enqueue(job: OutboxJob): Promise<void>;
  /**
   * Atomically finds an unexpired lease owned by the authenticated adapter identity and exact
   * `workerSlotId`, atomically advances the generation, extends the lease to at least
   * `now + leaseMs`, and returns only that new fence. Implementations must never preserve the old
   * generation or return expired/foreign-slot leases. This is the response-loss restart takeover
   * step and must run before `claim`.
   */
  recoverOwned(
    workerSlotId: string,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<{ readonly job: OutboxJob; readonly lease: LeaseToken } | undefined>;
  claim(
    workerSlotId: string,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<{ readonly job: OutboxJob; readonly lease: LeaseToken } | undefined>;
  heartbeat(lease: LeaseToken, leaseExpiresAt: number): Promise<LeaseToken>;
  complete(lease: LeaseToken, result?: JsonValue): Promise<void>;
  retry(lease: LeaseToken, nextAttemptAt: number, code: string): Promise<void>;
  outcomeUnknown(lease: LeaseToken, nextAttemptAt: number, code: string): Promise<void>;
  deadLetter(lease: LeaseToken, reason: string): Promise<void>;
  get(jobId: string): Promise<OutboxJob | undefined>;
}

const withoutLease = (job: OutboxJob): OutboxJob => {
  const {
    leaseOwner: _owner,
    leaseWorkerSlotId: _workerSlotId,
    leaseExpiresAt: _expiry,
    ...rest
  } = job;
  return rest;
};

export class InMemoryTransactionalOutbox implements OutboxStore {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "in-memory-outbox";
  private readonly jobs = new Map<string, OutboxJob>();
  readonly completions = new Map<string, JsonValue | undefined>();

  constructor(private readonly clock: Clock) {}

  async enqueue(job: OutboxJob): Promise<void> {
    if (!this.jobs.has(job.id)) this.jobs.set(job.id, structuredClone(job));
  }

  async recoverOwned(
    workerSlotId: string,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<{ readonly job: OutboxJob; readonly lease: LeaseToken } | undefined> {
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    const now = this.clock.now();
    const owned = [...this.jobs.values()]
      .filter(
        (job) =>
          job.state === "leased" &&
          job.leaseOwner === this.adapterName &&
          job.leaseWorkerSlotId === workerSlotId &&
          (job.leaseExpiresAt ?? 0) > now,
      )
      .sort(
        (a, b) =>
          (a.leaseExpiresAt ?? 0) - (b.leaseExpiresAt ?? 0) ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      )[0];
    if (!owned) return undefined;

    if (!Number.isSafeInteger(owned.leaseGeneration + 1)) {
      throw new StaleLeaseError(owned.id);
    }
    const generation = owned.leaseGeneration + 1;
    const expiresAt = Math.max(owned.leaseExpiresAt ?? 0, now + leaseMs);
    const recovered: OutboxJob = {
      ...owned,
      leaseGeneration: generation,
      leaseExpiresAt: expiresAt,
    };
    this.jobs.set(recovered.id, recovered);
    return {
      job: structuredClone(recovered),
      lease: {
        jobId: recovered.id,
        owner: this.adapterName,
        workerSlotId,
        generation,
        expiresAt,
      },
    };
  }

  async claim(
    workerSlotId: string,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<{ readonly job: OutboxJob; readonly lease: LeaseToken } | undefined> {
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    const now = this.clock.now();
    const eligible = [...this.jobs.values()]
      .filter(
        (job) =>
          ((job.state === "pending" || job.state === "outcome_unknown") &&
            job.nextAttemptAt <= now) ||
          (job.state === "leased" && (job.leaseExpiresAt ?? 0) <= now),
      )
      .sort(
        (a, b) =>
          a.nextAttemptAt - b.nextAttemptAt ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      )[0];
    if (!eligible) return undefined;

    const generation = eligible.leaseGeneration + 1;
    const expiresAt = now + leaseMs;
    const claimed: OutboxJob = {
      ...withoutLease(eligible),
      state: "leased",
      attempt: eligible.attempt + 1,
      leaseOwner: this.adapterName,
      leaseWorkerSlotId: workerSlotId,
      leaseExpiresAt: expiresAt,
      leaseGeneration: generation,
    };
    this.jobs.set(claimed.id, claimed);
    return {
      job: structuredClone(claimed),
      lease: {
        jobId: claimed.id,
        owner: this.adapterName,
        workerSlotId,
        generation,
        expiresAt,
      },
    };
  }

  async heartbeat(lease: LeaseToken, leaseExpiresAt: number): Promise<LeaseToken> {
    const job = this.assertLease(lease);
    if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= this.clock.now()) {
      throw new StaleLeaseError(lease.jobId);
    }
    this.jobs.set(job.id, { ...job, leaseExpiresAt });
    return { ...lease, expiresAt: leaseExpiresAt };
  }

  async complete(lease: LeaseToken, result?: JsonValue): Promise<void> {
    const job = this.assertLease(lease);
    this.jobs.set(job.id, { ...withoutLease(job), state: "succeeded" });
    this.completions.set(job.id, result);
  }

  async retry(lease: LeaseToken, nextAttemptAt: number, code: string): Promise<void> {
    const job = this.assertLease(lease);
    this.jobs.set(job.id, {
      ...withoutLease(job),
      state: "pending",
      nextAttemptAt,
      lastErrorCode: code,
    });
  }

  async outcomeUnknown(lease: LeaseToken, nextAttemptAt: number, code: string): Promise<void> {
    const job = this.assertLease(lease);
    this.jobs.set(job.id, {
      ...withoutLease(job),
      state: "outcome_unknown",
      nextAttemptAt,
      lastErrorCode: code,
    });
  }

  async deadLetter(lease: LeaseToken, reason: string): Promise<void> {
    const job = this.assertLease(lease);
    this.jobs.set(job.id, {
      ...withoutLease(job),
      state: "dead_letter",
      deadLetterReason: reason,
      lastErrorCode: reason,
    });
  }

  async get(jobId: string): Promise<OutboxJob | undefined> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  private assertLease(lease: LeaseToken): OutboxJob {
    const job = this.jobs.get(lease.jobId);
    if (
      job?.state !== "leased" ||
      job.leaseOwner !== lease.owner ||
      job.leaseWorkerSlotId !== lease.workerSlotId ||
      job.leaseGeneration !== lease.generation ||
      (job.leaseExpiresAt ?? 0) <= this.clock.now()
    ) {
      throw new StaleLeaseError(lease.jobId);
    }
    return job;
  }
}

export interface EffectAcquireInput extends EffectClaim {
  readonly payloadFingerprint: string;
  readonly leaseExpiresAt: number;
  /**
   * Allows takeover after expiry or immediately when the same durable owner presents a strictly
   * newer authoritative generation. The latter fences a still-running pre-recovery process.
   */
  readonly allowTakeover?: boolean;
}

export type EffectAcquireResult =
  | {
      readonly acquired: true;
      readonly claim: EffectClaim;
      readonly record: EffectRecord;
      readonly previousState?: EffectState;
    }
  | { readonly acquired: false; readonly record: EffectRecord };

export interface EffectLedger extends RuntimeAdapter {
  acquire(input: EffectAcquireInput): Promise<EffectAcquireResult>;
  get(effectKey: string): Promise<EffectRecord | undefined>;
  heartbeat(claim: EffectClaim, leaseExpiresAt: number): Promise<void>;
  succeeded(claim: EffectClaim, providerReference?: string, result?: JsonValue): Promise<void>;
  outcomeUnknown(claim: EffectClaim): Promise<void>;
  failedPermanent(claim: EffectClaim): Promise<void>;
}

export class EffectOwnershipError extends Error {
  constructor(effectKey: string) {
    super(`Effect ownership is stale for ${effectKey}`);
    this.name = "EffectOwnershipError";
  }
}

export class EffectIdentityConflictError extends Error {
  constructor(effectKey: string) {
    super(`Effect identity conflicts with existing record for ${effectKey}`);
    this.name = "EffectIdentityConflictError";
  }
}

export class InMemoryEffectLedger implements EffectLedger {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "in-memory-effect-ledger";
  private readonly effects = new Map<string, EffectRecord>();

  constructor(private readonly clock: Clock) {}

  async acquire(input: EffectAcquireInput): Promise<EffectAcquireResult> {
    const existing = this.effects.get(input.effectKey);
    if (!existing) {
      const created: EffectRecord = {
        effectKey: input.effectKey,
        identityFingerprint: input.identityFingerprint,
        payloadFingerprint: input.payloadFingerprint,
        state: "started",
        ownerId: input.ownerId,
        ownerGeneration: input.ownerGeneration,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: this.clock.now(),
      };
      this.effects.set(input.effectKey, created);
      return { acquired: true, claim: claimOf(created), record: structuredClone(created) };
    }
    if (
      existing.identityFingerprint !== input.identityFingerprint ||
      existing.payloadFingerprint !== input.payloadFingerprint
    ) {
      throw new EffectIdentityConflictError(input.effectKey);
    }
    if (existing.state === "succeeded" || existing.state === "failed_permanent") {
      return { acquired: false, record: structuredClone(existing) };
    }
    if (
      existing.ownerId === input.ownerId &&
      existing.ownerGeneration === input.ownerGeneration &&
      existing.leaseExpiresAt > this.clock.now()
    ) {
      const renewed = { ...existing, leaseExpiresAt: input.leaseExpiresAt };
      this.effects.set(input.effectKey, renewed);
      return {
        acquired: true,
        claim: claimOf(renewed),
        record: structuredClone(renewed),
        previousState: existing.state,
      };
    }
    const expired = existing.leaseExpiresAt <= this.clock.now();
    const newerGenerationForSameOwner =
      existing.ownerId === input.ownerId && input.ownerGeneration > existing.ownerGeneration;
    if (!input.allowTakeover || (!expired && !newerGenerationForSameOwner)) {
      return { acquired: false, record: structuredClone(existing) };
    }
    const previousState = existing.state;
    const acquired: EffectRecord = {
      effectKey: input.effectKey,
      identityFingerprint: input.identityFingerprint,
      payloadFingerprint: input.payloadFingerprint,
      state: "started",
      ownerId: input.ownerId,
      ownerGeneration: input.ownerGeneration,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: this.clock.now(),
    };
    this.effects.set(input.effectKey, acquired);
    return {
      acquired: true,
      claim: claimOf(acquired),
      record: structuredClone(acquired),
      previousState,
    };
  }

  async get(effectKey: string): Promise<EffectRecord | undefined> {
    const record = this.effects.get(effectKey);
    return record ? structuredClone(record) : undefined;
  }

  async heartbeat(claim: EffectClaim, leaseExpiresAt: number): Promise<void> {
    const record = this.assertOwner(claim);
    this.effects.set(claim.effectKey, {
      ...record,
      leaseExpiresAt,
      updatedAt: this.clock.now(),
    });
  }

  async succeeded(
    claim: EffectClaim,
    providerReference?: string,
    result?: JsonValue,
  ): Promise<void> {
    const record = this.assertOwner(claim);
    this.effects.set(claim.effectKey, {
      ...record,
      state: "succeeded",
      ...(providerReference ? { providerReference } : {}),
      ...(result !== undefined ? { result } : {}),
      updatedAt: this.clock.now(),
    });
  }

  async outcomeUnknown(claim: EffectClaim): Promise<void> {
    const record = this.assertOwner(claim);
    this.effects.set(claim.effectKey, {
      ...record,
      state: "outcome_unknown",
      updatedAt: this.clock.now(),
    });
  }

  async failedPermanent(claim: EffectClaim): Promise<void> {
    const record = this.assertOwner(claim);
    this.effects.set(claim.effectKey, {
      ...record,
      state: "failed_permanent",
      updatedAt: this.clock.now(),
    });
  }

  private assertOwner(claim: EffectClaim): EffectRecord {
    const record = this.effects.get(claim.effectKey);
    if (
      !record ||
      record.ownerId !== claim.ownerId ||
      record.ownerGeneration !== claim.ownerGeneration ||
      record.identityFingerprint !== claim.identityFingerprint ||
      record.leaseExpiresAt <= this.clock.now()
    ) {
      throw new EffectOwnershipError(claim.effectKey);
    }
    return record;
  }
}

const claimOf = (record: EffectRecord): EffectClaim => ({
  effectKey: record.effectKey,
  identityFingerprint: record.identityFingerprint,
  ownerId: record.ownerId,
  ownerGeneration: record.ownerGeneration,
});

export interface JobHandler {
  /** False for effects that must never be automatically repeated after ambiguity. */
  readonly retryWhenReconciledNotFound: boolean;
  readonly dependencies?: readonly RuntimeAdapter[];
  execute(job: OutboxJob, effectKey: string, signal: AbortSignal): Promise<EffectResult>;
  reconcile(effectKey: string, job: OutboxJob, signal: AbortSignal): Promise<ReconciliationResult>;
}

export class HandlerRegistry {
  readonly #handlers = new Map<OutboxJob["kind"], JobHandler>();

  register(kind: OutboxJob["kind"], handler: JobHandler): this {
    if (this.#handlers.has(kind)) throw new Error(`duplicate_handler_registration:${kind}`);
    if (!isReviewedHandler(handler, kind)) throw new Error(`unreviewed_handler:${kind}`);
    this.#handlers.set(kind, handler);
    return this;
  }

  /** Test-only escape hatch. Production composition rejects every handler registered this way. */
  registerTestOnly(kind: OutboxJob["kind"], handler: JobHandler): this {
    if (this.#handlers.has(kind)) throw new Error(`duplicate_handler_registration:${kind}`);
    this.#handlers.set(kind, handler);
    return this;
  }

  get(kind: OutboxJob["kind"]): JobHandler {
    const handler = this.#handlers.get(kind);
    if (!handler) throw new Error(`No handler registered for ${kind}`);
    return handler;
  }

  entries(): readonly (readonly [OutboxJob["kind"], JobHandler])[] {
    return Object.freeze([...this.#handlers.entries()].map((entry) => Object.freeze(entry)));
  }

  isReviewed(kind: OutboxJob["kind"], handler: JobHandler): boolean {
    return this.#handlers.get(kind) === handler && isReviewedHandler(handler, kind);
  }
}

export interface OutboxConsumerOptions {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly heartbeatMs?: number;
  readonly handlerTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly claimTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

const boundedWait = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.name = code;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    void operation.catch(() => undefined);
  }
};

type ClaimedOutboxJob = {
  readonly job: OutboxJob;
  readonly lease: LeaseToken;
};

interface InFlightAcquisition {
  readonly controller: AbortController;
  readonly promise: Promise<ClaimedOutboxJob | undefined>;
}

const awaitRetainedOperation = async <T>(
  operation: Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
  cancel: (reason: unknown) => void,
): Promise<{
  readonly operationSettled: boolean;
  readonly value?: T;
  readonly error?: unknown;
}> => {
  type Winner =
    | { readonly type: "operation"; readonly value: T }
    | { readonly type: "operation_error"; readonly error: unknown }
    | { readonly type: "timeout"; readonly error: Error }
    | { readonly type: "abort"; readonly error: unknown };

  let timer: NodeJS.Timeout | undefined;
  let resolveAbort: ((winner: Winner) => void) | undefined;
  const aborted = new Promise<Winner>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = (): void => {
    const error = parentSignal.reason ?? new StaleLeaseError("unknown");
    cancel(error);
    resolveAbort?.({ type: "abort", error });
  };
  if (parentSignal.aborted) onAbort();
  else parentSignal.addEventListener("abort", onAbort, { once: true });
  const timedOut = new Promise<Winner>((resolve) => {
    timer = setTimeout(() => {
      const error = new Error(timeoutCode);
      error.name = timeoutCode;
      resolve({ type: "timeout", error });
    }, timeoutMs);
    timer.unref?.();
  });
  const settled = operation.then<Winner, Winner>(
    (value) => ({ type: "operation", value }),
    (error: unknown) => ({ type: "operation_error", error }),
  );

  try {
    const winner = await Promise.race([settled, timedOut, aborted]);
    if (winner.type === "operation") return { operationSettled: true, value: winner.value };
    if (winner.type === "operation_error") {
      return { operationSettled: true, error: winner.error };
    }
    return { operationSettled: false, error: winner.error };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener("abort", onAbort);
  }
};

class LeaseController {
  readonly signal: AbortSignal;
  private readonly abortController = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private current: LeaseToken;
  private heartbeatInFlight: Promise<void> | undefined;
  private stopped = false;
  private failure: unknown;

  constructor(
    lease: LeaseToken,
    private readonly leaseMs: number,
    private readonly heartbeatMs: number,
    private readonly heartbeatTimeoutMs: number,
    private readonly shutdownTimeoutMs: number,
    private readonly clock: Clock,
    private readonly store: OutboxStore,
    private readonly effects: EffectLedger,
    parentSignal?: AbortSignal,
  ) {
    this.current = lease;
    this.signal = this.abortController.signal;
    if (parentSignal) {
      if (parentSignal.aborted) this.abort(parentSignal.reason);
      else
        parentSignal.addEventListener("abort", () => this.abort(parentSignal.reason), {
          once: true,
        });
    }
  }

  start(): void {
    if (this.stopped) return;
    this.timer = setInterval(() => void this.queueRenewal(), this.heartbeatMs);
    this.timer.unref?.();
  }

  attachEffect(claim: EffectClaim): void {
    this.effectClaim = claim;
  }

  private effectClaim: EffectClaim | undefined;

  async assertOwned(): Promise<LeaseToken> {
    if (this.failure) throw this.failure;
    if (this.signal.aborted) throw new StaleLeaseError(this.current.jobId);
    await this.ensureRenewal();
    if (this.failure) throw this.failure;
    return this.current;
  }

  lease(): LeaseToken {
    return this.current;
  }

  abort(reason: unknown): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (!this.abortController.signal.aborted) this.abortController.abort(reason);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatInFlight) {
      await boundedWait(
        this.heartbeatInFlight,
        this.shutdownTimeoutMs,
        "worker_shutdown_timeout",
      ).catch(() => undefined);
    }
  }

  private queueRenewal(): void {
    if (this.stopped) return;
    void this.ensureRenewal().catch(() => undefined);
  }

  private ensureRenewal(): Promise<void> {
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    const renewal = this.renew()
      .catch(() => undefined)
      .finally(() => {
        if (this.heartbeatInFlight === renewal) this.heartbeatInFlight = undefined;
      });
    this.heartbeatInFlight = renewal;
    return renewal;
  }

  private async renew(): Promise<void> {
    if (this.stopped || this.failure) return;
    try {
      const targetExpiry = this.clock.now() + this.leaseMs;
      if (this.effectClaim) {
        await boundedWait(
          this.effects.heartbeat(this.effectClaim, targetExpiry),
          this.heartbeatTimeoutMs,
          "effect_heartbeat_timeout",
        );
      }
      const renewed = await boundedWait(
        this.store.heartbeat(this.current, targetExpiry),
        this.heartbeatTimeoutMs,
        "outbox_heartbeat_timeout",
      );
      if (renewed.expiresAt !== targetExpiry) throw new Error("lease_expiry_mismatch");
      this.current = renewed;
    } catch (error) {
      this.failure = error;
      this.abortController.abort(error);
      throw error;
    }
  }
}

export class OutboxConsumer {
  private acquisitionInFlight: InFlightAcquisition | undefined;

  constructor(
    private readonly options: OutboxConsumerOptions,
    private readonly clock: Clock,
    private readonly store: OutboxStore,
    private readonly ledger: EffectLedger,
    private readonly handlers: HandlerRegistry,
    private readonly retryPolicy: RetryPolicy,
    private readonly logger: StructuredLogger,
    private readonly telemetry: OpenTelemetry,
  ) {}

  async tick(signal?: AbortSignal): Promise<boolean> {
    const parentSignal = signal ?? new AbortController().signal;
    const claimed = await this.acquire(parentSignal);
    if (!claimed) return false;
    const renewed = await this.extendForProcessing(claimed, parentSignal);
    const leaseController = new LeaseController(
      renewed.lease,
      this.options.leaseMs,
      this.options.heartbeatMs ?? Math.max(10, Math.floor(this.options.leaseMs / 3)),
      this.options.heartbeatTimeoutMs ?? Math.max(10, Math.floor(this.options.leaseMs / 4)),
      this.options.shutdownTimeoutMs ?? Math.max(10, Math.floor(this.options.leaseMs / 2)),
      this.clock,
      this.store,
      this.ledger,
      signal,
    );
    leaseController.start();
    try {
      await this.telemetry.span(
        "worker.outbox.process",
        {
          "job.id": renewed.job.id,
          "job.kind": renewed.job.kind,
          "job.attempt": renewed.job.attempt,
        },
        async (span) => {
          this.logger.log("info", "outbox.job.claimed", {
            traceId: span.traceId,
            spanId: span.spanId,
            workspaceId: renewed.job.workspaceId,
            jobId: renewed.job.id,
            attributes: {
              kind: renewed.job.kind,
              generation: renewed.lease.generation,
              attempt: renewed.job.attempt,
            },
          });
          await this.process(renewed.job, leaseController);
        },
      );
    } catch (error) {
      if (!(error instanceof StaleLeaseError || error instanceof EffectOwnershipError)) throw error;
    } finally {
      await leaseController.stop();
    }
    return true;
  }

  private async acquire(parentSignal: AbortSignal): Promise<ClaimedOutboxJob | undefined> {
    const active = this.acquisitionInFlight ?? this.startAcquisition();
    const waited = await awaitRetainedOperation(
      active.promise,
      parentSignal,
      this.options.claimTimeoutMs ?? Math.max(10, Math.floor(this.options.leaseMs / 4)),
      "outbox_claim_timeout",
      (reason) => active.controller.abort(reason),
    );
    if (!waited.operationSettled) throw waited.error;
    if (this.acquisitionInFlight === active) this.acquisitionInFlight = undefined;
    if (waited.error !== undefined) throw waited.error;
    const claimed = waited.value;
    if (claimed) this.assertClaimFence(claimed);
    return claimed;
  }

  private assertClaimFence(claimed: ClaimedOutboxJob): void {
    if (
      claimed.job.id !== claimed.lease.jobId ||
      claimed.job.state !== "leased" ||
      claimed.job.leaseOwner !== claimed.lease.owner ||
      claimed.job.leaseWorkerSlotId !== claimed.lease.workerSlotId ||
      claimed.job.leaseGeneration !== claimed.lease.generation ||
      claimed.job.leaseExpiresAt !== claimed.lease.expiresAt ||
      claimed.lease.workerSlotId !== this.options.workerId
    ) {
      throw new StaleLeaseError(claimed.lease.jobId);
    }
  }

  private startAcquisition(): InFlightAcquisition {
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      const recovered = await this.store.recoverOwned(
        this.options.workerId,
        this.options.leaseMs,
        controller.signal,
      );
      if (recovered) return recovered;
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("aborted");
      }
      return this.store.claim(this.options.workerId, this.options.leaseMs, controller.signal);
    });
    const active = { controller, promise };
    this.acquisitionInFlight = active;
    return active;
  }

  private async extendForProcessing(
    claimed: ClaimedOutboxJob,
    parentSignal: AbortSignal,
  ): Promise<ClaimedOutboxJob> {
    const now = this.clock.now();
    const minimumHeadroom =
      this.options.heartbeatMs ?? Math.max(10, Math.floor(this.options.leaseMs / 3));
    if (claimed.lease.expiresAt <= now) throw new StaleLeaseError(claimed.lease.jobId);
    if (claimed.lease.expiresAt - now >= minimumHeadroom) return claimed;

    const targetExpiry = now + this.options.leaseMs;
    const lease = await runWithDeadline(
      parentSignal,
      this.options.heartbeatTimeoutMs ?? Math.max(10, Math.floor(this.options.leaseMs / 4)),
      () => this.store.heartbeat(claimed.lease, targetExpiry),
      "outbox_claim_heartbeat_timeout",
    );
    if (
      lease.jobId !== claimed.lease.jobId ||
      lease.owner !== claimed.lease.owner ||
      lease.workerSlotId !== claimed.lease.workerSlotId ||
      lease.generation !== claimed.lease.generation ||
      lease.expiresAt !== targetExpiry
    ) {
      throw new StaleLeaseError(claimed.lease.jobId);
    }
    return {
      job: { ...claimed.job, leaseExpiresAt: lease.expiresAt },
      lease,
    };
  }

  private async process(job: OutboxJob, controller: LeaseController): Promise<void> {
    if (!SAFE_IDENTIFIER.test(job.id) || !/^effect:[a-f0-9]{64}$/.test(job.effectKey)) {
      await this.deadLetterOwned(controller, "effect_identity_invalid");
      return;
    }
    let identity: DerivedEffectIdentity;
    try {
      identity = deriveEffectIdentity(job);
    } catch {
      await this.deadLetterOwned(controller, "effect_identity_invalid");
      return;
    }
    if (job.effectKey !== identity.effectKey) {
      await this.deadLetterOwned(controller, "effect_identity_invalid");
      return;
    }

    const handler = this.handlers.get(job.kind);
    let acquisition: EffectAcquireResult;
    try {
      acquisition = await this.ledger.acquire({
        effectKey: identity.effectKey,
        identityFingerprint: identity.identityFingerprint,
        payloadFingerprint: identity.payloadFingerprint,
        ownerId: job.id,
        ownerGeneration: controller.lease().generation,
        leaseExpiresAt: controller.lease().expiresAt,
        allowTakeover: true,
      });
    } catch (error) {
      if (error instanceof EffectIdentityConflictError) {
        await this.deadLetterOwned(controller, "effect_identity_conflict");
        return;
      }
      throw error;
    }
    if (!acquisition.acquired) {
      if (acquisition.record.state === "succeeded") {
        await this.completeOwned(controller, acquisition.record.result);
        return;
      }
      if (acquisition.record.state === "failed_permanent") {
        await this.deadLetterOwned(controller, "effect_failed_permanent");
        return;
      }
      await this.retryOwned(job, controller, "effect_in_progress");
      return;
    }
    controller.attachEffect(acquisition.claim);

    if (
      acquisition.previousState === "started" ||
      acquisition.previousState === "outcome_unknown"
    ) {
      let reconciliation: ReconciliationResult;
      try {
        reconciliation = await runWithDeadline(
          controller.signal,
          this.options.handlerTimeoutMs ?? 60_000,
          (signal) => handler.reconcile(identity.effectKey, job, signal),
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        await this.ledger.outcomeUnknown(acquisition.claim);
        await this.deferUnknown(job, controller, errorCode(error));
        return;
      }
      await controller.assertOwned();
      if (reconciliation.type === "succeeded") {
        await this.ledger.succeeded(
          acquisition.claim,
          reconciliation.providerReference,
          reconciliation.result,
        );
        await this.completeOwned(controller, reconciliation.result);
        return;
      }
      if (
        reconciliation.type === "unknown" ||
        acquisition.previousState === "outcome_unknown" ||
        !handler.retryWhenReconciledNotFound
      ) {
        await this.ledger.outcomeUnknown(acquisition.claim);
        await this.deferUnknown(job, controller, "reconciliation_inconclusive");
        return;
      }
    }

    let result: EffectResult;
    try {
      result = await runWithDeadline(
        controller.signal,
        this.options.handlerTimeoutMs ?? 60_000,
        (signal) => handler.execute(job, identity.effectKey, signal),
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = errorCode(error);
      result =
        code === "handler_timeout"
          ? { type: "outcome_unknown", code }
          : { type: "transient_failure", code };
    }
    await controller.assertOwned();
    await this.applyResult(job, controller, acquisition.claim, result);
  }

  private async applyResult(
    job: OutboxJob,
    controller: LeaseController,
    effectClaim: EffectClaim,
    result: EffectResult,
  ): Promise<void> {
    switch (result.type) {
      case "succeeded":
        await this.ledger.succeeded(effectClaim, result.providerReference, result.result);
        await this.completeOwned(controller, result.result);
        return;
      case "permanent_failure":
        await this.ledger.failedPermanent(effectClaim);
        await this.deadLetterOwned(controller, result.code);
        return;
      case "outcome_unknown":
        await this.ledger.outcomeUnknown(effectClaim);
        await this.deferUnknown(job, controller, result.code);
        return;
      case "transient_failure":
        if (this.retryPolicy.exhausted(job, this.clock.now())) {
          await this.deadLetterOwned(controller, `retry_exhausted:${result.code}`);
          return;
        }
        await this.store.retry(
          await controller.assertOwned(),
          this.clock.now() + this.retryPolicy.delayMs(job.attempt, result.retryAfterMs),
          result.code,
        );
    }
  }

  private async completeOwned(controller: LeaseController, result?: JsonValue): Promise<void> {
    await this.store.complete(await controller.assertOwned(), result);
  }

  private async deadLetterOwned(controller: LeaseController, code: string): Promise<void> {
    await this.store.deadLetter(await controller.assertOwned(), code);
  }

  private async retryOwned(
    job: OutboxJob,
    controller: LeaseController,
    code: string,
  ): Promise<void> {
    if (this.retryPolicy.exhausted(job, this.clock.now())) {
      await this.deadLetterOwned(controller, `retry_exhausted:${code}`);
      return;
    }
    await this.store.retry(
      await controller.assertOwned(),
      this.clock.now() + this.retryPolicy.delayMs(job.attempt),
      code,
    );
  }

  private async deferUnknown(
    job: OutboxJob,
    controller: LeaseController,
    code: string,
  ): Promise<void> {
    if (this.retryPolicy.exhausted(job, this.clock.now())) {
      await this.deadLetterOwned(controller, `unknown_outcome_exhausted:${code}`);
      return;
    }
    await this.store.outcomeUnknown(
      await controller.assertOwned(),
      this.clock.now() + this.retryPolicy.delayMs(job.attempt),
      code,
    );
  }
}

export const newJob = (
  values: Pick<OutboxJob, "id" | "workspaceId" | "kind" | "payload"> & {
    readonly effectKey?: string;
  },
  now: number,
): OutboxJob => {
  if (!SAFE_IDENTIFIER.test(values.id)) throw new Error("invalid_job_id");
  const identity = deriveEffectIdentity(values);
  return {
    ...values,
    effectKey: identity.effectKey,
    createdAt: now,
    nextAttemptAt: now,
    attempt: 0,
    state: "pending",
    leaseGeneration: 0,
  };
};
