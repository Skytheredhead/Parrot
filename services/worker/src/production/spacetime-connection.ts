import type {
  AuthenticatedSpacetimeWorkerTransport,
  SpacetimeWorkerQuery,
  SpacetimeWorkerReducer,
  SpacetimeWorkerView,
} from "./spacetime-worker.js";

const GENERATED_BINDINGS_PACKAGE = "@project-conversation/db-bindings";

interface GeneratedConnection {
  readonly db: Record<string, { iter(): IterableIterator<unknown> }>;
  readonly reducers: Record<string, (input: Readonly<Record<string, unknown>>) => Promise<void>>;
  subscriptionBuilder(): {
    onApplied(callback: () => void): GeneratedSubscriptionBuilder;
    onError(callback: () => void): GeneratedSubscriptionBuilder;
    subscribe(sql: readonly string[]): { unsubscribe(): void };
  };
  disconnect(): void;
}

interface GeneratedSubscriptionBuilder {
  onApplied(callback: () => void): GeneratedSubscriptionBuilder;
  onError(callback: () => void): GeneratedSubscriptionBuilder;
  subscribe(sql: readonly string[]): { unsubscribe(): void };
}

interface GeneratedBuilder {
  withUri(uri: string): GeneratedBuilder;
  withDatabaseName(databaseName: string): GeneratedBuilder;
  withToken(token: string): GeneratedBuilder;
  onConnect(
    callback: (connection: GeneratedConnection, identity: unknown) => void,
  ): GeneratedBuilder;
  onConnectError(callback: (context: unknown, error: Error) => void): GeneratedBuilder;
  onDisconnect(callback: (context: unknown, error?: Error) => void): GeneratedBuilder;
  build(): GeneratedConnection;
}

interface GeneratedBindingsModule {
  readonly DbConnection: { builder(): GeneratedBuilder };
}

const VIEW_ACCESSORS: Readonly<Record<SpacetimeWorkerView, string>> = Object.freeze({
  pending_outbox_work: "pendingOutboxWork",
  pending_post_search_documents: "pendingPostSearchDocuments",
  pending_workspace_export_plans: "pendingWorkspaceExportPlans",
  pending_workspace_export_cleanup_plans: "pendingWorkspaceExportCleanupPlans",
  pending_notification_delivery_plans: "pendingNotificationDeliveryPlans",
  pending_notification_digest_schedules: "pendingNotificationDigestSchedules",
  pending_notification_digest_plans: "pendingNotificationDigestPlans",
  file_processing_plans: "fileProcessingPlans",
  agent_work_queue: "agentWorkQueue",
  agent_context_candidates: "agentContextCandidates",
  service_agent_execution_plans: "serviceAgentExecutionPlans",
  service_agent_run_progress: "serviceAgentRunProgress",
  service_agent_provider_dispatches: "serviceAgentProviderDispatches",
  service_worker_effects: "serviceWorkerEffects",
  service_agent_approval_bindings: "serviceAgentApprovalBindings",
  service_file_deletion_claims: "serviceFileDeletionClaims",
  service_file_processing_outcomes: "serviceFileProcessingOutcomes",
});

const REDUCER_ACCESSORS: Readonly<Record<SpacetimeWorkerReducer, string>> = Object.freeze({
  claim_outbox_job: "claimOutboxJob",
  recover_outbox_job: "recoverOutboxJob",
  heartbeat_outbox_job: "heartbeatOutboxJob",
  complete_outbox_job: "completeOutboxJob",
  complete_workspace_export: "completeWorkspaceExport",
  complete_workspace_export_cleanup: "completeWorkspaceExportCleanup",
  authorize_notification_delivery: "authorizeNotificationDelivery",
  claim_notification_digests: "claimNotificationDigests",
  authorize_notification_digest: "authorizeNotificationDigest",
  record_notification_digest_outcome: "recordNotificationDigestOutcome",
  service_claim_agent_execution: "serviceClaimAgentExecution",
  service_transition_agent_run: "serviceTransitionAgentRun",
  service_save_agent_progress: "serviceSaveAgentProgress",
  service_append_agent_checkpoint: "serviceAppendAgentCheckpoint",
  service_record_agent_provider_dispatch: "serviceRecordAgentProviderDispatch",
  service_commit_agent_final: "serviceCommitAgentFinal",
  heartbeat_agent_run: "heartbeatAgentRun",
  record_agent_context_post: "recordAgentContextPost",
  record_agent_context_contribution: "recordAgentContextContribution",
  service_prepare_agent_tool_call: "servicePrepareAgentToolCall",
  consume_agent_tool_approval: "consumeAgentToolApproval",
  service_acquire_worker_effect: "serviceAcquireWorkerEffect",
  service_update_worker_effect: "serviceUpdateWorkerEffect",
  register_clean_file_object: "registerCleanFileObject",
  record_file_scan_outcome: "recordFileScanOutcome",
  record_file_extraction: "recordFileExtraction",
  service_claim_file_deletion: "serviceClaimFileDeletion",
  service_finalize_file_deletion: "serviceFinalizeFileDeletion",
  service_release_file_deletion: "serviceReleaseFileDeletion",
  service_record_file_orphan: "serviceRecordFileOrphan",
});

