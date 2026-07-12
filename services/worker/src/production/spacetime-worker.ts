import { createHash } from "node:crypto";
import type {
  AuthorizationGate,
  FileAuthority,
  FileDeletionClaim,
  FileProcessingPlan,
  NotificationDeliveryAuthority,
  NotificationDeliveryPlan,
  NotificationPlanInput,
} from "../adapters.js";
import type {
  AgentCheckpoint,
  AgentContextSource,
  AgentRunControl,
  AgentRunProgress,
  AgentRunRepository,
  AgentRunState,
  ApprovalRecord,
  ApprovalStore,
  ContextManifestEntry,
  ProviderDispatchFence,
} from "../agent.js";
import type {
  DigestClaim,
  DigestDeliveryAuthority,
  DigestDeliveryPlan,
  DigestRecordedOutcome,
} from "../digest.js";
import { digestDeliveryKey, nextDailyDigestOccurrence } from "../digest.js";
import type {
  JsonValue,
  LeaseToken,
  OutboxJob,
  WorkspaceExportCleanupCompletion,
  WorkspaceExportCompletion,
} from "../domain.js";
import type {
  EffectAcquireInput,
  EffectAcquireResult,
  EffectLedger,
  OutboxStore,
} from "../outbox.js";
import {
  decodeSpacetimeOutboxJob,
  type SpacetimeOutboxEnvelope,
  type SpacetimeSearchWorkItem,
  type SpacetimeWorkspaceExportCleanupPlan,
  type SpacetimeWorkspaceExportPlan,
} from "../spacetime-outbox.js";
import type {
  WorkspaceExportAuthority,
  WorkspaceExportCleanupPlan,
  WorkspaceExportCleanupPlanInput,
  WorkspaceExportPlan,
  WorkspaceExportPlanInput,
} from "../workspace-export.js";

const MAX_LEASE_SECONDS = 300;
const MAX_QUERY_ROWS = 64;
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,256}$/;

export type SpacetimeWorkerView =
  | "pending_outbox_work"
  | "pending_post_search_documents"
  | "pending_workspace_export_plans"
  | "pending_workspace_export_cleanup_plans"
  | "pending_notification_delivery_plans"
  | "pending_notification_digest_schedules"
  | "pending_notification_digest_plans"
  | "file_processing_plans"
  | "agent_work_queue"
  | "agent_context_candidates"
  | "service_agent_execution_plans"
  | "service_agent_run_progress"
  | "service_agent_provider_dispatches"
  | "service_worker_effects"
  | "service_agent_approval_bindings"
  | "service_file_deletion_claims"
  | "service_file_processing_outcomes";

export type SpacetimeWorkerReducer =
  | "claim_outbox_job"
  | "recover_outbox_job"
  | "heartbeat_outbox_job"
  | "complete_outbox_job"
  | "complete_workspace_export"
  | "complete_workspace_export_cleanup"
  | "authorize_notification_delivery"
  | "claim_notification_digests"
  | "authorize_notification_digest"
  | "record_notification_digest_outcome"
  | "service_claim_agent_execution"
  | "service_transition_agent_run"
  | "service_save_agent_progress"
  | "service_append_agent_checkpoint"
  | "service_record_agent_provider_dispatch"
  | "service_commit_agent_final"
  | "heartbeat_agent_run"
  | "record_agent_context_post"
  | "record_agent_context_contribution"
  | "service_prepare_agent_tool_call"
  | "consume_agent_tool_approval"
  | "service_acquire_worker_effect"
  | "service_update_worker_effect"
  | "register_clean_file_object"
  | "record_file_scan_outcome"
  | "record_file_extraction"
  | "service_claim_file_deletion"
  | "service_finalize_file_deletion"
  | "service_release_file_deletion"
  | "service_record_file_orphan";

export interface SpacetimeWorkerQuery {
  readonly where: Readonly<Record<string, string | number | bigint | boolean>>;
  readonly limit: number;
  readonly orderBy?: readonly string[];
}

/**
 * Authenticated, transaction-aware binding boundary. `reduce` must resolve only after the reducer
 * transaction is visible to subsequent `select` calls on this same connection.
 */
export interface AuthenticatedSpacetimeWorkerTransport {
  readonly authentication: "workos_m2m_bearer";
  readonly serviceIdentity: string;
  readonly bearerSubject: string;
  readonly connected: boolean;
  readonly views: ReadonlySet<string>;
  readonly reducers: ReadonlySet<string>;
  select(
    view: SpacetimeWorkerView,
    query: SpacetimeWorkerQuery,
    signal?: AbortSignal,
  ): Promise<readonly unknown[]>;
  reduce(
    reducer: SpacetimeWorkerReducer,
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void>;
  ready(signal: AbortSignal): Promise<boolean>;
  close(signal: AbortSignal): Promise<void>;
}

export class SpacetimeSchemaGapError extends Error {
  constructor(readonly operation: string) {
    super(`spacetime_schema_operation_missing:${operation}`);
    this.name = "SpacetimeSchemaGapError";
  }
}

export interface SpacetimeWorkerAuthorityOptions {
  readonly expectedServiceIdentity: string;
  readonly expectedBearerSubject: string;
  readonly now?: () => number;
}

const id = (value: unknown, field: string): string => {
  const toHexString =
    typeof value === "object" && value !== null
      ? (value as { readonly toHexString?: unknown }).toHexString
      : undefined;
  const normalized =
    typeof toHexString === "function" ? String(toHexString.call(value)) : String(value ?? "");
  if (!SAFE_ID.test(normalized)) throw new Error(`spacetime_invalid_${field}`);
  return normalized;
};

const integer = (value: unknown, field: string, minimum = 0): number => {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < minimum) {
    throw new Error(`spacetime_invalid_${field}`);
  }
  return normalized as number;
};

const timestamp = (value: unknown, field: string): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "object" && value !== null) {
    const micros = (value as { readonly microsSinceUnixEpoch?: unknown }).microsSinceUnixEpoch;
    if (typeof micros === "bigint") return integer(micros / 1_000n, field);
  }
  throw new Error(`spacetime_invalid_${field}`);
};

const tag = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const explicit = (value as { readonly tag?: unknown }).tag;
    if (typeof explicit === "string") return explicit;
    const keys = Object.keys(value);
    if (keys.length === 1) return keys[0] ?? "";
  }
  return "";
};

const enumValue = (name: string): Readonly<{ tag: string }> => Object.freeze({ tag: name });

const seconds = (milliseconds: number, field: string): number => {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`spacetime_invalid_${field}`);
  }
  const value = Math.ceil(milliseconds / 1_000);
  if (value < 1 || value > MAX_LEASE_SECONDS) throw new Error(`spacetime_invalid_${field}`);
  return value;
};

const retrySeconds = (milliseconds: number): number => {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 86_400_000) {
    throw new Error("spacetime_invalid_retry_delay");
  }
  return Math.ceil(milliseconds / 1_000);
};

const exactOne = <T>(rows: readonly unknown[], operation: string): T | undefined => {
  if (rows.length > 1) throw new Error(`spacetime_non_unique_${operation}`);
  return rows[0] as T | undefined;
};

const leaseOf = (job: OutboxJob): LeaseToken => {
  if (
    job.state !== "leased" ||
    !job.leaseOwner ||
    !job.leaseWorkerSlotId ||
    job.leaseExpiresAt === undefined ||
    job.leaseGeneration < 1
  ) {
    throw new Error("spacetime_invalid_authority_lease");
  }
  return {
    jobId: job.id,
    owner: job.leaseOwner,
    workerSlotId: job.leaseWorkerSlotId,
    generation: job.leaseGeneration,
    expiresAt: job.leaseExpiresAt,
  };
};

const sameLease = (left: LeaseToken, right: LeaseToken): boolean =>
  left.jobId === right.jobId &&
  left.owner === right.owner &&
  left.workerSlotId === right.workerSlotId &&
  left.generation === right.generation;

const notificationDecision = (value: unknown): "deliver" | "suppress" => {
  const normalized = tag(value).toLowerCase();
  if (["ready", "permitted", "deliver"].includes(normalized)) return "deliver";
  if (["suppressed", "suppress"].includes(normalized)) return "suppress";
  throw new Error("spacetime_notification_plan_not_resolved");
};

