import { createHash } from "node:crypto";
import type {
  NotificationChannel,
  NotificationProvider,
  NotificationProviderResult,
  NotificationReconciliationResult,
} from "./adapters.js";
import type { RuntimeAdapter } from "./outbox.js";

const MAX_DIGEST_CLAIMS = 32;
const MAX_DIGEST_ITEMS = 50;
const MAX_DIGEST_BODY_CHARACTERS = 2_000;
const MAX_DIGEST_BODY_BYTES = 4_000;
const MAX_SCAN_MINUTES = 4_320;
const DIGEST_SUPPRESSION_CODES = new Set([
  "no_content",
  "recipient_opted_out",
  "channel_disabled",
  "recipient_suspended",
  "workspace_fenced",
  "permission_revoked",
  "policy_suppressed",
  "preference_revision_stale",
  "digest_revision_stale",
]);

interface LocalDateTime {
  readonly date: string;
  readonly minute: number;
}

const localDateTime = (timestampMs: number, timeZone: string): LocalDateTime => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestampMs);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part || !/^\d+$/.test(part)) throw new RangeError("digest_timezone_invalid");
    return Number(part);
  };
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return {
    date: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
    minute: value("hour") * 60 + value("minute"),
  };
};

const validLocalDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
};

const nextLocalDate = (value: string): string => {
  if (!validLocalDate(value)) throw new RangeError("digest_local_date_invalid");
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError("digest_local_date_invalid");
  }
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

export interface DailyDigestOccurrenceInput {
  readonly after: Date;
  readonly timeZone: string;
  readonly localMinute: number;
  /** Persist this after a claim so a repeated wall-clock hour cannot dispatch twice. */
  readonly lastOccurrenceLocalDate?: string;
}

export interface DailyDigestOccurrence {
  readonly scheduledFor: Date;
  readonly localDate: string;
  /** True when a DST jump made the requested wall-clock minute nonexistent. */
  readonly shiftedByDst: boolean;
}

/**
 * Selects one daily wall-clock occurrence. An overlap uses its first instant; a gap uses the first
 * representable minute after the requested time. The local date is the durable occurrence cursor.
 */
export const nextDailyDigestOccurrence = (
  input: DailyDigestOccurrenceInput,
): DailyDigestOccurrence => {
  const afterMs = input.after.getTime();
  if (!Number.isFinite(afterMs)) throw new RangeError("digest_after_invalid");
  if (!Number.isInteger(input.localMinute) || input.localMinute < 0 || input.localMinute >= 1_440) {
    throw new RangeError("digest_local_minute_invalid");
  }
  if (input.lastOccurrenceLocalDate && !validLocalDate(input.lastOccurrenceLocalDate)) {
    throw new RangeError("digest_local_date_invalid");
  }
  let current: LocalDateTime;
  try {
    current = localDateTime(afterMs, input.timeZone);
  } catch {
    throw new RangeError("digest_timezone_invalid");
  }
  const targetDate =
    input.lastOccurrenceLocalDate && input.lastOccurrenceLocalDate >= current.date
      ? nextLocalDate(input.lastOccurrenceLocalDate)
      : current.minute < input.localMinute
        ? current.date
        : nextLocalDate(current.date);
  const firstMinute = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset < MAX_SCAN_MINUTES; offset += 1) {
    const timestampMs = firstMinute + offset * 60_000;
    const local = localDateTime(timestampMs, input.timeZone);
    if (local.date === targetDate && local.minute >= input.localMinute) {
      return {
        scheduledFor: new Date(timestampMs),
        localDate: targetDate,
        shiftedByDst: local.minute !== input.localMinute,
      };
    }
    if (local.date > targetDate) break;
  }
  throw new RangeError("digest_occurrence_unresolvable");
};

export interface DigestClaim {
  readonly claimId: string;
  readonly workspaceId: string;
  readonly recipientId: string;
  readonly channel: NotificationChannel;
  readonly scheduleId: string;
  readonly localDate: string;
  readonly scheduledForMs: number;
  readonly preferenceRevision: number;
  readonly digestRevision: number;
  readonly authorizationEpoch: number;
  readonly workerSlotId: string;
  readonly leaseGeneration: number;
  readonly reconcileFirst: boolean;
}

interface DigestPlanBase extends DigestClaim {
  readonly deliveryKey: string;
}

export type DigestDeliveryPlan =
  | (DigestPlanBase & {
      readonly decision: "deliver";
      readonly body: string;
      readonly itemCount: number;
    })
  | (DigestPlanBase & {
      readonly decision: "suppress";
      readonly suppressionCode:
        | "no_content"
        | "recipient_opted_out"
        | "channel_disabled"
        | "recipient_suspended"
        | "workspace_fenced"
        | "permission_revoked"
        | "policy_suppressed"
        | "preference_revision_stale"
        | "digest_revision_stale";
    });

