import { createHash } from "node:crypto";
import type { EffectResult, JsonValue, OutboxJob, ReconciliationResult } from "./domain.js";
import type { JobHandler, RuntimeAdapter } from "./outbox.js";
import { markReviewedHandler } from "./reviewed-handlers.js";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const CONTENT_HASH = /^[a-f0-9]{64}$/i;
const PROVIDER_REFERENCE = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_EXPORT_SIZE_BYTES = 1_099_511_627_776;
const EXPORT_ORPHAN_BACKSTOP_MS = 14 * 24 * 60 * 60 * 1_000;

const canonicalArtifactKey = (prefix: string, artifactKey: string): boolean => {
  if (artifactKey.length < 1 || artifactKey.length > 1_024 || !artifactKey.startsWith(prefix)) {
    return false;
  }
  const segments = artifactKey.slice(prefix.length).split("/");
  if (segments.length < 1 || segments.length > 32) return false;
  return segments.every(
    (segment) =>
      segment.length >= 1 &&
      segment.length <= 128 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("..") &&
      /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(segment),
  );
};

const payload = (job: OutboxJob): Readonly<Record<string, JsonValue>> => {
  if (typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) {
    throw new Error("workspace_export_payload_invalid");
  }
  return job.payload as Readonly<Record<string, JsonValue>>;
};

const identifier = (value: JsonValue | undefined, field: string): string => {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`workspace_export_${field}_invalid`);
  }
  return value;
};

const revision = (value: JsonValue | undefined, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`workspace_export_${field}_invalid`);
  }
  return value;
};

export interface WorkspaceExportPlanInput {
  readonly jobId: string;
  readonly exportId: string;
  readonly workspaceId: string;
  readonly lifecycleEpoch: number;
  readonly workspaceRevision: number;
  readonly exportRevision: number;
  readonly leaseOwner: string;
  readonly workerSlotId: string;
  readonly leaseGeneration: number;
}

export type WorkspaceExportPlan = WorkspaceExportPlanInput & {
  readonly reconcileOnly: boolean;
};

export interface WorkspaceExportCleanupPlanInput {
  readonly jobId: string;
  readonly exportId: string;
  readonly workspaceId: string;
  readonly exportRevision: number;
  readonly artifactKey: string;
  readonly contentHash: string;
  readonly artifactVersion: string;
  readonly sizeBytes: number;
  readonly leaseOwner: string;
  readonly workerSlotId: string;
  readonly leaseGeneration: number;
}

export type WorkspaceExportCleanupPlan = WorkspaceExportCleanupPlanInput;

export interface WorkspaceExportCleanupRequest {
  readonly exportId: string;
  readonly workspaceId: string;
  readonly exportRevision: number;
  readonly artifactKey: string;
  readonly contentHash: string;
  readonly artifactVersion: string;
  readonly sizeBytes: number;
  readonly cleanupKey: string;
}

export type WorkspaceExportDeleteResult =
  | { readonly type: "deleted" }
  | { readonly type: "not_found" }
  | { readonly type: "conditional_mismatch" }
  | { readonly type: "transient_failure"; readonly code: string; readonly retryAfterMs?: number }
  | { readonly type: "outcome_unknown"; readonly code: string };

export type WorkspaceExportDeleteReconciliation =
  | { readonly type: "deleted" }
  | { readonly type: "not_found" }
  | { readonly type: "conditional_mismatch" }
  | { readonly type: "unknown" };

export interface WorkspaceExportAuthority extends RuntimeAdapter {
  resolvePlan(
    input: WorkspaceExportPlanInput,
    signal: AbortSignal,
  ): Promise<WorkspaceExportPlan | undefined>;
  /** Revalidates the exact leased plan immediately before beginning materialization. */
  dispatchCurrentPlan<T>(
    plan: WorkspaceExportPlan,
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }>;
  resolveCleanupPlan(
    input: WorkspaceExportCleanupPlanInput,
    signal: AbortSignal,
  ): Promise<WorkspaceExportCleanupPlan | undefined>;
  dispatchCurrentCleanupPlan<T>(
    plan: WorkspaceExportCleanupPlan,
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }>;
}