const digestOutcome = (
  outcome: DigestRecordedOutcome,
  reconciled: boolean,
): {
  outcome: Readonly<{ tag: string }>;
  reconciled: boolean;
  providerReference: string;
  code: string;
  retryAfterSeconds: number;
} => {
  switch (outcome.type) {
    case "succeeded":
      return {
        outcome: enumValue("Succeeded"),
        reconciled,
        providerReference: outcome.providerReference,
        code: "",
        retryAfterSeconds: 0,
      };
    case "suppressed":
      return {
        outcome: enumValue("Suppressed"),
        reconciled: false,
        providerReference: "",
        code: outcome.code,
        retryAfterSeconds: 0,
      };
    case "transient_failure":
      return {
        outcome: enumValue("TransientFailure"),
        reconciled: false,
        providerReference: "",
        code: outcome.code,
        retryAfterSeconds: retrySeconds(outcome.retryAfterMs ?? 1_000),
      };
    case "permanent_failure":
      return {
        outcome: enumValue("PermanentFailure"),
        reconciled: false,
        providerReference: "",
        code: outcome.code,
        retryAfterSeconds: 0,
      };
    case "outcome_unknown":
      return {
        outcome: enumValue("OutcomeUnknown"),
        reconciled: false,
        providerReference: "",
        code: outcome.code,
        retryAfterSeconds: 1,
      };
    case "not_found":
      throw new SpacetimeSchemaGapError("digest.record_reconciled_not_found");
    case "unknown":
      return {
        outcome: enumValue("ReconciliationUnknown"),
        reconciled: true,
        providerReference: "",
        code: "unknown",
        retryAfterSeconds: 1,
      };
  }
};

const requiredViews: readonly SpacetimeWorkerView[] = [
  "pending_outbox_work",
  "pending_post_search_documents",
  "pending_workspace_export_plans",
  "pending_workspace_export_cleanup_plans",
  "pending_notification_delivery_plans",
  "pending_notification_digest_schedules",
  "pending_notification_digest_plans",
];

const requiredReducers: readonly SpacetimeWorkerReducer[] = [
  "claim_outbox_job",
  "recover_outbox_job",
  "heartbeat_outbox_job",
  "complete_outbox_job",
  "complete_workspace_export",
  "complete_workspace_export_cleanup",
  "authorize_notification_delivery",
  "claim_notification_digests",
  "authorize_notification_digest",
  "record_notification_digest_outcome",
];