export type DigestSuppressionCode = Extract<
  DigestDeliveryPlan,
  { readonly decision: "suppress" }
>["suppressionCode"];

export type DigestRecordedOutcome =
  | NotificationProviderResult
  | NotificationReconciliationResult
  | { readonly type: "suppressed"; readonly code: DigestSuppressionCode };

/** Durable implementations own occurrence cursors, leases, content selection, and live revisions. */
export interface DigestDeliveryAuthority extends RuntimeAdapter {
  claimDue(
    input: {
      readonly nowMs: number;
      readonly workerSlotId: string;
      readonly maxClaims: number;
      readonly leaseMs: number;
    },
    signal: AbortSignal,
  ): Promise<readonly DigestClaim[]>;
  resolvePlan(claim: DigestClaim, signal: AbortSignal): Promise<DigestDeliveryPlan>;
  /** Atomically rechecks preference, digest, authorization, suppression, and lease revisions. */
  dispatchCurrentPlan<T>(
    plan: DigestDeliveryPlan & { readonly decision: "deliver" },
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }>;
  recordOutcome(
    claim: DigestClaim,
    outcome: DigestRecordedOutcome,
    signal: AbortSignal,
  ): Promise<boolean>;
}

export const digestDeliveryKey = (
  claim: Pick<DigestClaim, "workspaceId" | "recipientId" | "channel" | "scheduleId" | "localDate">,
): string => {
  if (!validLocalDate(claim.localDate)) throw new RangeError("digest_local_date_invalid");
  return `digest:${createHash("sha256")
    .update(
      [claim.workspaceId, claim.recipientId, claim.channel, claim.scheduleId, claim.localDate].join(
        "\0",
      ),
    )
    .digest("hex")}`;
};

const boundedText = (body: string): boolean => {
  const normalized = body.normalize("NFC").trim();
  return (
    normalized === body &&
    [...body].length > 0 &&
    [...body].length <= MAX_DIGEST_BODY_CHARACTERS &&
    Buffer.byteLength(body, "utf8") <= MAX_DIGEST_BODY_BYTES &&
    ![...body].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
    })
  );
};

const providerReferenceValid = (value: string): boolean => /^[A-Za-z0-9._:-]{1,256}$/.test(value);

const providerResultValid = (result: NotificationProviderResult): boolean => {
  switch (result.type) {
    case "succeeded":
      return providerReferenceValid(result.providerReference);
    case "transient_failure":
      return (
        ["rate_limited", "provider_unavailable", "network_error"].includes(result.code) &&
        (result.retryAfterMs === undefined ||
          (Number.isSafeInteger(result.retryAfterMs) &&
            result.retryAfterMs >= 0 &&
            result.retryAfterMs <= 86_400_000))
      );
    case "permanent_failure":
      return [
        "invalid_recipient",
        "recipient_unreachable",
        "provider_rejected",
        "channel_unavailable",
      ].includes(result.code);
    case "outcome_unknown":
      return ["provider_timeout", "connection_lost_after_send"].includes(result.code);
    default:
      return false;
  }
};

const reconciliationValid = (result: NotificationReconciliationResult): boolean =>
  result.type === "not_found" ||
  result.type === "unknown" ||
  (result.type === "succeeded" && providerReferenceValid(result.providerReference));

const claimValid = (claim: DigestClaim, workerSlotId: string): boolean =>
  claim.workerSlotId === workerSlotId &&
  (claim.channel === "email" || claim.channel === "push") &&
  /^[A-Za-z0-9._:@-]{1,256}$/.test(claim.workspaceId) &&
  /^[A-Za-z0-9._:@-]{1,256}$/.test(claim.recipientId) &&
  /^[A-Za-z0-9._:-]{1,128}$/.test(claim.claimId) &&
  /^[A-Za-z0-9._:-]{1,128}$/.test(claim.scheduleId) &&
  validLocalDate(claim.localDate) &&
  Number.isSafeInteger(claim.scheduledForMs) &&
  claim.scheduledForMs >= 0 &&
  Number.isSafeInteger(claim.preferenceRevision) &&
  claim.preferenceRevision >= 0 &&
  Number.isSafeInteger(claim.digestRevision) &&
  claim.digestRevision >= 0 &&
  Number.isSafeInteger(claim.authorizationEpoch) &&
  claim.authorizationEpoch >= 0 &&
  Number.isSafeInteger(claim.leaseGeneration) &&
  claim.leaseGeneration > 0;

