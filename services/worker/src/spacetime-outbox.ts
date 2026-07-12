import type { JsonValue, OutboxJob } from "./domain.js";
import { newJob } from "./outbox.js";

export interface SpacetimeOutboxEnvelope {
  readonly id: unknown;
  readonly workspaceId: unknown;
  readonly kind: string;
  readonly effectKey: string;
  readonly resourceType: string;
  readonly resourceId: unknown;
  readonly resourceRevision: bigint;
  readonly aclRevision?: bigint;
  readonly intentId?: unknown;
  readonly recipientId?: unknown;
  readonly channel: string;
  readonly authorizationEpoch?: bigint;
  readonly minimalMessage: string;
  readonly payloadResourceId?: unknown;
  readonly rebuildId?: unknown;
  readonly generation?: bigint;
  readonly fileId?: unknown;
  readonly version?: bigint;
  readonly runId?: unknown;
  readonly createdAt: unknown;
  readonly nextAttemptAt: unknown;
  readonly attempt: number;
  readonly state: unknown;
  readonly leaseOwner?: unknown;
  readonly workerSlotId: unknown;
  readonly leaseUntil?: unknown;
  readonly leaseGeneration: bigint;
  readonly lastError: string;
}

export interface SpacetimeSearchWorkItem {
  readonly jobId: unknown;
  readonly effectKey: string;
  readonly workspaceId: unknown;
  readonly resourceType: string;
  readonly resourceId: unknown;
  readonly resourceRevision: bigint;
  readonly aclRevision: bigint;
  readonly body: string;
  readonly allowedIdentities: readonly unknown[];
  readonly tombstone: boolean;
}

export interface SpacetimeWorkspaceExportPlan {
  readonly jobId: unknown;
  readonly exportId: unknown;
  readonly workspaceId: unknown;
  readonly lifecycleEpoch: bigint;
  readonly workspaceRevision: bigint;
  readonly exportRevision: bigint;
  readonly reconcileOnly: boolean;
}

export interface SpacetimeWorkspaceExportCleanupPlan {
  readonly jobId: unknown;
  readonly exportId: unknown;
  readonly workspaceId: unknown;
  readonly exportRevision: bigint;
  readonly artifactKey: string;
  readonly contentHash: string;
  readonly artifactVersion: string;
  readonly sizeBytes: bigint;
}

const identifier = (value: unknown, field: string): string => {
  const toHexString =
    typeof value === "object" && value !== null
      ? (value as { readonly toHexString?: unknown }).toHexString
      : undefined;
  const normalized =
    typeof toHexString === "function" ? String(toHexString.call(value)) : String(value ?? "");
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
};

const safeNumber = (value: bigint | number | undefined, field: string): number => {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (normalized === undefined || !Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
};

const timestampMillis = (value: unknown, field: string): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "object" && value !== null) {
    const micros = (value as { readonly microsSinceUnixEpoch?: unknown }).microsSinceUnixEpoch;
    if (typeof micros === "bigint") return safeNumber(micros / 1_000n, field);
  }
  throw new Error(`invalid_${field}`);
};

const option = <T>(value: T | null | undefined, field: string): T => {
  if (value === undefined || value === null) throw new Error(`missing_${field}`);
  return value;
};

const stateName = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const tag = (value as { readonly tag?: unknown }).tag;
    if (typeof tag === "string") return tag;
    const keys = Object.keys(value);
    if (keys.length === 1) return keys[0] ?? "";
  }
  return "";
};

const jobState = (value: unknown): OutboxJob["state"] => {
  switch (stateName(value).toLowerCase()) {
    case "pending":
    case "retry":
      return "pending";
    case "leased":
      return "leased";
    case "outcomeunknown":
    case "outcome_unknown":
      return "outcome_unknown";
    case "succeeded":
      return "succeeded";
    case "deadletter":
    case "dead_letter":
      return "dead_letter";
    default:
      throw new Error("invalid_outbox_state");
  }
};