/** Durable implementation for the authority surfaces supported by the current Rust module. */
export class SpacetimeWorkerAuthority
  implements
    OutboxStore,
    NotificationDeliveryAuthority,
    DigestDeliveryAuthority,
    WorkspaceExportAuthority
{
  readonly adapterKind = "durable" as const;
  readonly adapterName = "spacetime-worker-authority";
  readonly #now: () => number;

  constructor(
    private readonly transport: AuthenticatedSpacetimeWorkerTransport,
    options: SpacetimeWorkerAuthorityOptions,
  ) {
    if (!SAFE_ID.test(options.expectedServiceIdentity)) {
      throw new Error("spacetime_expected_service_identity_invalid");
    }
    if (!SAFE_ID.test(options.expectedBearerSubject)) {
      throw new Error("spacetime_expected_bearer_subject_invalid");
    }
    if (
      transport.authentication !== "workos_m2m_bearer" ||
      transport.serviceIdentity !== options.expectedServiceIdentity ||
      transport.bearerSubject !== options.expectedBearerSubject
    ) {
      throw new Error("spacetime_workos_service_identity_mismatch");
    }
    this.#now = options.now ?? Date.now;
  }

  assertProductionReady(): boolean {
    return (
      this.transport.connected &&
      requiredViews.every((view) => this.transport.views.has(view)) &&
      requiredReducers.every((reducer) => this.transport.reducers.has(reducer))
    );
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted && this.assertProductionReady() && this.transport.ready(signal);
  }

  async close(signal: AbortSignal): Promise<void> {
    await this.transport.close(signal);
  }

  async enqueue(_job: OutboxJob): Promise<void> {
    throw new SpacetimeSchemaGapError("outbox.enqueue_internal_only");
  }

  async #rows(
    view: SpacetimeWorkerView,
    where: SpacetimeWorkerQuery["where"],
    limit = 1,
    signal?: AbortSignal,
  ): Promise<readonly unknown[]> {
    if (limit < 1 || limit > MAX_QUERY_ROWS) throw new Error("spacetime_query_limit_invalid");
    return this.transport.select(view, { where, limit, orderBy: ["created_at", "id"] }, signal);
  }

  async #job(jobId: string, signal?: AbortSignal): Promise<OutboxJob | undefined> {
    const row = exactOne<SpacetimeOutboxEnvelope>(
      await this.#rows("pending_outbox_work", { id: id(jobId, "job_id") }, 1, signal),
      "outbox_job",
    );
    if (!row) return undefined;
    const search = exactOne<SpacetimeSearchWorkItem>(
      await this.#rows("pending_post_search_documents", { job_id: jobId }, 1, signal),
      "search_plan",
    );
    const exportPlan = exactOne<SpacetimeWorkspaceExportPlan>(
      await this.#rows("pending_workspace_export_plans", { job_id: jobId }, 1, signal),
      "workspace_export_plan",
    );
    const cleanupPlan = exactOne<SpacetimeWorkspaceExportCleanupPlan>(
      await this.#rows("pending_workspace_export_cleanup_plans", { job_id: jobId }, 1, signal),
      "workspace_export_cleanup_plan",
    );
    return decodeSpacetimeOutboxJob(row, search, exportPlan, cleanupPlan);
  }

  async get(jobId: string): Promise<OutboxJob | undefined> {
    return this.#job(jobId);
  }

  async recoverOwned(
    workerSlotId: string,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<{ readonly job: OutboxJob; readonly lease: LeaseToken } | undefined> {
    const rows = await this.#rows(
      "pending_outbox_work",
      {
        lease_owner: this.transport.serviceIdentity,
        worker_slot_id: id(workerSlotId, "worker_slot_id"),
        state: "Leased",
      },
      MAX_QUERY_ROWS,
      signal,
    );
    const now = this.#now();
    for (const candidate of rows as readonly SpacetimeOutboxEnvelope[]) {
      if (candidate.leaseUntil == null || timestamp(candidate.leaseUntil, "lease_until") <= now) {
        continue;
      }
      const jobId = id(candidate.id, "job_id");
      await this.transport.reduce(
        "recover_outbox_job",
        {
          jobId,
          expectedGeneration: candidate.leaseGeneration,
          workerSlotId,
          leaseSeconds: seconds(leaseMs, "lease_ms"),
        },
        signal,
      );
      const job = await this.#job(jobId, signal);
      if (!job) throw new Error("spacetime_recovered_job_not_visible");
      const lease = leaseOf(job);
      if (
        lease.owner !== this.transport.serviceIdentity ||
        lease.workerSlotId !== workerSlotId ||
        lease.generation !== integer(candidate.leaseGeneration, "lease_generation") + 1
      ) {
        throw new Error("spacetime_recovery_fence_mismatch");
      }
      return { job, lease };
    }
    return undefined;
  }

  async claim(
    workerSlotId: string,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<{ readonly job: OutboxJob; readonly lease: LeaseToken } | undefined> {
    const candidate = exactOne<SpacetimeOutboxEnvelope>(
      await this.#rows("pending_outbox_work", { claimable_before_ms: this.#now() }, 1, signal),
      "claim_candidate",
    );
    if (!candidate) return undefined;
    const jobId = id(candidate.id, "job_id");
    await this.transport.reduce(
      "claim_outbox_job",
      {
        jobId,
        expectedGeneration: candidate.leaseGeneration,
        workerSlotId: id(workerSlotId, "worker_slot_id"),
        leaseSeconds: seconds(leaseMs, "lease_ms"),
      },
      signal,
    );
    const job = await this.#job(jobId, signal);
    if (!job) throw new Error("spacetime_claimed_job_not_visible");
    const lease = leaseOf(job);
    if (
      lease.owner !== this.transport.serviceIdentity ||
      lease.workerSlotId !== workerSlotId ||
      lease.generation !== integer(candidate.leaseGeneration, "lease_generation") + 1
    ) {
      throw new Error("spacetime_claim_fence_mismatch");
    }
    return { job, lease };
  }

  async heartbeat(lease: LeaseToken, leaseExpiresAt: number): Promise<LeaseToken> {
    this.#assertOwner(lease);
    await this.transport.reduce("heartbeat_outbox_job", {
      jobId: lease.jobId,
      leaseGeneration: lease.generation,
      workerSlotId: lease.workerSlotId,
      leaseSeconds: seconds(leaseExpiresAt - this.#now(), "lease_extension"),
    });
    const current = await this.#job(lease.jobId);
    if (!current) throw new Error("spacetime_heartbeat_job_not_visible");
    const renewed = leaseOf(current);
    if (!sameLease(lease, renewed) || renewed.expiresAt < leaseExpiresAt) {
      throw new Error("spacetime_heartbeat_fence_mismatch");
    }
    return renewed;
  }

  #assertOwner(lease: LeaseToken): void {
    if (lease.owner !== this.transport.serviceIdentity) {
      throw new Error("spacetime_foreign_lease_owner");
    }
    id(lease.jobId, "job_id");
    id(lease.workerSlotId, "worker_slot_id");
    integer(lease.generation, "lease_generation", 1);
  }

  async #completeGeneric(
    lease: LeaseToken,
    outcome: "Succeeded" | "Retry" | "OutcomeUnknown" | "DeadLetter",
    code: string,
    delayMs: number,
  ): Promise<void> {
    this.#assertOwner(lease);
    await this.transport.reduce("complete_outbox_job", {
      jobId: lease.jobId,
      leaseGeneration: lease.generation,
      workerSlotId: lease.workerSlotId,
      outcome: enumValue(outcome),
      lastError: code,
      retryAfterSeconds: retrySeconds(delayMs),
    });
  }

  async complete(lease: LeaseToken, _result?: JsonValue): Promise<void> {
    // Effect results are durably owned by EffectLedger. The outbox authority only advances the
    // exact fenced delivery state and intentionally does not duplicate provider payloads.
    await this.#completeGeneric(lease, "Succeeded", "", 0);
  }

  async retry(lease: LeaseToken, nextAttemptAt: number, code: string): Promise<void> {
    await this.#completeGeneric(lease, "Retry", code, Math.max(0, nextAttemptAt - this.#now()));
  }

  async outcomeUnknown(lease: LeaseToken, nextAttemptAt: number, code: string): Promise<void> {
    await this.#completeGeneric(
      lease,
      "OutcomeUnknown",
      code,
      Math.max(0, nextAttemptAt - this.#now()),
    );
  }

  async deadLetter(lease: LeaseToken, reason: string): Promise<void> {
    await this.#completeGeneric(lease, "DeadLetter", reason, 0);
  }

  async completeWorkspaceExport(
    lease: LeaseToken,
    outcome: WorkspaceExportCompletion,
  ): Promise<void> {
    this.#assertOwner(lease);
    const common = {
      jobId: lease.jobId,
      leaseGeneration: lease.generation,
      workerSlotId: lease.workerSlotId,
      artifactKey: "",
      contentHash: "",
      artifactVersion: "",
      sizeBytes: 0n,
      error: "",
      retryAfterSeconds: 0,
    };
    const input =
      outcome.type === "succeeded"
        ? {
            ...common,
            exportId: outcome.exportId,
            outcome: enumValue("Ready"),
            artifactKey: outcome.artifactKey,
            contentHash: outcome.contentHash,
            artifactVersion: outcome.artifactVersion,
            sizeBytes: BigInt(outcome.sizeBytes),
          }
        : {
            ...common,
            exportId: id(
              ((await this.#job(lease.jobId))?.payload as Record<string, JsonValue> | undefined)
                ?.exportId,
              "export_id",
            ),
            outcome: enumValue(
              outcome.type === "retry"
                ? "Retry"
                : outcome.type === "outcome_unknown"
                  ? "OutcomeUnknown"
                  : "Failed",
            ),
            error: outcome.code,
            retryAfterSeconds:
              outcome.type === "retry" || outcome.type === "outcome_unknown"
                ? retrySeconds(outcome.retryAfterMs)
                : 0,
          };
    await this.transport.reduce("complete_workspace_export", { input });
  }

  async completeWorkspaceExportCleanup(
    lease: LeaseToken,
    outcome: WorkspaceExportCleanupCompletion,
  ): Promise<void> {
    this.#assertOwner(lease);
    const exportId =
      outcome.type === "deleted" || outcome.type === "not_found"
        ? outcome.exportId
        : id(
            ((await this.#job(lease.jobId))?.payload as Record<string, JsonValue> | undefined)
              ?.exportId,
            "export_id",
          );
    await this.transport.reduce("complete_workspace_export_cleanup", {
      input: {
        exportId,
        jobId: lease.jobId,
        leaseGeneration: lease.generation,
        workerSlotId: lease.workerSlotId,
        outcome: enumValue(
          outcome.type === "deleted"
            ? "Deleted"
            : outcome.type === "not_found"
              ? "NotFound"
              : outcome.type === "retry"
                ? "Retry"
                : outcome.type === "outcome_unknown"
                  ? "OutcomeUnknown"
                  : "Failed",
        ),
        error: "code" in outcome ? outcome.code : "",
        retryAfterSeconds:
          outcome.type === "retry" || outcome.type === "outcome_unknown"
            ? retrySeconds(outcome.retryAfterMs)
            : 0,
      },
    });
  }

  async resolvePlan(
    input: NotificationPlanInput,
    signal: AbortSignal,
  ): Promise<NotificationDeliveryPlan>;
  async resolvePlan(
    input: WorkspaceExportPlanInput,
    signal: AbortSignal,
  ): Promise<WorkspaceExportPlan | undefined>;
  async resolvePlan(input: DigestClaim, signal: AbortSignal): Promise<DigestDeliveryPlan>;
  async resolvePlan(
    input: NotificationPlanInput | WorkspaceExportPlanInput | DigestClaim,
    signal: AbortSignal,
  ): Promise<NotificationDeliveryPlan | WorkspaceExportPlan | DigestDeliveryPlan | undefined> {
    if ("intentId" in input) return this.#notificationPlan(input, signal);
    if ("exportId" in input) return this.#exportPlan(input, signal);
    return this.#digestPlan(input, signal);
  }

  async #notificationPlan(
    input: NotificationPlanInput,
    signal: AbortSignal,
  ): Promise<NotificationDeliveryPlan> {
    const row = exactOne<Record<string, unknown>>(
      await this.#rows("pending_notification_delivery_plans", { job_id: input.jobId }, 1, signal),
      "notification_plan",
    );
    if (!row) throw new Error("spacetime_notification_plan_missing");
    if (
      id(row.notificationId, "notification_id") !== input.intentId ||
      id(row.workspaceId, "workspace_id") !== input.workspaceId ||
      id(row.recipientIdentity, "recipient_id") !== input.recipientId ||
      String(row.channel) !== input.requestedChannel ||
      id(row.resourceId, "resource_id") !== input.resourceId ||
      integer(row.membershipEpoch, "authorization_epoch") !== input.authorizationEpoch ||
      integer(row.resourceRevision, "delivery_revision") !== input.deliveryRevision ||
      id(row.workerSlotId, "worker_slot_id") !== input.workerSlotId ||
      integer(row.leaseGeneration, "lease_generation") !== input.leaseGeneration
    ) {
      throw new Error("spacetime_notification_plan_binding_mismatch");
    }
    const decision = notificationDecision(row.deliveryState);
    const base = {
      ...input,
      preferenceRevision: integer(row.preferenceRevision, "preference_revision"),
    };
    if (decision === "deliver") return { ...base, decision };
    const code = String(row.suppressionReason ?? "policy_suppressed");
    const allowed = [
      "recipient_opted_out",
      "channel_disabled",
      "recipient_suspended",
      "policy_suppressed",
    ] as const;
    const suppressionCode = allowed.find((item) => item === code) ?? "policy_suppressed";
    return { ...base, decision, suppressionCode };
  }

  async dispatchCurrentPlan<T>(
    plan: (NotificationDeliveryPlan | DigestDeliveryPlan) & { readonly decision: "deliver" },
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }>;
  async dispatchCurrentPlan<T>(
    plan: WorkspaceExportPlan,
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }>;
  async dispatchCurrentPlan<T>(
    plan: NotificationDeliveryPlan | DigestDeliveryPlan | WorkspaceExportPlan,
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }> {
    if ("claimId" in plan) {
      await this.transport.reduce("authorize_notification_digest", {
        input: {
          claimId: plan.claimId,
          workerSlotId: plan.workerSlotId,
          leaseGeneration: BigInt(plan.leaseGeneration),
          permitSeconds: 15,
        },
      });
      const current = await this.#digestPlan(plan, new AbortController().signal);
      if (current.decision !== "deliver" || current.deliveryKey !== plan.deliveryKey) {
        return { current: false };
      }
      const pending = operation();
      return { current: true, value: await pending };
    }
    if ("intentId" in plan) {
      await this.transport.reduce("authorize_notification_delivery", {
        jobId: plan.jobId,
        workerSlotId: plan.workerSlotId,
        leaseGeneration: BigInt(plan.leaseGeneration),
        permitSeconds: 15,
      });
      const current = await this.#notificationPlan(plan, new AbortController().signal);
      if (
        current.decision !== "deliver" ||
        current.preferenceRevision !== plan.preferenceRevision
      ) {
        return { current: false };
      }
      const pending = operation();
      return { current: true, value: await pending };
    }
    const current = await this.#exportPlan(plan, new AbortController().signal);
    if (!current || JSON.stringify(current) !== JSON.stringify(plan)) return { current: false };
    const pending = operation();
    return { current: true, value: await pending };
  }

  async claimDue(
    input: {
      readonly nowMs: number;
      readonly workerSlotId: string;
      readonly maxClaims: number;
      readonly leaseMs: number;
    },
    signal: AbortSignal,
  ): Promise<readonly DigestClaim[]> {
    if (input.maxClaims < 1 || input.maxClaims > 32)
      throw new Error("spacetime_digest_limit_invalid");
    const schedules = await this.#rows(
      "pending_notification_digest_schedules",
      { service_identity: this.transport.serviceIdentity },
      input.maxClaims,
      signal,
    );
    const occurrences = schedules
      .map((rowValue) => {
        const row = rowValue as Record<string, unknown>;
        const occurrence = nextDailyDigestOccurrence({
          after: new Date(input.nowMs - 36 * 60 * 60 * 1_000),
          timeZone: String(row.timeZone),
          localMinute: integer(row.digestLocalMinute, "digest_local_minute"),
          ...(String(row.lastOccurrenceLocalDate ?? "")
            ? { lastOccurrenceLocalDate: String(row.lastOccurrenceLocalDate) }
            : {}),
        });
        if (occurrence.scheduledFor.getTime() > input.nowMs) return undefined;
        return {
          scheduleId: id(row.scheduleId, "schedule_id"),
          localDate: occurrence.localDate,
          scheduledFor: occurrence.scheduledFor,
          expectedPreferenceRevision: BigInt(
            integer(row.preferenceRevision, "preference_revision"),
          ),
          expectedDigestRevision: BigInt(integer(row.digestRevision, "digest_revision")),
        };
      })
      .filter(
        (occurrence): occurrence is NonNullable<typeof occurrence> => occurrence !== undefined,
      );
    if (occurrences.length === 0) return [];
    await this.transport.reduce(
      "claim_notification_digests",
      {
        input: {
          occurrences,
          workerSlotId: id(input.workerSlotId, "worker_slot_id"),
          leaseSeconds: seconds(input.leaseMs, "digest_lease_ms"),
        },
      },
      signal,
    );
    const plans = await this.#rows(
      "pending_notification_digest_plans",
      { worker_slot_id: input.workerSlotId },
      input.maxClaims,
      signal,
    );
    return plans.map((rowValue) => this.#digestClaim(rowValue as Record<string, unknown>));
  }

  #digestClaim(row: Record<string, unknown>): DigestClaim {
    return {
      claimId: id(row.claimId, "claim_id"),
      workspaceId: id(row.workspaceId, "workspace_id"),
      recipientId: id(row.recipientIdentity, "recipient_id"),
      channel: String(row.channel) === "push" ? "push" : "email",
      scheduleId: id(row.scheduleId, "schedule_id"),
      localDate: String(row.localDate),
      scheduledForMs: timestamp(row.scheduledFor, "scheduled_for"),
      preferenceRevision: integer(row.preferenceRevision, "preference_revision"),
      digestRevision: integer(row.digestRevision, "digest_revision"),
      authorizationEpoch: integer(row.authorizationEpoch, "authorization_epoch"),
      workerSlotId: id(row.workerSlotId, "worker_slot_id"),
      leaseGeneration: integer(row.leaseGeneration, "lease_generation", 1),
      reconcileFirst: row.reconcileFirst === true,
    };
  }

  async #digestPlan(claim: DigestClaim, signal: AbortSignal): Promise<DigestDeliveryPlan> {
    const row = exactOne<Record<string, unknown>>(
      await this.#rows("pending_notification_digest_plans", { claim_id: claim.claimId }, 1, signal),
      "digest_plan",
    );
    if (!row) throw new Error("spacetime_digest_plan_missing");
    const current = this.#digestClaim(row);
    const base = { ...current, deliveryKey: digestDeliveryKey(current) };
    if (String(row.decision) === "deliver") {
      return {
        ...base,
        decision: "deliver",
        body: String(row.body),
        itemCount: integer(row.itemCount, "item_count", 1),
      };
    }
    return {
      ...base,
      decision: "suppress",
      suppressionCode: String(row.suppressionCode) as Extract<
        DigestDeliveryPlan,
        { readonly decision: "suppress" }
      >["suppressionCode"],
    };
  }

  async recordOutcome(
    claim: DigestClaim,
    outcome: DigestRecordedOutcome,
    signal: AbortSignal,
  ): Promise<boolean> {
    const planRow = exactOne<Record<string, unknown>>(
      await this.#rows("pending_notification_digest_plans", { claim_id: claim.claimId }, 1, signal),
      "digest_outcome_plan",
    );
    if (!planRow) return false;
    const permitExpiresAt = planRow.permitExpiresAt;
    const reconciled =
      outcome.type === "unknown" ||
      (outcome.type === "succeeded" &&
        (permitExpiresAt == null ||
          timestamp(permitExpiresAt, "permit_expires_at") <= this.#now()));
    await this.transport.reduce(
      "record_notification_digest_outcome",
      {
        input: {
          claimId: claim.claimId,
          workerSlotId: claim.workerSlotId,
          leaseGeneration: BigInt(claim.leaseGeneration),
          ...digestOutcome(outcome, reconciled),
        },
      },
      signal,
    );
    const remaining = await this.#rows(
      "pending_notification_digest_plans",
      { claim_id: claim.claimId },
      1,
      signal,
    );
    return remaining.length === 0;
  }

  async #exportPlan(
    input: WorkspaceExportPlanInput,
    signal: AbortSignal,
  ): Promise<WorkspaceExportPlan | undefined> {
    const row = exactOne<Record<string, unknown>>(
      await this.#rows("pending_workspace_export_plans", { job_id: input.jobId }, 1, signal),
      "workspace_export_plan",
    );
    if (!row) return undefined;
    const candidate: WorkspaceExportPlan = { ...input, reconcileOnly: row.reconcileOnly === true };
    return id(row.exportId, "export_id") === input.exportId &&
      id(row.workspaceId, "workspace_id") === input.workspaceId &&
      integer(row.lifecycleEpoch, "lifecycle_epoch") === input.lifecycleEpoch &&
      integer(row.workspaceRevision, "workspace_revision") === input.workspaceRevision &&
      integer(row.exportRevision, "export_revision") === input.exportRevision &&
      id(row.leaseOwner, "lease_owner") === input.leaseOwner &&
      id(row.workerSlotId, "worker_slot_id") === input.workerSlotId &&
      integer(row.leaseGeneration, "lease_generation") === input.leaseGeneration
      ? candidate
      : undefined;
  }

  async resolveCleanupPlan(
    input: WorkspaceExportCleanupPlanInput,
    signal: AbortSignal,
  ): Promise<WorkspaceExportCleanupPlan | undefined> {
    const row = exactOne<Record<string, unknown>>(
      await this.#rows(
        "pending_workspace_export_cleanup_plans",
        { job_id: input.jobId },
        1,
        signal,
      ),
      "workspace_export_cleanup_plan",
    );
    if (!row) return undefined;
    return id(row.exportId, "export_id") === input.exportId &&
      id(row.workspaceId, "workspace_id") === input.workspaceId &&
      integer(row.exportRevision, "export_revision") === input.exportRevision &&
      String(row.artifactKey) === input.artifactKey &&
      String(row.contentHash) === input.contentHash &&
      String(row.artifactVersion) === input.artifactVersion &&
      integer(row.sizeBytes, "size_bytes") === input.sizeBytes &&
      id(row.leaseOwner, "lease_owner") === input.leaseOwner &&
      id(row.workerSlotId, "worker_slot_id") === input.workerSlotId &&
      integer(row.leaseGeneration, "lease_generation") === input.leaseGeneration
      ? input
      : undefined;
  }

  async dispatchCurrentCleanupPlan<T>(
    plan: WorkspaceExportCleanupPlan,
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }> {
    const current = await this.resolveCleanupPlan(plan, new AbortController().signal);
    if (!current) return { current: false };
    const pending = operation();
    return { current: true, value: await pending };
  }
}

