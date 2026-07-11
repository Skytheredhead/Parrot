import { createHash } from "node:crypto";
import type {
  EffectResult,
  JsonValue,
  JobKind,
  OutboxJob,
  ReconciliationResult,
} from "./domain.js";
import type { JobHandler, RuntimeAdapter } from "./outbox.js";
import { markReviewedHandler } from "./reviewed-handlers.js";

const objectPayload = (job: OutboxJob): Readonly<Record<string, JsonValue>> => {
  if (typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) {
    throw new TypeError(`Invalid payload for ${job.kind}`);
  }
  return job.payload as Readonly<Record<string, JsonValue>>;
};

const stringField = (payload: Readonly<Record<string, JsonValue>>, key: string): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`Missing ${key}`);
  return value;
};

const numberField = (payload: Readonly<Record<string, JsonValue>>, key: string): number => {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new TypeError(`Missing ${key}`);
  return value;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
};

export interface AuthorizationGate extends RuntimeAdapter {
  canPerform(input: {
    readonly workspaceId: string;
    readonly operation: string;
    readonly resourceId: string;
    readonly authorizationEpoch?: number;
  }): Promise<boolean>;
  /** Atomically authorizes the exact context set and starts dispatch without an await gap. */
  dispatchAuthorizedContext<T>(
    input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly authorizationEpoch: number;
      readonly resourceIds: readonly string[];
    },
    operation: () => Promise<T>,
  ): Promise<{ readonly authorized: true; readonly value: T } | { readonly authorized: false }>;
}

export class InMemoryAuthorizationGate implements AuthorizationGate {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "in-memory-authorization-gate";
  private allowed = true;
  checks = 0;

  setAllowed(allowed: boolean): void {
    this.allowed = allowed;
  }

  async canPerform(): Promise<boolean> {
    this.checks += 1;
    return this.allowed;
  }

  async dispatchAuthorizedContext<T>(
    _input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly authorizationEpoch: number;
      readonly resourceIds: readonly string[];
    },
    operation: () => Promise<T>,
  ): Promise<{ readonly authorized: true; readonly value: T } | { readonly authorized: false }> {
    this.checks += 1;
    if (!this.allowed) return { authorized: false };
    const pending = operation();
    return { authorized: true, value: await pending };
  }
}

export interface NotificationRequest {
  readonly intentId: string;
  readonly recipientId: string;
  readonly channel: "email" | "push";
  readonly resourceId: string;
  readonly authorizationEpoch: number;
  readonly minimalMessage: string;
}

export interface NotificationProvider extends RuntimeAdapter {
  send(
    request: NotificationRequest,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<EffectResult>;
  reconcile(idempotencyKey: string, signal: AbortSignal): Promise<ReconciliationResult>;
}

export class NotificationDeliveryHandler implements JobHandler {
  readonly retryWhenReconciledNotFound = true;
  readonly dependencies: readonly RuntimeAdapter[];

  constructor(
    private readonly authorization: AuthorizationGate,
    private readonly provider: NotificationProvider,
  ) {
    this.dependencies = [authorization, provider];
  }

  async execute(job: OutboxJob, effectKey: string, signal: AbortSignal): Promise<EffectResult> {
    const payload = objectPayload(job);
    const channel = stringField(payload, "channel");
    if (channel !== "email" && channel !== "push") {
      return { type: "permanent_failure", code: "unsupported_notification_channel" };
    }
    const request: NotificationRequest = {
      intentId: stringField(payload, "intentId"),
      recipientId: stringField(payload, "recipientId"),
      channel,
      resourceId: stringField(payload, "resourceId"),
      authorizationEpoch: numberField(payload, "authorizationEpoch"),
      minimalMessage: stringField(payload, "minimalMessage"),
    };
    if (Buffer.byteLength(request.minimalMessage, "utf8") > 1_000) {
      return { type: "permanent_failure", code: "notification_message_too_large" };
    }
    throwIfAborted(signal);
    const allowed = await this.authorization.canPerform({
      workspaceId: job.workspaceId,
      operation: "notification.deliver",
      resourceId: request.resourceId,
      authorizationEpoch: request.authorizationEpoch,
    });
    if (!allowed) return { type: "permanent_failure", code: "delivery_revoked" };
    throwIfAborted(signal);
    return this.provider.send(request, effectKey, signal);
  }