const payloadFor = (
  row: SpacetimeOutboxEnvelope,
  search: SpacetimeSearchWorkItem | undefined,
  workspaceExport: SpacetimeWorkspaceExportPlan | undefined,
  workspaceExportCleanup: SpacetimeWorkspaceExportCleanupPlan | undefined,
): JsonValue => {
  const authorityResourceId = identifier(row.resourceId, "authority_resource_id");
  const authorityRevision = safeNumber(row.resourceRevision, "authority_resource_revision");
  const requireAuthorityBinding = (
    resourceType: string,
    semanticId: unknown,
    semanticVersion?: bigint | number,
  ): string => {
    const normalizedId = identifier(semanticId, "semantic_resource_id");
    if (
      row.resourceType !== resourceType ||
      authorityResourceId !== normalizedId ||
      (semanticVersion !== undefined &&
        authorityRevision !== safeNumber(semanticVersion, "semantic_resource_version"))
    ) {
      throw new Error("authority_resource_binding_mismatch");
    }
    return normalizedId;
  };
  const version = (): number => safeNumber(option(row.version, "version"), "version");
  switch (row.kind) {
    case "notification.deliver": {
      const deliveryRevision = version();
      const intentId = requireAuthorityBinding(
        "notification",
        option(row.intentId, "intent_id"),
        deliveryRevision,
      );
      return {
        intentId,
        recipientId: identifier(option(row.recipientId, "recipient_id"), "recipient_id"),
        channel: row.channel,
        resourceId: identifier(
          option(row.payloadResourceId, "payload_resource_id"),
          "payload_resource_id",
        ),
        authorizationEpoch: safeNumber(
          option(row.authorizationEpoch, "authorization_epoch"),
          "authorization_epoch",
        ),
        deliveryRevision,
        minimalMessage: option(row.minimalMessage || undefined, "minimal_message"),
      };
    }
    case "search.upsert":
    case "search.tombstone": {
      if (!search) throw new Error("missing_search_work_item");
      const jobId = identifier(search.jobId, "search_job_id");
      if (
        jobId !== identifier(row.id, "job_id") ||
        search.effectKey !== row.effectKey ||
        identifier(search.workspaceId, "search_workspace_id") !==
          identifier(row.workspaceId, "workspace_id") ||
        search.resourceType !== row.resourceType ||
        identifier(search.resourceId, "search_resource_id") !==
          identifier(option(row.payloadResourceId, "payload_resource_id"), "payload_resource_id") ||
        safeNumber(search.resourceRevision, "search_version") !== version() ||
        safeNumber(search.aclRevision, "search_acl_revision") !==
          safeNumber(row.aclRevision, "authority_acl_revision") ||
        search.tombstone !== (row.kind === "search.tombstone")
      ) {
        throw new Error("search_work_item_mismatch");
      }
      requireAuthorityBinding(search.resourceType, search.resourceId, search.resourceRevision);
      return {
        resourceId: identifier(search.resourceId, "resource_id"),
        resourceRevision: version(),
        aclRevision: safeNumber(search.aclRevision, "search_acl_revision"),
        body: row.kind === "search.tombstone" ? "" : search.body,
        visibilityIds: search.allowedIdentities.map((identity) =>
          identifier(identity, "visibility_id"),
        ),
      };
    }
    case "search.rebuild": {
      const rebuildId = requireAuthorityBinding(
        "search_rebuild",
        option(row.rebuildId, "rebuild_id"),
        option(row.generation, "generation"),
      );
      return {
        rebuildId,
        generation: safeNumber(option(row.generation, "generation"), "generation"),
      };
    }
    case "file.scan":
    case "file.extract":
    case "file.cleanup":
      return {
        fileId: requireAuthorityBinding(
          "file",
          option(row.fileId, "file_id"),
          option(row.version, "version"),
        ),
        version: version(),
      };
    case "agent.run":
      return {
        runId: requireAuthorityBinding("agent_run", option(row.runId, "run_id"), 1),
      };
    case "workspace.export.generate": {
      if (!workspaceExport) throw new Error("missing_workspace_export_plan");
      const exportId = requireAuthorityBinding(
        "workspace_export",
        option(row.payloadResourceId, "payload_resource_id"),
        option(row.version, "version"),
      );
      if (
        identifier(workspaceExport.jobId, "workspace_export_job_id") !==
          identifier(row.id, "job_id") ||
        identifier(workspaceExport.exportId, "workspace_export_id") !== exportId ||
        identifier(workspaceExport.workspaceId, "workspace_export_workspace_id") !==
          identifier(row.workspaceId, "workspace_id") ||
        safeNumber(workspaceExport.exportRevision, "workspace_export_revision") !== version() ||
        typeof workspaceExport.reconcileOnly !== "boolean"
      ) {
        throw new Error("workspace_export_plan_mismatch");
      }
      return {
        exportId,
        lifecycleEpoch: safeNumber(
          workspaceExport.lifecycleEpoch,
          "workspace_export_lifecycle_epoch",
        ),
        workspaceRevision: safeNumber(
          workspaceExport.workspaceRevision,
          "workspace_export_workspace_revision",
        ),
        exportRevision: safeNumber(workspaceExport.exportRevision, "workspace_export_revision"),
      };
    }
    case "workspace.export.cleanup": {
      if (!workspaceExportCleanup) throw new Error("missing_workspace_export_cleanup_plan");
      const exportId = requireAuthorityBinding(
        "workspace_export",
        option(row.payloadResourceId, "payload_resource_id"),
        option(row.version, "version"),
      );
      if (
        identifier(workspaceExportCleanup.jobId, "workspace_export_cleanup_job_id") !==
          identifier(row.id, "job_id") ||
        identifier(workspaceExportCleanup.exportId, "workspace_export_cleanup_id") !== exportId ||
        identifier(workspaceExportCleanup.workspaceId, "workspace_export_cleanup_workspace_id") !==
          identifier(row.workspaceId, "workspace_id") ||
        safeNumber(workspaceExportCleanup.exportRevision, "workspace_export_cleanup_revision") !==
          version()
      ) {
        throw new Error("workspace_export_cleanup_plan_mismatch");
      }
      return {
        exportId,
        exportRevision: version(),
        artifactKey: workspaceExportCleanup.artifactKey,
        contentHash: workspaceExportCleanup.contentHash,
        artifactVersion: workspaceExportCleanup.artifactVersion,
        sizeBytes: safeNumber(workspaceExportCleanup.sizeBytes, "workspace_export_cleanup_size"),
      };
    }
    default:
      throw new Error("invalid_effect_kind");
  }
};