const parseJsonValue = (value: unknown, field: string): JsonValue | undefined => {
  if (value === "" || value === undefined || value === null) return undefined;
  try {
    return JSON.parse(String(value)) as JsonValue;
  } catch {
    throw new Error(`spacetime_invalid_${field}`);
  }
};

const effectState = (
  value: unknown,
): "started" | "succeeded" | "outcome_unknown" | "failed_permanent" => {
  switch (tag(value).toLowerCase()) {
    case "started":
      return "started";
    case "succeeded":
      return "succeeded";
    case "outcomeunknown":
    case "outcome_unknown":
      return "outcome_unknown";
    case "failedpermanent":
    case "failed_permanent":
      return "failed_permanent";
    default:
      throw new Error("spacetime_worker_effect_state_invalid");
  }
};

const effectRecord = (row: Readonly<Record<string, unknown>>) => {
  const result = parseJsonValue(row.resultJson, "worker_effect_result");
  const providerReference = String(row.providerReference ?? "");
  return {
    effectKey: id(row.effectKey, "effect_key"),
    identityFingerprint: id(row.identityFingerprint, "identity_fingerprint"),
    payloadFingerprint: id(row.payloadFingerprint, "payload_fingerprint"),
    state: effectState(row.state),
    ownerId: id(row.ownerId, "owner_id"),
    ownerGeneration: integer(row.ownerGeneration, "owner_generation"),
    leaseExpiresAt: integer(row.leaseExpiresAtMillis, "lease_expires_at"),
    ...(providerReference ? { providerReference } : {}),
    ...(result === undefined ? {} : { result }),
    updatedAt: timestamp(row.updatedAt, "updated_at"),
  };
};