  reconcile(
    effectKey: string,
    _job: OutboxJob,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    return this.provider.reconcile(effectKey, signal);
  }
}

export const createNotificationDeliveryHandler = (
  authorization: AuthorizationGate,
  provider: NotificationProvider,
): NotificationDeliveryHandler =>
  markReviewedHandler(new NotificationDeliveryHandler(authorization, provider), [
    "notification.deliver",
  ]);

export class InMemoryNotificationProvider implements NotificationProvider {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "in-memory-notification-provider";
  readonly calls: Array<{
    readonly request: NotificationRequest;
    readonly idempotencyKey: string;
  }> = [];
  private readonly delivered = new Map<string, string>();
  nextResult: EffectResult | undefined;

  async send(
    request: NotificationRequest,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<EffectResult> {
    throwIfAborted(signal);
    this.calls.push({ request, idempotencyKey });
    const existing = this.delivered.get(idempotencyKey);
    if (existing) return { type: "succeeded", providerReference: existing };
    const configured = this.nextResult;
    this.nextResult = undefined;
    if (configured) {
      if (configured.type === "succeeded") {
        this.delivered.set(
          idempotencyKey,
          configured.providerReference ?? `notification-${this.calls.length}`,
        );
      }
      return configured;
    }
    const reference = `notification-${this.calls.length}`;
    this.delivered.set(idempotencyKey, reference);
    return { type: "succeeded", providerReference: reference };
  }

  async reconcile(idempotencyKey: string, signal: AbortSignal): Promise<ReconciliationResult> {
    throwIfAborted(signal);
    const reference = this.delivered.get(idempotencyKey);
    return reference ? { type: "succeeded", providerReference: reference } : { type: "not_found" };
  }
}

export interface SearchDocument {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly version: number;
  readonly body: string;
  readonly visibilityIds: readonly string[];
  readonly tombstone: boolean;
  readonly contentHash?: string;
}

export interface SearchVersion {
  readonly version: number;
  readonly tombstone: boolean;
  readonly contentHash: string;
}

export interface SearchBackend extends RuntimeAdapter {
  apply(document: SearchDocument): Promise<void>;
  version(workspaceId: string, resourceId: string): Promise<SearchVersion | undefined>;
  beginRebuild(
    workspaceId: string,
    rebuildId: string,
    generation: number,
  ): Promise<"started" | "existing" | "stale">;
  applyRebuild(
    workspaceId: string,
    rebuildId: string,
    generation: number,
    document: SearchDocument,
  ): Promise<void>;
  activateRebuild(
    workspaceId: string,
    rebuildId: string,
    generation: number,
  ): Promise<"activated" | "already_active" | "stale">;
  activeGeneration(workspaceId: string): Promise<number | undefined>;
}

export interface SearchRebuildSource extends RuntimeAdapter {
  documents(workspaceId: string): AsyncIterable<SearchDocument>;
}

export const searchContentHash = (document: Omit<SearchDocument, "contentHash">): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: document.workspaceId,
        resourceId: document.resourceId,
        version: document.version,
        body: document.body,
        visibilityIds: [...document.visibilityIds].sort(),
        tombstone: document.tombstone,
      }),
    )
    .digest("hex");

const normalizedDocument = (document: SearchDocument): Required<SearchDocument> => {
  if (!Number.isSafeInteger(document.version) || document.version < 0) {
    throw new Error("search_invalid_version");
  }
  const normalized: Omit<Required<SearchDocument>, "contentHash"> = {
    ...document,
    visibilityIds: [...new Set(document.visibilityIds)].sort(),
    body: document.tombstone ? "" : document.body,
  };
  const computed = searchContentHash(normalized);
  if (document.contentHash !== undefined && document.contentHash !== computed) {
    throw new Error("search_content_hash_mismatch");
  }
  return { ...normalized, contentHash: computed };
};

export class SearchIndexHandler implements JobHandler {
  readonly retryWhenReconciledNotFound = true;
  readonly dependencies: readonly RuntimeAdapter[];

  constructor(
    private readonly backend: SearchBackend,
    private readonly rebuildSource: SearchRebuildSource,
  ) {
    this.dependencies = [backend, rebuildSource];
  }

