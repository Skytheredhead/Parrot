export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  constructor(private value: number = 0) {}

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

export type JobKind =
  | "notification.deliver"
  | "search.upsert"
  | "search.tombstone"
  | "search.rebuild"
  | "file.scan"
  | "file.extract"
  | "file.cleanup"
  | "agent.run";

export type JobState = "pending" | "leased" | "outcome_unknown" | "succeeded" | "dead_letter";

export interface OutboxJob<TPayload extends JsonValue = JsonValue> {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: JobKind;
  readonly effectKey: string;
  readonly payload: TPayload;
  readonly createdAt: number;
  readonly nextAttemptAt: number;
  readonly attempt: number;
  readonly state: JobState;
  /** Authenticated adapter/service identity that owns the authority lease. */
  readonly leaseOwner?: string;
  /** Stable logical worker slot, independently fenced within the adapter identity. */
  readonly leaseWorkerSlotId?: string;
  readonly leaseExpiresAt?: number;
  readonly leaseGeneration: number;
  readonly lastErrorCode?: string;
  readonly deadLetterReason?: string;
}

export interface LeaseToken {
  readonly jobId: string;
  /** Authenticated adapter/service identity. */
  readonly owner: string;
  /** Stable logical worker slot supplied by WORKER_ID. */
  readonly workerSlotId: string;
  readonly generation: number;
  readonly expiresAt: number;
}

export type EffectState = "started" | "succeeded" | "outcome_unknown" | "failed_permanent";

export interface EffectRecord {
  readonly effectKey: string;
  readonly identityFingerprint: string;
  readonly payloadFingerprint: string;
  readonly state: EffectState;
  readonly ownerId: string;
  readonly ownerGeneration: number;
  readonly leaseExpiresAt: number;
  readonly providerReference?: string;
  readonly result?: JsonValue;
  readonly updatedAt: number;
}

export interface EffectClaim {
  readonly effectKey: string;
  readonly identityFingerprint: string;
  readonly ownerId: string;
  readonly ownerGeneration: number;
}

export type EffectResult =
  | { readonly type: "succeeded"; readonly providerReference?: string; readonly result?: JsonValue }
  | { readonly type: "transient_failure"; readonly code: string; readonly retryAfterMs?: number }
  | { readonly type: "permanent_failure"; readonly code: string }
  | { readonly type: "outcome_unknown"; readonly code: string };

export type ReconciliationResult =
  | { readonly type: "succeeded"; readonly providerReference?: string; readonly result?: JsonValue }
  | { readonly type: "not_found" }
  | { readonly type: "unknown" };

export class StaleLeaseError extends Error {
  constructor(jobId: string) {
    super(`Lease is stale for job ${jobId}`);
    this.name = "StaleLeaseError";
  }
}

export class ProviderTimeoutError extends Error {
  constructor(message = "Provider request timed out") {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

export const errorCode = (error: unknown): string => {
  if (error instanceof ProviderTimeoutError) return "provider_timeout";
  if (error instanceof Error && /^[a-z0-9_.-]{1,80}$/i.test(error.name))
    return error.name.toLowerCase();
  return "unexpected_error";
};