/** Generic crash-safe effect ledger backed by caller-scoped service views. */
export class SpacetimeEffectLedger implements EffectLedger {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "spacetime-worker-effect-ledger";

  constructor(private readonly transport: AuthenticatedSpacetimeWorkerTransport) {}

  assertProductionReady(): boolean {
    return (
      this.transport.connected &&
      this.transport.views.has("service_worker_effects") &&
      this.transport.reducers.has("service_acquire_worker_effect") &&
      this.transport.reducers.has("service_update_worker_effect")
    );
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted && this.assertProductionReady() && this.transport.ready(signal);
  }

  async close(_signal: AbortSignal): Promise<void> {}

  async #get(effectKey: string) {
    const row = exactOne<Record<string, unknown>>(
      await this.transport.select("service_worker_effects", {
        where: { effect_key: id(effectKey, "effect_key") },
        limit: 1,
      }),
      "worker_effect",
    );
    return row ? effectRecord(row) : undefined;
  }

  async get(effectKey: string) {
    return this.#get(effectKey);
  }

  async acquire(input: EffectAcquireInput): Promise<EffectAcquireResult> {
    if (!input.authority) throw new SpacetimeSchemaGapError("worker_effect.authority_binding");
    const previous = await this.#get(input.effectKey);
    if (
      previous &&
      (previous.identityFingerprint !== input.identityFingerprint ||
        previous.payloadFingerprint !== input.payloadFingerprint)
    ) {
      throw new Error("worker_effect_identity_conflict");
    }
    if (previous?.state === "succeeded" || previous?.state === "failed_permanent") {
      return { acquired: false, record: previous };
    }
    try {
      await this.transport.reduce("service_acquire_worker_effect", {
        input: {
          effectKey: input.effectKey,
          identityFingerprint: input.identityFingerprint,
          payloadFingerprint: input.payloadFingerprint,
          ownerId: input.ownerId,
          ownerGeneration: BigInt(input.ownerGeneration),
          workspaceId: input.authority.workspaceId,
          runId: input.authority.runId ?? null,
          authorityJobId: input.authority.authorityJobId ?? null,
          leaseExpiresAtMillis: BigInt(input.leaseExpiresAt),
          allowTakeover: input.allowTakeover === true,
        },
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("worker effect is busy"))
        throw error;
      const busy = await this.#get(input.effectKey);
      if (!busy) throw error;
      return { acquired: false, record: busy };
    }
    const record = await this.#get(input.effectKey);
    if (!record) throw new Error("spacetime_worker_effect_not_visible");
    if (
      record.ownerId !== input.ownerId ||
      record.ownerGeneration !== input.ownerGeneration ||
      record.identityFingerprint !== input.identityFingerprint ||
      record.state !== "started"
    ) {
      return { acquired: false, record };
    }
    return {
      acquired: true,
      claim: {
        effectKey: record.effectKey,
        identityFingerprint: record.identityFingerprint,
        ownerId: record.ownerId,
        ownerGeneration: record.ownerGeneration,
      },
      record,
      ...(previous ? { previousState: previous.state } : {}),
    };
  }

  async #update(
    claim: Parameters<EffectLedger["heartbeat"]>[0],
    outcome: "Started" | "Succeeded" | "OutcomeUnknown" | "FailedPermanent",
    leaseExpiresAt: number,
    providerReference = "",
    result?: JsonValue,
  ): Promise<void> {
    await this.transport.reduce("service_update_worker_effect", {
      input: {
        effectKey: claim.effectKey,
        identityFingerprint: claim.identityFingerprint,
        ownerId: claim.ownerId,
        ownerGeneration: BigInt(claim.ownerGeneration),
        leaseExpiresAtMillis: BigInt(leaseExpiresAt),
        outcome: enumValue(outcome),
        providerReference,
        resultJson: result === undefined ? "" : JSON.stringify(result),
      },
    });
  }

  async heartbeat(
    claim: Parameters<EffectLedger["heartbeat"]>[0],
    leaseExpiresAt: number,
  ): Promise<void> {
    await this.#update(claim, "Started", leaseExpiresAt);
  }

  async succeeded(
    claim: Parameters<EffectLedger["succeeded"]>[0],
    providerReference?: string,
    result?: JsonValue,
  ): Promise<void> {
    const record = await this.#get(claim.effectKey);
    if (!record) throw new Error("spacetime_worker_effect_not_visible");
    await this.#update(claim, "Succeeded", record.leaseExpiresAt, providerReference ?? "", result);
  }

  async outcomeUnknown(claim: Parameters<EffectLedger["outcomeUnknown"]>[0]): Promise<void> {
    const record = await this.#get(claim.effectKey);
    if (!record) throw new Error("spacetime_worker_effect_not_visible");
    await this.#update(claim, "OutcomeUnknown", record.leaseExpiresAt);
  }

  async failedPermanent(claim: Parameters<EffectLedger["failedPermanent"]>[0]): Promise<void> {
    const record = await this.#get(claim.effectKey);
    if (!record) throw new Error("spacetime_worker_effect_not_visible");
    await this.#update(claim, "FailedPermanent", record.leaseExpiresAt);
  }
}

const nonceHash = (nonce: string): string => createHash("sha256").update(nonce).digest("hex");
const toolEffect = (value: string): Readonly<{ tag: string }> =>
  enumValue(value === "read" ? "Read" : value === "external" ? "External" : "Destructive");

/** Exact, replay-safe tool preparation and one-time approval consumption. */
export class SpacetimeApprovalStore implements ApprovalStore {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "spacetime-agent-approval-store";

  constructor(private readonly transport: AuthenticatedSpacetimeWorkerTransport) {}

  assertProductionReady(): boolean {
    return (
      this.transport.connected &&
      this.transport.views.has("service_agent_approval_bindings") &&
      this.transport.reducers.has("service_prepare_agent_tool_call") &&
      this.transport.reducers.has("consume_agent_tool_approval")
    );
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted && this.assertProductionReady() && this.transport.ready(signal);
  }

  async close(_signal: AbortSignal): Promise<void> {}

  async #binding(runId: string, callId: string) {
    return exactOne<Record<string, unknown>>(
      await this.transport.select("service_agent_approval_bindings", {
        where: { run_id: runId, call_id: callId },
        limit: 1,
      }),
      "agent_approval_binding",
    );
  }

  async prepareExact(
    expected: Omit<ApprovalRecord, "expiresAt" | "approved" | "used">,
    effectKey: string,
    leaseGeneration: number,
    requiresApproval: boolean,
    _now: number,
  ): Promise<"not_required" | "pending" | "approved" | "invalid"> {
    await this.transport.reduce("service_prepare_agent_tool_call", {
      input: {
        runId: expected.runId,
        leaseGeneration: BigInt(leaseGeneration),
        providerCallId: expected.callId,
        toolName: expected.toolName,
        toolVersion: expected.toolVersion,
        normalizedArgsHash: expected.argumentsHash,
        effectClass: toolEffect(expected.effectClass),
        effectKey,
        nonceHash: requiresApproval ? nonceHash(expected.nonce) : "",
      },
    });
    const row = await this.#binding(expected.runId, expected.callId);
    if (!requiresApproval) return row ? "invalid" : "not_required";
    if (!row) return "invalid";
    if (
      String(row.toolName) !== expected.toolName ||
      String(row.toolVersion) !== expected.toolVersion ||
      String(row.argumentsHash) !== expected.argumentsHash ||
      String(row.effectKey) !== effectKey ||
      String(row.nonceHash) !== nonceHash(expected.nonce)
    ) {
      return "invalid";
    }
    const state = tag(row.state).toLowerCase();
    return state === "approved" || state === "consumed" ? "approved" : "pending";
  }

  async consumeExact(
    expected: Omit<ApprovalRecord, "expiresAt" | "approved" | "used">,
    effectKey: string,
    _now: number,
  ): Promise<boolean> {
    try {
      await this.transport.reduce("consume_agent_tool_approval", {
        input: {
          runId: expected.runId,
          callId: expected.callId,
          toolName: expected.toolName,
          toolVersion: expected.toolVersion,
          normalizedArgsHash: expected.argumentsHash,
          effectClass: toolEffect(expected.effectClass),
          nonceHash: nonceHash(expected.nonce),
          effectKey,
        },
      });
    } catch {
      return false;
    }
    const row = await this.#binding(expected.runId, expected.callId);
    return row !== undefined && tag(row.state).toLowerCase() === "consumed";
  }
}

const runState = (value: unknown): AgentRunState => {
  const normalized = tag(value)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const states: readonly AgentRunState[] = [
    "queued",
    "authorizing",
    "collecting_context",
    "running",
    "awaiting_approval",
    "executing_tool",
    "succeeded",
    "failed",
    "canceled",
    "expired",
    "revoked",
  ];
  const state = states.find((candidate) => candidate === normalized);
  if (!state) throw new Error("spacetime_agent_run_state_invalid");
  return state;
};