export interface WorkosSpacetimeConnectionOptions {
  readonly uri: string;
  readonly databaseName: string;
  readonly bearerToken: string;
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly expectedBearerSubject: string;
  readonly expectedServiceIdentity: string;
  readonly connectTimeoutMs?: number;
}

interface JwtClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
}

const decodeClaims = (token: string): JwtClaims => {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("spacetime_workos_token_not_jwt");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("spacetime_workos_token_claims_invalid");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("spacetime_workos_token_claims_invalid");
  }
  const claims = value as Partial<JwtClaims>;
  if (
    typeof claims.iss !== "string" ||
    typeof claims.sub !== "string" ||
    (typeof claims.aud !== "string" &&
      (!Array.isArray(claims.aud) || claims.aud.some((item) => typeof item !== "string"))) ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp)
  ) {
    throw new Error("spacetime_workos_token_claims_invalid");
  }
  return claims as JwtClaims;
};

const identityString = (value: unknown): string => {
  if (typeof value === "object" && value !== null) {
    const hex = (value as { readonly toHexString?: unknown }).toHexString;
    if (typeof hex === "function") return String(hex.call(value));
  }
  return String(value ?? "");
};

const camel = (value: string): string =>
  value.replace(/_([a-z])/g, (_match, character: string) => character.toUpperCase());

const comparable = (value: unknown): unknown => {
  if (typeof value === "bigint") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null) {
    const micros = (value as { readonly microsSinceUnixEpoch?: unknown }).microsSinceUnixEpoch;
    if (typeof micros === "bigint") return Number(micros / 1_000n);
    const explicitTag = (value as { readonly tag?: unknown }).tag;
    if (typeof explicitTag === "string") return explicitTag;
    const keys = Object.keys(value);
    if (keys.length === 1) return keys[0];
    const hex = (value as { readonly toHexString?: unknown }).toHexString;
    if (typeof hex === "function") return String(hex.call(value));
  }
  return value;
};

const matches = (row: Readonly<Record<string, unknown>>, query: SpacetimeWorkerQuery): boolean => {
  for (const [rawField, expected] of Object.entries(query.where)) {
    if (rawField === "service_identity") continue; // The service view is already caller-scoped.
    if (rawField === "claimable_before_ms") {
      const state = String(comparable(row.state) ?? "").toLowerCase();
      const next = comparable(row.nextAttemptAt);
      const leaseUntil = comparable(row.leaseUntil);
      const expiredLease =
        state === "leased" && typeof leaseUntil === "number" && leaseUntil <= Number(expected);
      if (
        typeof next !== "number" ||
        next > Number(expected) ||
        (!["pending", "retry", "outcomeunknown", "outcome_unknown"].includes(state) &&
          !expiredLease)
      ) {
        return false;
      }
      continue;
    }
    const actual = comparable(row[camel(rawField)]);
    const normalizedExpected = comparable(expected);
    if (typeof actual === "bigint" || typeof normalizedExpected === "bigint") {
      if (BigInt(actual as bigint | number) !== BigInt(normalizedExpected as bigint | number)) {
        return false;
      }
    } else if (String(actual ?? "") !== String(normalizedExpected ?? "")) {
      return false;
    }
  }
  return true;
};

const abortError = (signal: AbortSignal): unknown =>
  signal.reason instanceof Error ? signal.reason : new Error("aborted");

/**
 * Creates the real generated-binding transport. The token is passed only to SpacetimeDB's
 * authenticated WebSocket builder and is never retained on the returned adapter.
 */