  async execute(job: OutboxJob, _effectKey: string, signal: AbortSignal): Promise<EffectResult> {
    const payload = objectPayload(job);
    if (job.kind === "search.rebuild") {
      const rebuildId = stringField(payload, "rebuildId");
      const generation = numberField(payload, "generation");
      if (generation < 0) {
        return { type: "permanent_failure", code: "search_rebuild_generation_invalid" };
      }
      const begun = await this.backend.beginRebuild(job.workspaceId, rebuildId, generation);
      if (begun === "stale") {
        return { type: "succeeded", result: { rebuildId, generation, superseded: true } };
      }
      let count = 0;
      for await (const sourceDocument of this.rebuildSource.documents(job.workspaceId)) {
        throwIfAborted(signal);
        if (sourceDocument.workspaceId !== job.workspaceId) {
          return { type: "permanent_failure", code: "search_rebuild_workspace_mismatch" };
        }
        await this.backend.applyRebuild(job.workspaceId, rebuildId, generation, sourceDocument);
        count += 1;
      }
      throwIfAborted(signal);
      const activated = await this.backend.activateRebuild(job.workspaceId, rebuildId, generation);
      return {
        type: "succeeded",
        result: { rebuilt: count, rebuildId, generation, superseded: activated === "stale" },
      };
    }

    const document: SearchDocument = {
      workspaceId: job.workspaceId,
      resourceId: stringField(payload, "resourceId"),
      version: numberField(payload, "version"),
      body: job.kind === "search.tombstone" ? "" : stringField(payload, "body"),
      visibilityIds:
        Array.isArray(payload.visibilityIds) &&
        payload.visibilityIds.every((item) => typeof item === "string")
          ? payload.visibilityIds
          : [],
      tombstone: job.kind === "search.tombstone",
    };
    throwIfAborted(signal);
    await this.backend.apply(document);
    const normalized = normalizedDocument(document);
    return {
      type: "succeeded",
      result: {
        resourceId: normalized.resourceId,
        version: normalized.version,
        contentHash: normalized.contentHash,
      },
    };
  }

  async reconcile(
    _effectKey: string,
    job: OutboxJob,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    throwIfAborted(signal);
    const payload = objectPayload(job);
    if (job.kind === "search.rebuild") {
      const rebuildId = stringField(payload, "rebuildId");
      const generation = numberField(payload, "generation");
      const activeGeneration = await this.backend.activeGeneration(job.workspaceId);
      return activeGeneration !== undefined && activeGeneration >= generation
        ? {
            type: "succeeded",
            result: { rebuildId, generation, superseded: activeGeneration > generation },
          }
        : { type: "not_found" };
    }
    const expected = normalizedDocument({
      workspaceId: job.workspaceId,
      resourceId: stringField(payload, "resourceId"),
      version: numberField(payload, "version"),
      body: job.kind === "search.tombstone" ? "" : stringField(payload, "body"),
      visibilityIds:
        Array.isArray(payload.visibilityIds) &&
        payload.visibilityIds.every((item) => typeof item === "string")
          ? payload.visibilityIds
          : [],
      tombstone: job.kind === "search.tombstone",
    });
    const current = await this.backend.version(job.workspaceId, expected.resourceId);
    if (
      current &&
      (current.version > expected.version ||
        (current.version === expected.version &&
          current.tombstone === expected.tombstone &&
          current.contentHash === expected.contentHash))
    ) {
      return {
        type: "succeeded",
        result: { resourceId: expected.resourceId, version: current.version },
      };
    }
    return { type: "not_found" };
  }
}

export const createSearchIndexHandler = (
  backend: SearchBackend,
  rebuildSource: SearchRebuildSource,
): SearchIndexHandler =>
  markReviewedHandler(new SearchIndexHandler(backend, rebuildSource), [
    "search.upsert",
    "search.tombstone",
    "search.rebuild",
  ]);

interface RebuildState {
  readonly workspaceId: string;
  readonly rebuildId: string;
  readonly generation: number;
  readonly shadow: Map<string, Required<SearchDocument>>;
  readonly journal: Map<string, Required<SearchDocument>>;
  active: boolean;
}