const agentStateValue = (state: AgentRunState): Readonly<{ tag: string }> =>
  enumValue(
    state
      .split("_")
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(""),
  );

const terminalAgentState = new Set<AgentRunState>([
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "revoked",
]);

const controlFrom = (row: Readonly<Record<string, unknown>>): AgentRunControl => ({
  runId: id(row.runId, "run_id"),
  workspaceId: id(row.workspaceId, "workspace_id"),
  authorizationEpoch: integer(row.authorizationEpoch, "authorization_epoch"),
  currentAuthorizationEpoch: integer(row.currentAuthorizationEpoch, "current_authorization_epoch"),
  installationEnabled: row.installationEnabled === true,
  cancelRequested: row.cancelRequested === true,
  leaseGeneration: integer(row.leaseGeneration, "lease_generation"),
  leaseExpiresAt: row.leaseUntil == null ? 0 : timestamp(row.leaseUntil, "lease_until"),
  ...(String(row.executionRequestId ?? "")
    ? { executionRequestId: String(row.executionRequestId) }
    : {}),
  state: runState(row.state),
  budgets: {
    maxContextBytes: integer(row.maxContextBytes, "max_context_bytes"),
    maxOutputTokens: integer(row.maxOutputTokens, "max_output_tokens"),
    maxToolCalls: integer(row.maxToolCalls, "max_tool_calls"),
    maxCostMicros: integer(row.maxCostMicros, "max_cost_micros"),
    maxOutputBytes: integer(row.maxOutputBytes, "max_output_bytes"),
    maxToolResultBytes: integer(row.maxToolResultBytes, "max_tool_result_bytes"),
    maxTotalToolResultBytes: integer(row.maxTotalToolResultBytes, "max_total_tool_result_bytes"),
    maxProviderInputBytes: integer(row.maxProviderInputBytes, "max_provider_input_bytes"),
    maxTotalProviderInputBytes: integer(
      row.maxTotalProviderInputBytes,
      "max_total_provider_input_bytes",
    ),
  },
});

/** Durable agent run state, progress and provider dispatch repository. */
export class SpacetimeAgentRunRepository implements AgentRunRepository {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "spacetime-agent-run-repository";

  constructor(
    private readonly transport: AuthenticatedSpacetimeWorkerTransport,
    private readonly now: () => number = Date.now,
  ) {}

  assertProductionReady(): boolean {
    return (
      this.transport.connected &&
      [
        "service_agent_execution_plans",
        "service_agent_run_progress",
        "service_agent_provider_dispatches",
      ].every((view) => this.transport.views.has(view)) &&
      [
        "service_claim_agent_execution",
        "service_transition_agent_run",
        "service_save_agent_progress",
        "service_append_agent_checkpoint",
        "service_record_agent_provider_dispatch",
        "service_commit_agent_final",
        "heartbeat_agent_run",
        "record_agent_context_post",
        "record_agent_context_contribution",
      ].every((reducer) => this.transport.reducers.has(reducer))
    );
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted && this.assertProductionReady() && this.transport.ready(signal);
  }

  async close(_signal: AbortSignal): Promise<void> {}

  async #plan(runId: string): Promise<Readonly<Record<string, unknown>> | undefined> {
    return exactOne<Record<string, unknown>>(
      await this.transport.select("service_agent_execution_plans", {
        where: { run_id: id(runId, "run_id") },
        limit: 1,
      }),
      "agent_execution_plan",
    );
  }

  async control(runId: string): Promise<AgentRunControl> {
    const row = await this.#plan(runId);
    if (!row) throw new Error("spacetime_agent_run_not_visible");
    return controlFrom(row);
  }

  async claimExecution(input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly authorityJobId: string;
    readonly requestId: string;
    readonly leaseMs: number;
  }): Promise<
    | { readonly type: "claimed"; readonly control: AgentRunControl }
    | { readonly type: "busy"; readonly control: AgentRunControl }
    | { readonly type: "terminal"; readonly control: AgentRunControl }
  > {
    const beforeRow = await this.#plan(input.runId);
    if (!beforeRow) throw new Error("spacetime_agent_run_not_visible");
    const before = controlFrom(beforeRow);
    if (before.workspaceId !== input.workspaceId)
      throw new Error("spacetime_agent_workspace_mismatch");
    if (terminalAgentState.has(before.state)) return { type: "terminal", control: before };
    if (before.leaseExpiresAt > this.now()) return { type: "busy", control: before };
    try {
      await this.transport.reduce("service_claim_agent_execution", {
        input: {
          runId: input.runId,
          workspaceId: input.workspaceId,
          authorityJobId: input.authorityJobId,
          executionRequestId: input.requestId,
          expectedVersion: BigInt(integer(beforeRow.version, "agent_run_version")),
          leaseSeconds: seconds(input.leaseMs, "agent_lease_ms"),
        },
      });
    } catch (error) {
      const current = await this.control(input.runId);
      if (terminalAgentState.has(current.state)) return { type: "terminal", control: current };
      if (current.leaseExpiresAt > this.now()) return { type: "busy", control: current };
      throw error;
    }
    const claimedRow = await this.#plan(input.runId);
    if (!claimedRow) throw new Error("spacetime_agent_run_not_visible");
    const control = controlFrom(claimedRow);
    if (
      control.executionRequestId !== input.requestId ||
      control.leaseGeneration !== before.leaseGeneration + 1 ||
      id(claimedRow.leaseOwner, "lease_owner") !== this.transport.serviceIdentity
    ) {
      throw new Error("spacetime_agent_claim_fence_mismatch");
    }
    return { type: "claimed", control };
  }

  async transition(
    runId: string,
    leaseGeneration: number,
    state: AgentRunState,
    code: string,
  ): Promise<void> {
    await this.transport.reduce("service_transition_agent_run", {
      runId,
      leaseGeneration: BigInt(leaseGeneration),
      nextState: agentStateValue(state),
      code,
    });
  }

  async saveManifest(
    runId: string,
    leaseGeneration: number,
    manifest: readonly ContextManifestEntry[],
  ): Promise<void> {
    for (const entry of manifest) {
      const reducer =
        entry.sourceType === "post"
          ? "record_agent_context_post"
          : entry.sourceType === "contribution"
            ? "record_agent_context_contribution"
            : undefined;
      if (!reducer) throw new SpacetimeSchemaGapError(`agent_context.${entry.sourceType}`);
      await this.transport.reduce(reducer, {
        input: {
          runId,
          leaseGeneration: BigInt(leaseGeneration),
          ...(entry.sourceType === "post"
            ? { postId: entry.resourceId }
            : { contributionId: entry.resourceId }),
          expectedRevision: BigInt(entry.revision),
          sourceHash: entry.sha256,
          trustClass: entry.trustClass,
          redactionSummary: JSON.stringify(entry.redactions),
        },
      });
    }
  }

  async checkpoint(
    runId: string,
    leaseGeneration: number,
    checkpoint: AgentCheckpoint,
  ): Promise<void> {
    await this.transport.reduce("service_append_agent_checkpoint", {
      input: {
        runId,
        leaseGeneration: BigInt(leaseGeneration),
        sequence: BigInt(checkpoint.sequence),
        state: agentStateValue(checkpoint.state),
        code: checkpoint.code,
        detailsJson: checkpoint.details === undefined ? "" : JSON.stringify(checkpoint.details),
        createdAtMillis: BigInt(checkpoint.createdAt),
      },
    });
  }

  async progress(runId: string, leaseGeneration: number): Promise<AgentRunProgress> {
    const row = exactOne<Record<string, unknown>>(
      await this.transport.select("service_agent_run_progress", {
        where: { run_id: runId },
        limit: 1,
      }),
      "agent_progress",
    );
    if (!row) {
      return { sequence: 0, outputTokens: 0, costMicros: 0, toolCalls: 0, toolResults: [] };
    }
    if (integer(row.leaseGeneration, "lease_generation") > leaseGeneration) {
      throw new Error("spacetime_agent_progress_fence_mismatch");
    }
    const toolResults = parseJsonValue(row.toolResultsJson, "tool_results");
    const pendingStep = parseJsonValue(row.pendingStepJson, "pending_step");
    if (!Array.isArray(toolResults)) throw new Error("spacetime_agent_tool_results_invalid");
    return {
      sequence: integer(row.sequence, "sequence"),
      outputTokens: integer(row.outputTokens, "output_tokens"),
      costMicros: integer(row.costMicros, "cost_micros"),
      toolCalls: integer(row.toolCalls, "tool_calls"),
      toolResults: toolResults as readonly JsonValue[],
      providerInputBytes: integer(row.providerInputBytes, "provider_input_bytes"),
      ...(pendingStep === undefined ? {} : { pendingStep: pendingStep as never }),
    };
  }

  async saveProgress(
    runId: string,
    leaseGeneration: number,
    progress: AgentRunProgress,
  ): Promise<void> {
    await this.transport.reduce("service_save_agent_progress", {
      input: {
        runId,
        leaseGeneration: BigInt(leaseGeneration),
        sequence: BigInt(progress.sequence),
        outputTokens: BigInt(progress.outputTokens),
        costMicros: BigInt(progress.costMicros),
        toolCalls: progress.toolCalls,
        toolResultsJson: JSON.stringify(progress.toolResults),
        providerInputBytes: BigInt(progress.providerInputBytes ?? 0),
        pendingStepJson:
          progress.pendingStep === undefined ? "" : JSON.stringify(progress.pendingStep),
      },
    });
  }

  async heartbeatLease(
    runId: string,
    leaseGeneration: number,
    leaseExpiresAt: number,
  ): Promise<number> {
    await this.transport.reduce("heartbeat_agent_run", {
      runId,
      leaseGeneration: BigInt(leaseGeneration),
      leaseSeconds: seconds(leaseExpiresAt - this.now(), "agent_lease_extension"),
    });
    return (await this.control(runId)).leaseExpiresAt;
  }

  async providerDispatch(
    runId: string,
    providerSequence: number,
  ): Promise<ProviderDispatchFence | undefined> {
    const row = exactOne<Record<string, unknown>>(
      await this.transport.select("service_agent_provider_dispatches", {
        where: { run_id: runId, provider_sequence: providerSequence },
        limit: 1,
      }),
      "agent_provider_dispatch",
    );
    if (!row) return undefined;
    const context = parseJsonValue(row.contextJson, "provider_context");
    if (!Array.isArray(context)) throw new Error("spacetime_provider_context_invalid");
    return {
      runId: id(row.runId, "run_id"),
      providerSequence: integer(row.providerSequence, "provider_sequence"),
      leaseGeneration: integer(row.leaseGeneration, "lease_generation"),
      authorizationEpoch: integer(row.authorizationEpoch, "authorization_epoch"),
      requestId: id(row.requestId, "request_id"),
      inputFingerprint: id(row.inputFingerprint, "input_fingerprint"),
      canonicalInput: String(row.canonicalInput),
      inputBytes: integer(row.inputBytes, "input_bytes"),
      contextBindingHash: id(row.contextBindingHash, "context_binding_hash"),
      context: context as ProviderDispatchFence["context"],
    };
  }

  async recordProviderDispatch(input: ProviderDispatchFence): Promise<"created" | "existing"> {
    const before = await this.providerDispatch(input.runId, input.providerSequence);
    await this.transport.reduce("service_record_agent_provider_dispatch", {
      input: {
        runId: input.runId,
        providerSequence: BigInt(input.providerSequence),
        leaseGeneration: BigInt(input.leaseGeneration),
        authorizationEpoch: BigInt(input.authorizationEpoch),
        requestId: input.requestId,
        inputFingerprint: input.inputFingerprint,
        canonicalInput: input.canonicalInput,
        inputBytes: BigInt(input.inputBytes),
        contextBindingHash: input.contextBindingHash,
        contextJson: JSON.stringify(input.context),
      },
    });
    return before ? "existing" : "created";
  }

  async commitFinalAndSucceed(input: {
    readonly runId: string;
    readonly leaseGeneration: number;
    readonly authorizationEpoch: number;
    readonly text: string;
    readonly progress: AgentRunProgress;
  }): Promise<void> {
    await this.transport.reduce("service_commit_agent_final", {
      input: {
        runId: input.runId,
        leaseGeneration: BigInt(input.leaseGeneration),
        authorizationEpoch: BigInt(input.authorizationEpoch),
        text: input.text,
        progressSequence: BigInt(input.progress.sequence),
        outputTokens: BigInt(input.progress.outputTokens),
        costMicros: BigInt(input.progress.costMicros),
        toolCalls: input.progress.toolCalls,
        toolResultsJson: JSON.stringify(input.progress.toolResults),
        providerInputBytes: BigInt(input.progress.providerInputBytes ?? 0),
      },
    });
  }
}