export const connectWorkosSpacetimeWorker = async (
  options: WorkosSpacetimeConnectionOptions,
  signal?: AbortSignal,
): Promise<AuthenticatedSpacetimeWorkerTransport> => {
  const claims = decodeClaims(options.bearerToken);
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (
    claims.iss !== options.expectedIssuer ||
    claims.sub !== options.expectedBearerSubject ||
    !audiences.includes(options.expectedAudience) ||
    claims.exp * 1_000 <= Date.now() + 30_000
  ) {
    throw new Error("spacetime_workos_token_binding_mismatch");
  }
  if (signal?.aborted) throw abortError(signal);
  const timeoutMs = options.connectTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("spacetime_connect_timeout_invalid");
  }

  let connected = false;
  let connection: GeneratedConnection | undefined;
  let subscription: { unsubscribe(): void } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let rejectPending: ((reason: unknown) => void) | undefined;
  const bindings = (await import(GENERATED_BINDINGS_PACKAGE)) as GeneratedBindingsModule;
  const ready = new Promise<GeneratedConnection>((resolve, reject) => {
    rejectPending = reject;
    const builder = bindings.DbConnection.builder()
      .withUri(options.uri)
      .withDatabaseName(options.databaseName)
      .withToken(options.bearerToken)
      .onConnect((candidate, identity) => {
        const authenticatedIdentity = identityString(identity);
        if (authenticatedIdentity !== options.expectedServiceIdentity) {
          candidate.disconnect();
          reject(new Error("spacetime_authenticated_identity_mismatch"));
          return;
        }
        const generatedDb = candidate.db as unknown as Record<string, { readonly iter?: unknown }>;
        const generatedReducers = candidate.reducers as unknown as Record<string, unknown>;
        for (const [view, accessor] of Object.entries(VIEW_ACCESSORS)) {
          if (typeof generatedDb[accessor]?.iter !== "function") {
            candidate.disconnect();
            reject(new Error(`spacetime_generated_view_missing:${view}`));
            return;
          }
        }
        for (const [reducer, accessor] of Object.entries(REDUCER_ACCESSORS)) {
          if (typeof generatedReducers[accessor] !== "function") {
            candidate.disconnect();
            reject(new Error(`spacetime_generated_reducer_missing:${reducer}`));
            return;
          }
        }
        connection = candidate;
        const sql = Object.keys(VIEW_ACCESSORS).map((view) => `SELECT * FROM ${view}`);
        subscription = candidate
          .subscriptionBuilder()
          .onApplied(() => {
            connected = true;
            resolve(candidate);
          })
          .onError(() => reject(new Error("spacetime_worker_subscription_failed")))
          .subscribe(sql);
      })
      .onDisconnect(() => {
        connected = false;
      })
      .onConnectError((_context, error) => reject(error));
    builder.build();
    timer = setTimeout(() => reject(new Error("spacetime_worker_connect_timeout")), timeoutMs);
    timer.unref?.();
  });
  const onAbort = (): void => rejectPending?.(abortError(signal as AbortSignal));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    connection = await ready;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  const db = connection.db;
  const reducers = connection.reducers;
  const transport: AuthenticatedSpacetimeWorkerTransport = {
    authentication: "workos_m2m_bearer",
    serviceIdentity: options.expectedServiceIdentity,
    bearerSubject: options.expectedBearerSubject,
    get connected() {
      return connected;
    },
    views: new Set(Object.keys(VIEW_ACCESSORS)),
    reducers: new Set(Object.keys(REDUCER_ACCESSORS)),
    async select(view, query, operationSignal) {
      if (operationSignal?.aborted) throw abortError(operationSignal);
      if (!connected) throw new Error("spacetime_worker_not_connected");
      const accessor = db[VIEW_ACCESSORS[view]];
      if (!accessor) throw new Error(`spacetime_generated_view_missing:${view}`);
      const rows: unknown[] = [];
      for (const value of accessor.iter()) {
        if (operationSignal?.aborted) throw abortError(operationSignal);
        if (matches(value as Readonly<Record<string, unknown>>, query)) rows.push(value);
        if (rows.length >= query.limit) break;
      }
      return rows;
    },
    async reduce(reducer, input, operationSignal) {
      if (operationSignal?.aborted) throw abortError(operationSignal);
      if (!connected) throw new Error("spacetime_worker_not_connected");
      const operation = reducers[REDUCER_ACCESSORS[reducer]];
      if (!operation) throw new Error(`spacetime_generated_reducer_missing:${reducer}`);
      await operation(input);
      if (operationSignal?.aborted) throw abortError(operationSignal);
    },
    async ready(operationSignal) {
      return connected && !operationSignal.aborted;
    },
    async close() {
      connected = false;
      subscription?.unsubscribe();
      connection?.disconnect();
    },
  };
  return transport;
};