const applyStrict = (
  target: Map<string, Required<SearchDocument>>,
  documentValue: SearchDocument,
): void => {
  const document = normalizedDocument(documentValue);
  const key = `${document.workspaceId}:${document.resourceId}`;
  const current = target.get(key);
  if (!current || document.version > current.version) {
    target.set(key, structuredClone(document));
    return;
  }
  if (document.version < current.version) return;
  if (current.tombstone && !document.tombstone) return;
  if (!current.tombstone && document.tombstone) {
    target.set(key, structuredClone(document));
    return;
  }
  if (current.contentHash !== document.contentHash) throw new Error("search_version_conflict");
};

export class InMemorySearchBackend implements SearchBackend, SearchRebuildSource {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "in-memory-search-backend";
  readonly index = new Map<string, Required<SearchDocument>>();
  private readonly authoritative = new Map<string, SearchDocument[]>();
  private readonly rebuilds = new Map<string, RebuildState>();
  private readonly activeGenerations = new Map<string, number>();
  private readonly highestSeenGenerations = new Map<string, number>();
  private readonly highestSeenRebuildIds = new Map<string, string>();

  async apply(document: SearchDocument): Promise<void> {
    applyStrict(this.index, document);
    for (const rebuild of this.rebuilds.values()) {
      if (rebuild.workspaceId === document.workspaceId && !rebuild.active) {
        applyStrict(rebuild.journal, document);
      }
    }
  }

  async version(workspaceId: string, resourceId: string): Promise<SearchVersion | undefined> {
    const document = this.index.get(`${workspaceId}:${resourceId}`);
    return document
      ? {
          version: document.version,
          tombstone: document.tombstone,
          contentHash: document.contentHash,
        }
      : undefined;
  }

  async beginRebuild(
    workspaceId: string,
    rebuildId: string,
    generation: number,
  ): Promise<"started" | "existing" | "stale"> {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("search_rebuild_generation_invalid");
    }
    const highest = this.highestSeenGenerations.get(workspaceId);
    if (highest !== undefined && generation < highest) return "stale";
    if (
      highest === generation &&
      this.highestSeenRebuildIds.get(workspaceId) !== undefined &&
      this.highestSeenRebuildIds.get(workspaceId) !== rebuildId
    ) {
      throw new Error("search_rebuild_generation_conflict");
    }
    const key = `${workspaceId}:${rebuildId}`;
    const existing = this.rebuilds.get(key);
    if (existing) {
      if (existing.generation !== generation) throw new Error("search_rebuild_identity_conflict");
      return "existing";
    }
    this.highestSeenGenerations.set(workspaceId, generation);
    this.highestSeenRebuildIds.set(workspaceId, rebuildId);
    if (!existing) {
      this.rebuilds.set(key, {
        workspaceId,
        rebuildId,
        generation,
        shadow: new Map(),
        journal: new Map(),
        active: false,
      });
    }
    return "started";
  }

  async applyRebuild(
    workspaceId: string,
    rebuildId: string,
    generation: number,
    document: SearchDocument,
  ): Promise<void> {
    if (document.workspaceId !== workspaceId) throw new Error("search_rebuild_workspace_mismatch");
    const rebuild = this.mustRebuild(workspaceId, rebuildId);
    if (rebuild.generation !== generation) throw new Error("search_rebuild_generation_mismatch");
    if ((this.highestSeenGenerations.get(workspaceId) ?? generation) > generation) return;
    if (!rebuild.active) applyStrict(rebuild.shadow, document);
  }

  async activateRebuild(
    workspaceId: string,
    rebuildId: string,
    generation: number,
  ): Promise<"activated" | "already_active" | "stale"> {
    const rebuild = this.mustRebuild(workspaceId, rebuildId);
    if (rebuild.generation !== generation) throw new Error("search_rebuild_generation_mismatch");
    if ((this.highestSeenGenerations.get(workspaceId) ?? generation) > generation) return "stale";
    const activeGeneration = this.activeGenerations.get(workspaceId);
    if (activeGeneration !== undefined && activeGeneration > generation) return "stale";
    if (rebuild.active) return "already_active";
    const replacement = new Map(rebuild.shadow);
    for (const document of rebuild.journal.values()) applyStrict(replacement, document);
    for (const key of [...this.index.keys()]) {
      if (key.startsWith(`${workspaceId}:`)) this.index.delete(key);
    }
    for (const [key, document] of replacement) this.index.set(key, structuredClone(document));
    rebuild.active = true;
    this.activeGenerations.set(workspaceId, generation);
    return "activated";
  }

  async activeGeneration(workspaceId: string): Promise<number | undefined> {
    return this.activeGenerations.get(workspaceId);
  }

  seed(workspaceId: string, documents: readonly SearchDocument[]): void {
    this.authoritative.set(
      workspaceId,
      documents.map((document) => structuredClone(document)),
    );
  }

  async *documents(workspaceId: string): AsyncIterable<SearchDocument> {
    for (const document of this.authoritative.get(workspaceId) ?? [])
      yield structuredClone(document);
  }

  private mustRebuild(workspaceId: string, rebuildId: string): RebuildState {
    const rebuild = this.rebuilds.get(`${workspaceId}:${rebuildId}`);
    if (!rebuild) throw new Error("search_rebuild_not_started");
    return rebuild;
  }
}