export interface WorkspaceExportMaterializationRequest {
  readonly exportId: string;
  readonly workspaceId: string;
  readonly lifecycleEpoch: number;
  readonly workspaceRevision: number;
  readonly exportRevision: number;
  readonly artifactPrefix: string;
  readonly materializationKey: string;
  /** Bounded provider expiry covering the 7-day outbox age plus 7-day Ready window. */
  readonly deleteAfter: number;
}

export type WorkspaceExportMaterializationResult =
  | {
      readonly type: "succeeded";
      readonly artifactKey: string;
      readonly contentHash: string;
      readonly sizeBytes: number;
      readonly providerReference: string;
    }
  | {
      readonly type: "transient_failure";
      readonly code: "provider_unavailable" | "rate_limited" | "source_unavailable";
      readonly retryAfterMs?: number;
    }
  | {
      readonly type: "permanent_failure";
      readonly code: "source_rejected" | "artifact_too_large" | "provider_rejected";
    }
  | {
      readonly type: "outcome_unknown";
      readonly code: "provider_timeout" | "connection_lost_after_write";
    };

export type WorkspaceExportReconciliationResult =
  | Extract<WorkspaceExportMaterializationResult, { readonly type: "succeeded" }>
  | { readonly type: "not_found" }
  | { readonly type: "unknown" };

export interface WorkspaceExportMaterializer extends RuntimeAdapter {
  materialize(
    request: WorkspaceExportMaterializationRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceExportMaterializationResult>;
  reconcile(
    materializationKey: string,
    signal: AbortSignal,
  ): Promise<WorkspaceExportReconciliationResult>;
  /** Must write with the exact request.deleteAfter lifecycle/TTL. */
  deleteExact(
    request: WorkspaceExportCleanupRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceExportDeleteResult>;
  reconcileDelete(
    cleanupKey: string,
    signal: AbortSignal,
  ): Promise<WorkspaceExportDeleteReconciliation>;
}

const exactPlan = (left: WorkspaceExportPlanInput, right: WorkspaceExportPlan): boolean =>
  left.jobId === right.jobId &&
  left.exportId === right.exportId &&
  left.workspaceId === right.workspaceId &&
  left.lifecycleEpoch === right.lifecycleEpoch &&
  left.workspaceRevision === right.workspaceRevision &&
  left.exportRevision === right.exportRevision &&
  left.leaseOwner === right.leaseOwner &&
  left.workerSlotId === right.workerSlotId &&
  left.leaseGeneration === right.leaseGeneration &&
  typeof right.reconcileOnly === "boolean";

const planInput = (job: OutboxJob): WorkspaceExportPlanInput => {
  if (
    job.kind !== "workspace.export.generate" ||
    job.state !== "leased" ||
    !job.leaseOwner ||
    !job.leaseWorkerSlotId ||
    job.leaseExpiresAt === undefined
  ) {
    throw new Error("workspace_export_lease_invalid");
  }
  const body = payload(job);
  return {
    jobId: identifier(job.id, "job_id"),
    exportId: identifier(body.exportId, "export_id"),
    workspaceId: identifier(job.workspaceId, "workspace_id"),
    lifecycleEpoch: revision(body.lifecycleEpoch, "lifecycle_epoch"),
    workspaceRevision: revision(body.workspaceRevision, "workspace_revision"),
    exportRevision: revision(body.exportRevision, "export_revision"),
    leaseOwner: identifier(job.leaseOwner, "lease_owner"),
    workerSlotId: identifier(job.leaseWorkerSlotId, "worker_slot_id"),
    leaseGeneration: revision(job.leaseGeneration, "lease_generation"),
  };
};

const requestFor = (
  plan: WorkspaceExportPlanInput,
  createdAt: number,
): WorkspaceExportMaterializationRequest => {
  const artifactPrefix = `exports/${plan.workspaceId}/${plan.exportId}/`;
  const materializationKey = `workspace-export:${createHash("sha256")
    .update(
      [
        plan.workspaceId,
        plan.exportId,
        plan.lifecycleEpoch,
        plan.workspaceRevision,
        plan.exportRevision,
      ].join("\0"),
    )
    .digest("hex")}`;
  return {
    ...plan,
    artifactPrefix,
    materializationKey,
    deleteAfter: createdAt + EXPORT_ORPHAN_BACKSTOP_MS,
  };
};

const validateSuccess = (
  request: WorkspaceExportMaterializationRequest,
  result: Extract<WorkspaceExportMaterializationResult, { readonly type: "succeeded" }>,
): EffectResult => {
  if (
    !canonicalArtifactKey(request.artifactPrefix, result.artifactKey) ||
    !CONTENT_HASH.test(result.contentHash) ||
    !Number.isSafeInteger(result.sizeBytes) ||
    result.sizeBytes < 1 ||
    result.sizeBytes > MAX_EXPORT_SIZE_BYTES ||
    !PROVIDER_REFERENCE.test(result.providerReference)
  ) {
    return { type: "permanent_failure", code: "workspace_export_result_invalid" };
  }
  return {
    type: "succeeded",
    providerReference: result.providerReference,
    result: {
      exportId: request.exportId,
      exportRevision: request.exportRevision,
      artifactKey: result.artifactKey,
      contentHash: result.contentHash.toLowerCase(),
      artifactVersion: result.providerReference,
      sizeBytes: result.sizeBytes,
    },
  };
};

const classify = (
  request: WorkspaceExportMaterializationRequest,
  result: WorkspaceExportMaterializationResult,
): EffectResult => {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { type: "permanent_failure", code: "workspace_export_result_invalid" };
  }
  if (result.type === "succeeded") return validateSuccess(request, result);
  if (result.type === "transient_failure") {
    if (
      !["provider_unavailable", "rate_limited", "source_unavailable"].includes(result.code) ||
      (result.retryAfterMs !== undefined &&
        (!Number.isSafeInteger(result.retryAfterMs) ||
          result.retryAfterMs < 0 ||
          result.retryAfterMs > 86_400_000))
    ) {
      return { type: "permanent_failure", code: "workspace_export_result_invalid" };
    }
    return result;
  }
  if (result.type === "permanent_failure") {
    return ["source_rejected", "artifact_too_large", "provider_rejected"].includes(result.code)
      ? result
      : { type: "permanent_failure", code: "workspace_export_result_invalid" };
  }
  return ["provider_timeout", "connection_lost_after_write"].includes(result.code)
    ? result
    : { type: "permanent_failure", code: "workspace_export_result_invalid" };
};

export class WorkspaceExportHandler implements JobHandler {
  readonly retryWhenReconciledNotFound = true;
  readonly dependencies: readonly RuntimeAdapter[];