/** Run-scoped context reader over the service-only candidate view. */
export class SpacetimeAgentContextSource implements AgentContextSource {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "spacetime-agent-context-source";

  constructor(private readonly transport: AuthenticatedSpacetimeWorkerTransport) {}

  assertProductionReady(): boolean {
    return this.transport.connected && this.transport.views.has("agent_context_candidates");
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted && this.assertProductionReady() && this.transport.ready(signal);
  }

  async close(_signal: AbortSignal): Promise<void> {}

  async list(runId: string) {
    const rows = await this.transport.select("agent_context_candidates", {
      where: { run_id: id(runId, "run_id") },
      limit: 64,
      orderBy: ["created_at", "resource_id"],
    });
    return rows.map((value) => {
      const row = value as Readonly<Record<string, unknown>>;
      return {
        resourceId: id(row.resourceId, "resource_id"),
        revision: integer(row.resourceRevision, "resource_revision"),
        sourceType: String(row.resourceType),
        trustClass: "workspace_untrusted" as const,
        redactions: [] as const,
      };
    });
  }

  async read(
    runId: string,
    metadata: Awaited<ReturnType<SpacetimeAgentContextSource["list"]>>[number],
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw signal.reason;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
      throw new Error("spacetime_context_read_bound_invalid");
    }
    const row = exactOne<Record<string, unknown>>(
      await this.transport.select(
        "agent_context_candidates",
        {
          where: {
            run_id: id(runId, "run_id"),
            resource_id: id(metadata.resourceId, "resource_id"),
            resource_revision: metadata.revision,
            resource_type: metadata.sourceType,
          },
          limit: 1,
        },
        signal,
      ),
      "agent_context_candidate",
    );
    if (!row) throw new Error("spacetime_context_candidate_stale");
    const body = String(row.body);
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error("spacetime_context_read_bound_exceeded");
    }
    return body;
  }
}

interface FilePlanAuthority {
  readonly jobId: string;
  readonly leaseGeneration: number;
  readonly cleanDestinationKey: string;
  readonly detectedType?: string;
}

export class SpacetimeFileAuthority implements FileAuthority {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "spacetime-file-authority";
  readonly #authority = new WeakMap<FileProcessingPlan, FilePlanAuthority>();

  constructor(private readonly transport: AuthenticatedSpacetimeWorkerTransport) {}

  assertProductionReady(): boolean {
    return (
      this.transport.connected &&
      [
        "file_processing_plans",
        "service_file_deletion_claims",
        "service_file_processing_outcomes",
      ].every((view) => this.transport.views.has(view)) &&
      [
        "register_clean_file_object",
        "record_file_scan_outcome",
        "record_file_extraction",
        "service_claim_file_deletion",
        "service_finalize_file_deletion",
        "service_release_file_deletion",
        "service_record_file_orphan",
      ].every((reducer) => this.transport.reducers.has(reducer))
    );
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted && this.assertProductionReady() && this.transport.ready(signal);
  }

  async close(_signal: AbortSignal): Promise<void> {}