export const decodeSpacetimeOutboxJob = (
  row: SpacetimeOutboxEnvelope,
  search?: SpacetimeSearchWorkItem | null,
  workspaceExport?: SpacetimeWorkspaceExportPlan | null,
  workspaceExportCleanup?: SpacetimeWorkspaceExportCleanupPlan,
): OutboxJob => {
  if (!row.effectKey) throw new Error("invalid_authority_effect_key");
  const createdAt = timestampMillis(row.createdAt, "created_at");
  // The authority effect key binds the private authority row to supplemental views. The worker
  // derives its provider idempotency key from the canonical semantic payload, so retries remain
  // stable even when transport/storage identifiers differ across authority implementations.
  const base = newJob(
    {
      id: identifier(row.id, "job_id"),
      workspaceId: identifier(row.workspaceId, "workspace_id"),
      kind: row.kind as OutboxJob["kind"],
      payload: payloadFor(
        row,
        search ?? undefined,
        workspaceExport ?? undefined,
        workspaceExportCleanup,
      ),
    },
    createdAt,
  );
  const leaseOwner = row.leaseOwner == null ? undefined : identifier(row.leaseOwner, "lease_owner");
  const leaseWorkerSlotId =
    row.workerSlotId == null || row.workerSlotId === ""
      ? undefined
      : identifier(row.workerSlotId, "worker_slot_id");
  const leaseExpiresAt =
    row.leaseUntil == null ? undefined : timestampMillis(row.leaseUntil, "lease_until");
  const state = jobState(row.state);
  if (
    (state === "leased" &&
      (leaseOwner === undefined ||
        leaseWorkerSlotId === undefined ||
        leaseExpiresAt === undefined)) ||
    (state !== "leased" &&
      (leaseOwner !== undefined || leaseWorkerSlotId !== undefined || leaseExpiresAt !== undefined))
  ) {
    throw new Error("invalid_outbox_lease_fence");
  }
  return {
    ...base,
    nextAttemptAt: timestampMillis(row.nextAttemptAt, "next_attempt_at"),
    attempt: safeNumber(row.attempt, "attempt"),
    state,
    leaseGeneration: safeNumber(row.leaseGeneration, "lease_generation"),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseWorkerSlotId === undefined ? {} : { leaseWorkerSlotId }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    ...(row.lastError ? { lastErrorCode: row.lastError } : {}),
  };
};