  constructor(
    private readonly authority: WorkspaceExportAuthority,
    private readonly materializer: WorkspaceExportMaterializer,
  ) {
    this.dependencies = [authority, materializer];
  }

  async execute(job: OutboxJob, _effectKey: string, signal: AbortSignal): Promise<EffectResult> {
    let input: WorkspaceExportPlanInput;
    try {
      input = planInput(job);
    } catch {
      return { type: "permanent_failure", code: "workspace_export_job_invalid" };
    }
    let plan: WorkspaceExportPlan | undefined;
    try {
      plan = await this.authority.resolvePlan(input, signal);
    } catch {
      return { type: "transient_failure", code: "workspace_export_authority_unavailable" };
    }
    if (!plan || !exactPlan(input, plan)) {
      return { type: "permanent_failure", code: "workspace_export_authority_stale" };
    }
    if (plan.reconcileOnly) {
      return { type: "permanent_failure", code: "workspace_export_reconciliation_only" };
    }
    const request = requestFor(plan, job.createdAt);
    try {
      const dispatched = await this.authority.dispatchCurrentPlan(plan, () =>
        this.materializer.materialize(request, signal),
      );
      if (!dispatched.current) {
        return { type: "permanent_failure", code: "workspace_export_authority_stale" };
      }
      return classify(request, dispatched.value);
    } catch {
      return { type: "outcome_unknown", code: "workspace_export_dispatch_exception" };
    }
  }