export interface ObjectVersion {
  readonly versionTag: string;
}

export interface ObjectStore extends RuntimeAdapter {
  readStream(key: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
  writeClean(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<string>;
  stat(key: string, signal: AbortSignal): Promise<ObjectVersion | undefined>;
  deleteIfMatch(key: string, versionTag: string, signal: AbortSignal): Promise<boolean>;
  list(prefix: string, signal: AbortSignal): AsyncIterable<string>;
}

export interface MalwareScanner extends RuntimeAdapter {
  scan(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<{ readonly clean: boolean; readonly engine: string; readonly signature?: string }>;
}

export interface TextExtractor extends RuntimeAdapter {
  extract(bytes: Uint8Array, detectedType: string, signal: AbortSignal): Promise<string>;
}

export interface FileProcessingPlan {
  readonly workspaceId: string;
  readonly fileId: string;
  readonly version: number;
  readonly sourceKey?: string;
  readonly cleanDestinationKey?: string;
  readonly cleanupPrefix?: string;
  readonly allowedTypes: readonly string[];
  readonly maxBytes: number;
  readonly maxExtractedCharacters: number;
}

export interface FileDeletionClaim {
  readonly claimId: string;
  readonly generation: number;
  readonly workspaceId: string;
  readonly fileId: string;
  readonly version: number;
  readonly key: string;
  readonly objectVersionTag: string;
}

export interface FileAuthority extends RuntimeAdapter {
  plan(
    workspaceId: string,
    fileId: string,
    version: number,
    kind: Extract<JobKind, "file.scan" | "file.extract" | "file.cleanup">,
  ): Promise<FileProcessingPlan | undefined>;
  detectedType(plan: FileProcessingPlan, bytes: Uint8Array): Promise<string>;
  markClean(plan: FileProcessingPlan, cleanKey: string, engine: string): Promise<void>;
  markRejected(plan: FileProcessingPlan, code: string): Promise<void>;
  recordExtractedText(plan: FileProcessingPlan, text: string): Promise<void>;
  /** Must atomically reserve deletion and prevent creation of a new reference to this object. */
  claimDeletion(
    plan: FileProcessingPlan,
    key: string,
    objectVersionTag: string,
  ): Promise<FileDeletionClaim | undefined>;
  finalizeDeletion(claim: FileDeletionClaim): Promise<void>;
  releaseDeletion(claim: FileDeletionClaim, code: string): Promise<void>;
  pendingDeletionClaims(plan: FileProcessingPlan): Promise<readonly FileDeletionClaim[]>;
  recordOrphanDiscrepancy(plan: FileProcessingPlan, key: string): Promise<void>;
  reconcile(plan: FileProcessingPlan, kind: JobKind): Promise<ReconciliationResult>;
}

const planMatchesPayload = (
  payload: Readonly<Record<string, JsonValue>>,
  plan: FileProcessingPlan,
): boolean =>
  (payload.objectKey === undefined || payload.objectKey === plan.sourceKey) &&
  (payload.prefix === undefined || payload.prefix === plan.cleanupPrefix);

const deletionClaimMatches = (
  plan: FileProcessingPlan,
  claim: FileDeletionClaim,
  key = claim.key,
  objectVersionTag = claim.objectVersionTag,
): boolean =>
  claim.workspaceId === plan.workspaceId &&
  claim.fileId === plan.fileId &&
  claim.version === plan.version &&
  Number.isSafeInteger(claim.generation) &&
  claim.generation >= 1 &&
  claim.key === key &&
  claim.objectVersionTag === objectVersionTag &&
  claim.claimId.length >= 1 &&
  claim.claimId.length <= 256;

const readBounded = async (
  store: ObjectStore,
  key: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of store.readStream(key, signal)) {
    throwIfAborted(signal);
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("file_size_limit_exceeded");
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

export class FileProcessingHandler implements JobHandler {
  readonly retryWhenReconciledNotFound = true;
  readonly dependencies: readonly RuntimeAdapter[];

  constructor(
    private readonly store: ObjectStore,
    private readonly scanner: MalwareScanner,
    private readonly extractor: TextExtractor,
    private readonly authority: FileAuthority,
  ) {
    this.dependencies = [store, scanner, extractor, authority];
  }

  async execute(job: OutboxJob, _effectKey: string, signal: AbortSignal): Promise<EffectResult> {
    if (job.kind !== "file.scan" && job.kind !== "file.extract" && job.kind !== "file.cleanup") {
      return { type: "permanent_failure", code: "unsupported_file_job" };
    }
    const payload = objectPayload(job);
    const fileId = stringField(payload, "fileId");
    const version = numberField(payload, "version");
    const plan = await this.authority.plan(job.workspaceId, fileId, version, job.kind);
    if (
      !plan ||
      plan.workspaceId !== job.workspaceId ||
      plan.fileId !== fileId ||
      plan.version !== version
    ) {
      return { type: "permanent_failure", code: "file_processing_revoked" };
    }
    if (!planMatchesPayload(payload, plan)) {
      return { type: "permanent_failure", code: "file_plan_mismatch" };
    }
    throwIfAborted(signal);

    if (job.kind === "file.cleanup") {
      if (!plan.cleanupPrefix)
        return { type: "permanent_failure", code: "file_cleanup_plan_invalid" };
      let deleted = 0;
      for await (const key of this.store.list(plan.cleanupPrefix, signal)) {
        throwIfAborted(signal);
        if (!key.startsWith(plan.cleanupPrefix)) {
          await this.authority.recordOrphanDiscrepancy(plan, key);
          continue;
        }
        const observed = await this.store.stat(key, signal);
        if (!observed) continue;
        const claim = await this.authority.claimDeletion(plan, key, observed.versionTag);
        if (!claim) {
          await this.authority.recordOrphanDiscrepancy(plan, key);
          continue;
        }
        if (!deletionClaimMatches(plan, claim, key, observed.versionTag)) {
          await this.authority.releaseDeletion(claim, "deletion_claim_mismatch");
          await this.authority.recordOrphanDiscrepancy(plan, key);
          continue;
        }
        throwIfAborted(signal);
        const removed = await this.store.deleteIfMatch(key, claim.objectVersionTag, signal);
        if (!removed) {
          await this.authority.releaseDeletion(claim, "object_version_changed");
          await this.authority.recordOrphanDiscrepancy(plan, key);
          continue;
        }
        await this.authority.finalizeDeletion(claim);
        deleted += 1;
      }
      return { type: "succeeded", result: { deleted } };
    }

    if (!plan.sourceKey) return { type: "permanent_failure", code: "file_source_plan_invalid" };
    const bytes = await readBounded(this.store, plan.sourceKey, plan.maxBytes, signal);
    const detectedType = await this.authority.detectedType(plan, bytes);
    if (!plan.allowedTypes.includes(detectedType)) {
      await this.authority.markRejected(plan, "file_type_not_allowed");
      return { type: "permanent_failure", code: "file_type_not_allowed" };
    }
    throwIfAborted(signal);
    if (job.kind === "file.scan") {
      if (!plan.cleanDestinationKey) {
        return { type: "permanent_failure", code: "file_clean_destination_invalid" };
      }
      const result = await this.scanner.scan(bytes, signal);
      throwIfAborted(signal);
      if (!result.clean) {
        await this.authority.markRejected(plan, "malware_detected");
        return { type: "permanent_failure", code: "malware_detected" };
      }
      const cleanKey = await this.store.writeClean(plan.cleanDestinationKey, bytes, signal);
      throwIfAborted(signal);
      await this.authority.markClean(plan, cleanKey, result.engine);
      return { type: "succeeded", result: { fileId, version, cleanKey } };
    }
    const text = await this.extractor.extract(bytes, detectedType, signal);
    throwIfAborted(signal);
    if (text.length > plan.maxExtractedCharacters) {
      return { type: "permanent_failure", code: "file_extraction_limit_exceeded" };
    }
    await this.authority.recordExtractedText(plan, text);
    return { type: "succeeded", result: { fileId, version, characters: text.length } };
  }

  async reconcile(
    _effectKey: string,
    job: OutboxJob,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    if (job.kind !== "file.scan" && job.kind !== "file.extract" && job.kind !== "file.cleanup") {
      return { type: "unknown" };
    }
    const payload = objectPayload(job);
    const plan = await this.authority.plan(
      job.workspaceId,
      stringField(payload, "fileId"),
      numberField(payload, "version"),
      job.kind,
    );
    throwIfAborted(signal);
    const fileId = stringField(payload, "fileId");
    const version = numberField(payload, "version");
    if (
      !plan ||
      plan.workspaceId !== job.workspaceId ||
      plan.fileId !== fileId ||
      plan.version !== version ||
      !planMatchesPayload(payload, plan)
    ) {
      return { type: "unknown" };
    }
    if (job.kind === "file.cleanup") {
      const claims = await this.authority.pendingDeletionClaims(plan);
      if (claims.length > 1_000) throw new Error("file_deletion_claim_limit_exceeded");
      for (const claim of claims) {
        throwIfAborted(signal);
        if (!deletionClaimMatches(plan, claim)) {
          await this.authority.releaseDeletion(claim, "deletion_claim_mismatch");
          continue;
        }
        const current = await this.store.stat(claim.key, signal);
        if (!current) {
          await this.authority.finalizeDeletion(claim);
          continue;
        }
        if (current.versionTag !== claim.objectVersionTag) {
          await this.authority.releaseDeletion(claim, "object_version_changed");
          await this.authority.recordOrphanDiscrepancy(plan, claim.key);
          continue;
        }
        const removed = await this.store.deleteIfMatch(claim.key, claim.objectVersionTag, signal);
        if (removed) await this.authority.finalizeDeletion(claim);
        else await this.authority.releaseDeletion(claim, "conditional_delete_failed");
      }
    }
    return this.authority.reconcile(plan, job.kind);
  }
}

export const createFileProcessingHandler = (
  store: ObjectStore,
  scanner: MalwareScanner,
  extractor: TextExtractor,
  authority: FileAuthority,
): FileProcessingHandler =>
  markReviewedHandler(new FileProcessingHandler(store, scanner, extractor, authority), [
    "file.scan",
    "file.extract",
    "file.cleanup",
  ]);

export class InMemoryObjectStore implements ObjectStore {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "in-memory-object-store";
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  readonly deletions: string[] = [];

  async *readStream(key: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    throwIfAborted(signal);
    this.reads.push(key);
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("object_not_found");
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      throwIfAborted(signal);
      yield bytes.slice(offset, Math.min(bytes.length, offset + chunkSize));
    }
  }

  async writeClean(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    this.objects.set(key, bytes.slice());
    return key;
  }

  async stat(key: string, signal: AbortSignal): Promise<ObjectVersion | undefined> {
    throwIfAborted(signal);
    const bytes = this.objects.get(key);
    return bytes ? { versionTag: createHash("sha256").update(bytes).digest("hex") } : undefined;
  }

  async deleteIfMatch(key: string, versionTag: string, signal: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    const current = await this.stat(key, signal);
    if (!current || current.versionTag !== versionTag) return false;
    this.deletions.push(key);
    this.objects.delete(key);
    return true;
  }

  async *list(prefix: string, signal: AbortSignal): AsyncIterable<string> {
    throwIfAborted(signal);
    for (const key of this.objects.keys()) {
      throwIfAborted(signal);
      if (key.startsWith(prefix)) yield key;
    }
  }
}