const planMatches = (plan: DigestDeliveryPlan, claim: DigestClaim): boolean => {
  const decisionValid =
    plan.decision === "suppress"
      ? DIGEST_SUPPRESSION_CODES.has(plan.suppressionCode)
      : Number.isSafeInteger(plan.itemCount) &&
        plan.itemCount > 0 &&
        plan.itemCount <= MAX_DIGEST_ITEMS &&
        boundedText(plan.body);
  return (
    plan.claimId === claim.claimId &&
    plan.workspaceId === claim.workspaceId &&
    plan.recipientId === claim.recipientId &&
    plan.channel === claim.channel &&
    plan.scheduleId === claim.scheduleId &&
    plan.localDate === claim.localDate &&
    plan.scheduledForMs === claim.scheduledForMs &&
    plan.preferenceRevision === claim.preferenceRevision &&
    plan.digestRevision === claim.digestRevision &&
    plan.authorizationEpoch === claim.authorizationEpoch &&
    plan.workerSlotId === claim.workerSlotId &&
    plan.leaseGeneration === claim.leaseGeneration &&
    plan.reconcileFirst === claim.reconcileFirst &&
    plan.deliveryKey === digestDeliveryKey(claim) &&
    decisionValid
  );
};

export interface DigestSchedulerResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly suppressed: number;
  readonly deferred: number;
  readonly invalid: number;
}

export class DigestScheduler {
  constructor(
    private readonly authority: DigestDeliveryAuthority,
    private readonly provider: NotificationProvider,
    private readonly workerSlotId: string,
    private readonly leaseMs = 30_000,
  ) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerSlotId)) {
      throw new RangeError("digest_worker_slot_invalid");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new RangeError("digest_lease_invalid");
    }
  }

  async runOnce(
    now: Date,
    signal: AbortSignal,
    requestedMaxClaims = MAX_DIGEST_CLAIMS,
  ): Promise<DigestSchedulerResult> {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new RangeError("digest_now_invalid");
    if (!Number.isSafeInteger(requestedMaxClaims) || requestedMaxClaims < 1) {
      throw new RangeError("digest_claim_limit_invalid");
    }
    const maxClaims = Math.min(MAX_DIGEST_CLAIMS, requestedMaxClaims);
    const claims = await this.authority.claimDue(
      { nowMs, workerSlotId: this.workerSlotId, maxClaims, leaseMs: this.leaseMs },
      signal,
    );
    if (claims.length > maxClaims) throw new Error("digest_claim_bound_exceeded");
    const result = { claimed: claims.length, delivered: 0, suppressed: 0, deferred: 0, invalid: 0 };
    for (const claim of claims) {
      if (signal.aborted) throw signal.reason;
      if (!claimValid(claim, this.workerSlotId) || claim.scheduledForMs > nowMs) {
        result.invalid += 1;
        continue;
      }
      let plan: DigestDeliveryPlan;
      try {
        plan = await this.authority.resolvePlan(claim, signal);
      } catch {
        if (signal.aborted) throw signal.reason;
        result.deferred += 1;
        continue;
      }
      if (!planMatches(plan, claim)) {
        result.invalid += 1;
        continue;
      }
      if (plan.decision === "suppress") {
        const accepted = await this.authority.recordOutcome(
          claim,
          { type: "suppressed", code: plan.suppressionCode },
          signal,
        );
        if (accepted) result.suppressed += 1;
        else result.deferred += 1;
        continue;
      }
      if (claim.reconcileFirst) {
        const reconciled = await this.provider.reconcile(plan.deliveryKey, signal);
        if (!reconciliationValid(reconciled)) {
          result.invalid += 1;
          continue;
        }
        if (reconciled.type !== "not_found") {
          const accepted = await this.authority.recordOutcome(claim, reconciled, signal);
          if (accepted && reconciled.type === "succeeded") result.delivered += 1;
          else result.deferred += 1;
          continue;
        }
      }
      let dispatched:
        | { readonly current: true; readonly value: NotificationProviderResult }
        | {
            readonly current: false;
          };
      try {
        dispatched = await this.authority.dispatchCurrentPlan(plan, () =>
          this.provider.send(
            {
              intentId: plan.scheduleId,
              recipientId: plan.recipientId,
              channel: plan.channel,
              resourceId: plan.scheduleId,
              authorizationEpoch: plan.authorizationEpoch,
              deliveryRevision: plan.digestRevision,
              preferenceRevision: plan.preferenceRevision,
              content: { format: "plain_text", body: plan.body },
              deliveryKey: plan.deliveryKey,
              coalescingKey: plan.deliveryKey,
            },
            plan.deliveryKey,
            signal,
          ),
        );
      } catch {
        if (signal.aborted) throw signal.reason;
        result.deferred += 1;
        continue;
      }
      if (!dispatched.current) {
        result.deferred += 1;
        continue;
      }
      if (!providerResultValid(dispatched.value)) {
        result.invalid += 1;
        continue;
      }
      const accepted = await this.authority.recordOutcome(claim, dispatched.value, signal);
      if (accepted && dispatched.value.type === "succeeded") result.delivered += 1;
      else result.deferred += 1;
    }
    return result;
  }
}