  async reconcile(
    _effectKey: string,
    job: OutboxJob,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    let request: WorkspaceExportMaterializationRequest;
    try {
      request = requestFor(planInput(job), job.createdAt);
    } catch {
      return { type: "unknown" };
    }
    let result: WorkspaceExportReconciliationResult;
    try {
      result = await this.materializer.reconcile(request.materializationKey, signal);
    } catch {
      return { type: "unknown" };
    }
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      return { type: "unknown" };
    }
    if (result.type === "not_found" || result.type === "unknown") return result;
    const classified = validateSuccess(request, result);
    return classified.type === "succeeded" ? classified : { type: "unknown" };
  }
}

export const createWorkspaceExportHandler = (
  authority: WorkspaceExportAuthority,
  materializer: WorkspaceExportMaterializer,
): WorkspaceExportHandler =>
  markReviewedHandler(new WorkspaceExportHandler(authority, materializer), [
    "workspace.export.generate",
  ]);

const cleanupPlanInput = (job: OutboxJob): WorkspaceExportCleanupPlanInput => {
  if (
    job.kind !== "workspace.export.cleanup" ||
    job.state !== "leased" ||
    !job.leaseOwner ||
    !job.leaseWorkerSlotId ||
    job.leaseExpiresAt === undefined
  ) {
    throw new Error("workspace_export_cleanup_lease_invalid");
  }
  const body = payload(job);
  const artifactKey = body.artifactKey;
  if (typeof artifactKey !== "string") {
    throw new Error("workspace_export_cleanup_artifact_key_invalid");
  }
  const input: WorkspaceExportCleanupPlanInput = {
    jobId: identifier(job.id, "cleanup_job_id"),
    exportId: identifier(body.exportId, "cleanup_export_id"),
    workspaceId: identifier(job.workspaceId, "cleanup_workspace_id"),
    exportRevision: revision(body.exportRevision, "cleanup_export_revision"),
    artifactKey,
    contentHash: identifier(body.contentHash, "cleanup_content_hash").toLowerCase(),
    artifactVersion: identifier(body.artifactVersion, "cleanup_artifact_version"),
    sizeBytes: revision(body.sizeBytes, "cleanup_size_bytes"),
    leaseOwner: identifier(job.leaseOwner, "cleanup_lease_owner"),
    workerSlotId: identifier(job.leaseWorkerSlotId, "cleanup_worker_slot_id"),
    leaseGeneration: revision(job.leaseGeneration, "cleanup_lease_generation"),
  };
  const prefix = `exports/${input.workspaceId}/${input.exportId}/`;
  if (
    !canonicalArtifactKey(prefix, input.artifactKey) ||
    !CONTENT_HASH.test(input.contentHash) ||
    !PROVIDER_REFERENCE.test(input.artifactVersion) ||
    input.sizeBytes > MAX_EXPORT_SIZE_BYTES
  ) {
    throw new Error("workspace_export_cleanup_artifact_invalid");
  }
  return input;
};

const exactCleanupPlan = (
  left: WorkspaceExportCleanupPlanInput,
  right: WorkspaceExportCleanupPlan,
): boolean =>
  left.jobId === right.jobId &&
  left.exportId === right.exportId &&
  left.workspaceId === right.workspaceId &&
  left.exportRevision === right.exportRevision &&
  left.artifactKey === right.artifactKey &&
  left.contentHash === right.contentHash.toLowerCase() &&
  left.artifactVersion === right.artifactVersion &&
  left.sizeBytes === right.sizeBytes &&
  left.leaseOwner === right.leaseOwner &&
  left.workerSlotId === right.workerSlotId &&
  left.leaseGeneration === right.leaseGeneration;