  async plan(
    workspaceId: string,
    fileId: string,
    version: number,
    kind: "file.scan" | "file.extract" | "file.cleanup",
  ): Promise<FileProcessingPlan | undefined> {
    const row = exactOne<Record<string, unknown>>(
      await this.transport.select("file_processing_plans", {
        where: {
          workspace_id: workspaceId,
          file_id: fileId,
          file_revision: version,
          kind,
        },
        limit: 1,
      }),
      "file_processing_plan",
    );
    if (!row) return undefined;
    const plan: FileProcessingPlan = Object.freeze({
      workspaceId: id(row.workspaceId, "workspace_id"),
      fileId: id(row.fileId, "file_id"),
      version: integer(row.fileRevision, "file_revision", 1),
      ...(String(row.sourceKey ?? "") ? { sourceKey: String(row.sourceKey) } : {}),
      ...(String(row.cleanDestinationKey ?? "")
        ? { cleanDestinationKey: String(row.cleanDestinationKey) }
        : {}),
      ...(String(row.cleanupPrefix ?? "") ? { cleanupPrefix: String(row.cleanupPrefix) } : {}),
      allowedTypes: Object.freeze(
        Array.isArray(row.allowedTypes) ? row.allowedTypes.map((value) => String(value)) : [],
      ),
      maxBytes: integer(row.maxBytes, "max_bytes", 1),
      maxExtractedCharacters: integer(row.maxExtractedCharacters, "max_extracted_characters", 1),
    });
    this.#authority.set(plan, {
      jobId: id(row.jobId, "job_id"),
      leaseGeneration: integer(row.leaseGeneration, "lease_generation", 1),
      cleanDestinationKey: String(row.cleanDestinationKey ?? ""),
    });
    return plan;
  }

  #meta(plan: FileProcessingPlan): FilePlanAuthority {
    const meta = this.#authority.get(plan);
    if (!meta) throw new Error("spacetime_file_plan_provenance_missing");
    return meta;
  }

  async detectedType(plan: FileProcessingPlan, bytes: Uint8Array): Promise<string> {
    let detected = "application/octet-stream";
    if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-")
      detected = "application/pdf";
    else if (
      bytes.length >= 8 &&
      Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      detected = "image/png";
    else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      detected = "image/jpeg";
    else {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!text.includes("\0")) detected = "text/plain";
      } catch {
        detected = "application/octet-stream";
      }
    }
    const meta = this.#meta(plan);
    this.#authority.set(plan, { ...meta, detectedType: detected });
    return detected;
  }

  async markClean(plan: FileProcessingPlan, objectVersion: string, engine: string): Promise<void> {
    const meta = this.#meta(plan);
    if (!meta.detectedType || !meta.cleanDestinationKey)
      throw new Error("spacetime_clean_plan_invalid");
    await this.transport.reduce("register_clean_file_object", {
      input: {
        jobId: meta.jobId,
        leaseGeneration: BigInt(meta.leaseGeneration),
        fileId: plan.fileId,
        expectedRevision: BigInt(plan.version),
        cleanKey: meta.cleanDestinationKey,
        objectVersion,
        checksumSha256: objectVersion,
      },
    });
    await this.transport.reduce("record_file_scan_outcome", {
      input: {
        jobId: meta.jobId,
        leaseGeneration: BigInt(meta.leaseGeneration),
        fileId: plan.fileId,
        expectedRevision: BigInt(plan.version),
        detectedType: meta.detectedType,
        clean: true,
        cleanKey: meta.cleanDestinationKey,
        scanner: engine,
      },
    });
  }

  async markRejected(plan: FileProcessingPlan, code: string): Promise<void> {
    const meta = this.#meta(plan);
    if (!meta.detectedType) throw new Error("spacetime_file_detection_missing");
    await this.transport.reduce("record_file_scan_outcome", {
      input: {
        jobId: meta.jobId,
        leaseGeneration: BigInt(meta.leaseGeneration),
        fileId: plan.fileId,
        expectedRevision: BigInt(plan.version),
        detectedType: meta.detectedType,
        clean: false,
        cleanKey: "",
        scanner: code,
      },
    });
  }

  async recordExtractedText(plan: FileProcessingPlan, text: string): Promise<void> {
    const meta = this.#meta(plan);
    await this.transport.reduce("record_file_extraction", {
      input: {
        jobId: meta.jobId,
        leaseGeneration: BigInt(meta.leaseGeneration),
        fileId: plan.fileId,
        expectedRevision: BigInt(plan.version),
        extractedText: text,
      },
    });
  }

  async claimDeletion(
    plan: FileProcessingPlan,
    key: string,
    objectVersionTag: string,
  ): Promise<FileDeletionClaim | undefined> {
    const meta = this.#meta(plan);
    await this.transport.reduce("service_claim_file_deletion", {
      input: {
        jobId: meta.jobId,
        leaseGeneration: BigInt(meta.leaseGeneration),
        fileId: plan.fileId,
        expectedRevision: BigInt(plan.version),
        key,
        objectVersionTag,
      },
    });
    const row = exactOne<Record<string, unknown>>(
      await this.transport.select("service_file_deletion_claims", {
        where: { file_id: plan.fileId, file_revision: plan.version, key },
        limit: 1,
      }),
      "file_deletion_claim",
    );
    return row ? this.#claim(row) : undefined;
  }

  #claim(row: Readonly<Record<string, unknown>>): FileDeletionClaim {
    return {
      claimId: id(row.claimId, "claim_id"),
      generation: integer(row.generation, "generation", 1),
      workspaceId: id(row.workspaceId, "workspace_id"),
      fileId: id(row.fileId, "file_id"),
      version: integer(row.fileRevision, "file_revision", 1),
      key: String(row.key),
      objectVersionTag: String(row.objectVersionTag),
    };
  }

  #claimInput(claim: FileDeletionClaim) {
    return {
      claimId: claim.claimId,
      generation: BigInt(claim.generation),
      workspaceId: claim.workspaceId,
      fileId: claim.fileId,
      fileRevision: BigInt(claim.version),
      key: claim.key,
      objectVersionTag: claim.objectVersionTag,
    };
  }

  async finalizeDeletion(claim: FileDeletionClaim): Promise<void> {
    await this.transport.reduce("service_finalize_file_deletion", {
      input: this.#claimInput(claim),
    });
  }

  async releaseDeletion(claim: FileDeletionClaim, code: string): Promise<void> {
    await this.transport.reduce("service_release_file_deletion", {
      input: { claim: this.#claimInput(claim), code },
    });
  }

  async pendingDeletionClaims(plan: FileProcessingPlan): Promise<readonly FileDeletionClaim[]> {
    const rows = await this.transport.select("service_file_deletion_claims", {
      where: { file_id: plan.fileId, file_revision: plan.version },
      limit: 64,
    });
    return rows.map((row) => this.#claim(row as Readonly<Record<string, unknown>>));
  }

  async recordOrphanDiscrepancy(plan: FileProcessingPlan, key: string): Promise<void> {
    const meta = this.#meta(plan);
    await this.transport.reduce("service_record_file_orphan", {
      input: {
        jobId: meta.jobId,
        leaseGeneration: BigInt(meta.leaseGeneration),
        fileId: plan.fileId,
        expectedRevision: BigInt(plan.version),
        key,
      },
    });
  }

  async reconcile(plan: FileProcessingPlan, kind: OutboxJob["kind"]) {
    const meta = this.#meta(plan);
    const row = exactOne<Record<string, unknown>>(
      await this.transport.select("service_file_processing_outcomes", {
        where: { job_id: meta.jobId, file_id: plan.fileId, file_revision: plan.version, kind },
        limit: 1,
      }),
      "file_processing_outcome",
    );
    if (!row) return { type: "not_found" as const };
    const outcome = String(row.outcome);
    return outcome === "succeeded"
      ? { type: "succeeded" as const, result: { fileId: plan.fileId, version: plan.version } }
      : outcome === "not_found"
        ? { type: "not_found" as const }
        : { type: "unknown" as const };
  }
}

export class SpacetimeAuthorizationGate implements AuthorizationGate {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "spacetime-plan-authorization-gate";
  constructor(private readonly transport: AuthenticatedSpacetimeWorkerTransport) {}
  assertProductionReady(): boolean {
    return (
      this.transport.connected &&
      this.transport.views.has("service_agent_execution_plans") &&
      this.transport.views.has("pending_notification_delivery_plans")
    );
  }
  async ready(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted && this.assertProductionReady() && this.transport.ready(signal);
  }
  async close(_signal: AbortSignal): Promise<void> {}
  async canPerform(input: {
    readonly workspaceId: string;
    readonly operation: string;
    readonly resourceId: string;
    readonly authorizationEpoch?: number;
  }): Promise<boolean> {
    if (!input.operation.startsWith("agent.")) return false;
    const row = exactOne<Record<string, unknown>>(
      await this.transport.select("service_agent_execution_plans", {
        where: { run_id: input.resourceId, workspace_id: input.workspaceId },
        limit: 1,
      }),
      "authorization_agent_plan",
    );
    return Boolean(
      row &&
        row.installationEnabled === true &&
        row.cancelRequested !== true &&
        integer(row.authorizationEpoch, "authorization_epoch") === input.authorizationEpoch &&
        integer(row.currentAuthorizationEpoch, "current_authorization_epoch") ===
          input.authorizationEpoch,
    );
  }
  async dispatchAuthorizedContext<T>(
    input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly authorizationEpoch: number;
      readonly resourceIds: readonly string[];
    },
    operation: () => Promise<T>,
  ): Promise<{ readonly authorized: true; readonly value: T } | { readonly authorized: false }> {
    const authorized = await this.canPerform({
      workspaceId: input.workspaceId,
      operation: "agent.context.dispatch",
      resourceId: input.runId,
      authorizationEpoch: input.authorizationEpoch,
    });
    if (!authorized || input.resourceIds.length > 64) return { authorized: false };
    const pending = operation();
    return { authorized: true, value: await pending };
  }
  async dispatchAuthorizedOperation<T>(
    input: {
      readonly workspaceId: string;
      readonly operation: string;
      readonly resourceId: string;
      readonly authorizationEpoch: number;
      readonly recipientId: string;
    },
    operation: () => Promise<T>,
  ): Promise<{ readonly authorized: true; readonly value: T } | { readonly authorized: false }> {
    const row = exactOne<Record<string, unknown>>(
      await this.transport.select("pending_notification_delivery_plans", {
        where: {
          workspace_id: input.workspaceId,
          resource_id: input.resourceId,
          membership_epoch: input.authorizationEpoch,
          recipient_identity: input.recipientId,
        },
        limit: 1,
      }),
      "authorization_notification_plan",
    );
    if (!row || input.operation !== "notification.deliver") return { authorized: false };
    const pending = operation();
    return { authorized: true, value: await pending };
  }
}