const cleanupRequest = (plan: WorkspaceExportCleanupPlan): WorkspaceExportCleanupRequest => ({
  exportId: plan.exportId,
  workspaceId: plan.workspaceId,
  exportRevision: plan.exportRevision,
  artifactKey: plan.artifactKey,
  contentHash: plan.contentHash.toLowerCase(),
  artifactVersion: plan.artifactVersion,
  sizeBytes: plan.sizeBytes,
  cleanupKey: `workspace-export-cleanup:${createHash("sha256")
    .update(
      [
        plan.workspaceId,
        plan.exportId,
        plan.exportRevision,
        plan.artifactKey,
        plan.contentHash.toLowerCase(),
        plan.artifactVersion,
      ].join("\0"),
    )
    .digest("hex")}`,
});

const cleanupSuccess = (
  request: WorkspaceExportCleanupRequest,
  disposition: "deleted" | "not_found",
): Extract<EffectResult, { readonly type: "succeeded" }> => ({
  type: "succeeded",
  result: { exportId: request.exportId, cleanupDisposition: disposition },
});

export class WorkspaceExportCleanupHandler implements JobHandler {
  readonly retryWhenReconciledNotFound = false;
  readonly dependencies: readonly RuntimeAdapter[];

  constructor(
    private readonly authority: WorkspaceExportAuthority,
    private readonly materializer: WorkspaceExportMaterializer,
  ) {
    this.dependencies = [authority, materializer];
  }

  async execute(job: OutboxJob, _effectKey: string, signal: AbortSignal): Promise<EffectResult> {
    let input: WorkspaceExportCleanupPlanInput;
    try {
      input = cleanupPlanInput(job);
    } catch {
      return { type: "permanent_failure", code: "workspace_export_cleanup_job_invalid" };
    }
    let plan: WorkspaceExportCleanupPlan | undefined;
    try {
      plan = await this.authority.resolveCleanupPlan(input, signal);
    } catch {
      return { type: "transient_failure", code: "workspace_export_cleanup_authority_unavailable" };
    }
    if (!plan || !exactCleanupPlan(input, plan)) {
      return { type: "permanent_failure", code: "workspace_export_cleanup_authority_stale" };
    }
    const request = cleanupRequest(plan);
    try {
      const dispatched = await this.authority.dispatchCurrentCleanupPlan(plan, () =>
        this.materializer.deleteExact(request, signal),
      );
      if (!dispatched.current) {
        return { type: "permanent_failure", code: "workspace_export_cleanup_authority_stale" };
      }
      const result = dispatched.value;
      if (result.type === "deleted" || result.type === "not_found") {
        return cleanupSuccess(request, result.type);
      }
      if (result.type === "conditional_mismatch") {
        return { type: "permanent_failure", code: "workspace_export_cleanup_conditional_mismatch" };
      }
      if (result.type === "transient_failure") {
        if (
          !/^[a-z0-9_.-]{1,80}$/.test(result.code) ||
          (result.retryAfterMs !== undefined &&
            (!Number.isSafeInteger(result.retryAfterMs) ||
              result.retryAfterMs < 0 ||
              result.retryAfterMs > 86_400_000))
        ) {
          return { type: "permanent_failure", code: "workspace_export_cleanup_result_invalid" };
        }
        return result;
      }
      return /^[a-z0-9_.-]{1,80}$/.test(result.code)
        ? result
        : { type: "permanent_failure", code: "workspace_export_cleanup_result_invalid" };
    } catch {
      return { type: "outcome_unknown", code: "workspace_export_cleanup_dispatch_exception" };
    }
  }

  async reconcile(
    _effectKey: string,
    job: OutboxJob,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    let request: WorkspaceExportCleanupRequest;
    try {
      request = cleanupRequest(cleanupPlanInput(job));
    } catch {
      return { type: "unknown" };
    }
    try {
      const result = await this.materializer.reconcileDelete(request.cleanupKey, signal);
      return result.type === "deleted" || result.type === "not_found"
        ? cleanupSuccess(request, result.type)
        : { type: "unknown" };
    } catch {
      return { type: "unknown" };
    }
  }
}

export const createWorkspaceExportCleanupHandler = (
  authority: WorkspaceExportAuthority,
  materializer: WorkspaceExportMaterializer,
): WorkspaceExportCleanupHandler =>
  markReviewedHandler(new WorkspaceExportCleanupHandler(authority, materializer), [
    "workspace.export.cleanup",
  ]);
