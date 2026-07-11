import { createHash } from "node:crypto";
import type { AuthorizationGate } from "./adapters.js";
import type {
  Clock,
  EffectClaim,
  EffectResult,
  JsonValue,
  OutboxJob,
  ReconciliationResult,
} from "./domain.js";
import { ProviderTimeoutError, errorCode } from "./domain.js";
import type { EffectLedger, JobHandler, RuntimeAdapter } from "./outbox.js";
import { markReviewedHandler } from "./reviewed-handlers.js";
import type { OpenTelemetry, StructuredLogger } from "./telemetry.js";

export type AgentRunState =
  | "queued"
  | "authorizing"
  | "collecting_context"
  | "running"
  | "awaiting_approval"
  | "executing_tool"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired"
  | "revoked";

export interface AgentBudgets {
  readonly maxContextBytes: number;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
  readonly maxCostMicros: number;
  readonly maxOutputBytes?: number;
  readonly maxToolResultBytes?: number;
  readonly maxTotalToolResultBytes?: number;
  readonly maxProviderInputBytes?: number;
  readonly maxTotalProviderInputBytes?: number;
}

export interface ContextMetadata {
  readonly resourceId: string;
  readonly revision: number;
  readonly sourceType: string;
  readonly trustClass: "workspace_untrusted" | "tool_untrusted" | "system_trusted";
  readonly redactions: readonly string[];
}

export interface ContextSource extends ContextMetadata {
  readonly content: string;
}

export interface ContextManifestEntry extends ContextMetadata {
  readonly bytes: number;
  readonly sha256: string;
  readonly retrievedAt: number;
}

export interface ContextBundle {
  readonly manifest: readonly ContextManifestEntry[];
  readonly structuredContent: string;
  readonly bytes: number;
}

export interface AgentContextSource extends RuntimeAdapter {
  list(runId: string): Promise<readonly ContextMetadata[]>;
  read(
    runId: string,
    metadata: ContextMetadata,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface AgentUsage {
  readonly outputTokens: number;
  readonly costMicros: number;
}

export type AgentStep =
  | { readonly type: "final"; readonly text: string; readonly usage: AgentUsage }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly toolName: string;
      readonly toolVersion: string;
      readonly arguments: JsonValue;
      /** Advisory only. The registry policy is authoritative and mismatches are rejected. */
      readonly effectClass?: "read" | "external" | "destructive";
      readonly approvalNonce?: string;
      readonly usage: AgentUsage;
    };

export interface AgentProviderInput {
  readonly runId: string;
  readonly context: string;
  readonly toolResults: readonly JsonValue[];
  readonly remaining: AgentBudgets;
}

export interface AgentProvider extends RuntimeAdapter {
  /** Returns a previously completed request so a response/save crash cannot repeat generation. */
  reconcile(
    requestId: string,
    inputFingerprint: string,
    signal: AbortSignal,
  ): Promise<AgentStep | undefined>;
  /** requestId is a durable provider idempotency key bound to inputFingerprint. */
  next(
    requestId: string,
    inputFingerprint: string,
    /** Exact canonical JSON wire payload; its UTF-8 length is the enforced provider-input cost. */
    canonicalInput: string,
    signal: AbortSignal,
  ): Promise<AgentStep>;
  cancel?(runId: string): Promise<void>;
}

export interface AgentRunControl {
  readonly runId: string;
  readonly workspaceId: string;
  readonly authorizationEpoch: number;
  readonly currentAuthorizationEpoch: number;
  readonly installationEnabled: boolean;
  readonly cancelRequested: boolean;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: number;
  /** Exact outbox effect request that acquired the current execution lease. */
  readonly executionRequestId?: string;
  readonly state: AgentRunState;
  readonly budgets: AgentBudgets;
}

export interface AgentCheckpoint {
  readonly sequence: number;
  readonly state: AgentRunState;
  readonly code: string;
  readonly details?: JsonValue;
  readonly createdAt: number;
}

export interface AgentRunProgress {
  readonly sequence: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly toolCalls: number;
  readonly toolResults: readonly JsonValue[];
  readonly providerInputBytes?: number;
  readonly pendingStep?: AgentStep;
}

export interface ProviderContextBinding {
  readonly resourceId: string;
  readonly revision: number;
  readonly sha256: string;
}

export interface ProviderDispatchFence {
  readonly runId: string;
  /** Stable one-based model turn within the run. */
  readonly providerSequence: number;
  readonly leaseGeneration: number;
  readonly authorizationEpoch: number;
  readonly requestId: string;
  readonly inputFingerprint: string;
  /** Exact immutable UTF-8 payload handed to the provider adapter. */
  readonly canonicalInput: string;
  readonly inputBytes: number;
  readonly contextBindingHash: string;
  readonly context: readonly ProviderContextBinding[];
}

const emptyProgress = (): AgentRunProgress => ({
  sequence: 0,
  outputTokens: 0,
  costMicros: 0,
  toolCalls: 0,
  toolResults: [],
  providerInputBytes: 0,
});

export interface AgentRunRepository extends RuntimeAdapter {
  /** Atomically claims or reclaims a durable AgentRun for this exact outbox request. */
  claimExecution(input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly requestId: string;
    readonly leaseMs: number;
  }): Promise<
    | { readonly type: "claimed"; readonly control: AgentRunControl }
    | { readonly type: "busy"; readonly control: AgentRunControl }
    | { readonly type: "terminal"; readonly control: AgentRunControl }
  >;
  control(runId: string): Promise<AgentRunControl>;
  transition(
    runId: string,
    leaseGeneration: number,
    state: AgentRunState,
    code: string,
  ): Promise<void>;
  saveManifest(
    runId: string,
    leaseGeneration: number,
    manifest: readonly ContextManifestEntry[],
  ): Promise<void>;
  checkpoint(runId: string, leaseGeneration: number, checkpoint: AgentCheckpoint): Promise<void>;
  progress(runId: string, leaseGeneration: number): Promise<AgentRunProgress>;
  saveProgress(runId: string, leaseGeneration: number, progress: AgentRunProgress): Promise<void>;
  /** Renews only the exact current run lease and returns its authoritative expiry. */
  heartbeatLease(runId: string, leaseGeneration: number, leaseExpiresAt: number): Promise<number>;
  /** Loads the immutable dispatch for a stable run/model-turn before context can be recollected. */
  providerDispatch(
    runId: string,
    providerSequence: number,
  ): Promise<ProviderDispatchFence | undefined>;
  /** Atomically checks lease/cancel/epoch and durably records the exact dispatch binding. */
  recordProviderDispatch(input: ProviderDispatchFence): Promise<"created" | "existing">;
  commitFinalAndSucceed(input: {
    readonly runId: string;
    readonly leaseGeneration: number;
    readonly authorizationEpoch: number;
    readonly text: string;
    readonly progress: AgentRunProgress;
  }): Promise<void>;
}

export interface ApprovalRecord {
  readonly nonce: string;
  readonly runId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly argumentsHash: string;
  readonly effectClass: string;
  readonly expiresAt: number;
  readonly approved: boolean;
  readonly used: boolean;
}

export interface ApprovalStore extends RuntimeAdapter {
  consumeExact(
    expected: Omit<ApprovalRecord, "expiresAt" | "approved" | "used">,
    effectKey: string,
    now: number,
  ): Promise<boolean>;
}

export type ToolEffectClass = "read" | "external" | "destructive";

export interface AgentTool extends RuntimeAdapter {
  readonly name: string;
  readonly version: string;
  readonly effectClass: ToolEffectClass;
  readonly approvalPolicy: "never" | "required";
  readonly retryWhenReconciledNotFound: boolean;
  normalizeArguments(argumentsValue: JsonValue): JsonValue;
  execute(argumentsValue: JsonValue, effectKey: string, signal: AbortSignal): Promise<EffectResult>;
  reconcile(effectKey: string, signal: AbortSignal): Promise<ReconciliationResult>;
}

export class AgentToolRegistry {
  readonly #tools = new Map<string, AgentTool>();
  #sealed = false;

  register(tool: AgentTool): this {
    if (this.#sealed) throw new Error("tool_registry_sealed");
    if (tool.effectClass !== "read" && tool.approvalPolicy !== "required") {
      throw new Error("unsafe_tool_approval_policy");
    }
    const key = `${tool.name}@${tool.version}`;
    if (this.#tools.has(key)) throw new Error("duplicate_tool_registration");
    const snapshot: AgentTool = Object.freeze({
      adapterKind: tool.adapterKind,
      adapterName: tool.adapterName,
      ...(typeof tool.assertProductionReady === "function"
        ? { assertProductionReady: tool.assertProductionReady.bind(tool) }
        : {}),
      name: tool.name,
      version: tool.version,
      effectClass: tool.effectClass,
      approvalPolicy: tool.approvalPolicy,
      retryWhenReconciledNotFound: tool.retryWhenReconciledNotFound,
      normalizeArguments: tool.normalizeArguments.bind(tool),
      execute: tool.execute.bind(tool),
      reconcile: tool.reconcile.bind(tool),
    });
    this.#tools.set(key, snapshot);
    return this;
  }

  /** Permanently closes the registry after its production graph has been validated. */
  seal(): this {
    this.#sealed = true;
    Object.freeze(this);
    return this;
  }

  isSealed(): boolean {
    return this.#sealed;
  }

  get(name: string, version: string): AgentTool {
    const tool = this.#tools.get(`${name}@${version}`);
    if (!tool) throw new AgentError("tool_not_allowed");
    return tool;
  }

  entries(): readonly AgentTool[] {
    return Object.freeze([...this.#tools.values()]);
  }
}

const MAX_JSON_NODES = 10_000;

function assertJsonValue(
  value: unknown,
  depth = 0,
  counter: { nodes: number } = { nodes: 0 },
): asserts value is JsonValue {
  counter.nodes += 1;
  if (counter.nodes > MAX_JSON_NODES) throw new AgentError("tool_arguments_too_large");
  if (depth > 32) throw new AgentError("tool_arguments_too_deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new AgentError("tool_arguments_invalid_number");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new AgentError("tool_arguments_too_large");
    for (const item of value) assertJsonValue(item, depth + 1, counter);
    return;
  }
  if (typeof value !== "object") throw new AgentError("tool_arguments_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentError("tool_arguments_invalid_prototype");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10_000) throw new AgentError("tool_arguments_too_large");
  for (const [key, item] of entries) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new AgentError("tool_arguments_unsafe_key");
    }
    assertJsonValue(item, depth + 1, counter);
  }
}

const canonicalUnchecked = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalUnchecked).join(",")}]`;
  const objectValue = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalUnchecked(objectValue[key] ?? null)}`)
    .join(",")}}`;
};

const canonical = (value: JsonValue): string => {
  assertJsonValue(value);
  return canonicalUnchecked(value);
};

export const argumentsHash = (value: JsonValue): string => {
  assertJsonValue(value);
  return createHash("sha256").update(canonical(value)).digest("hex");
};

export class InMemoryApprovalStore implements ApprovalStore {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "in-memory-approval-store";
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly consumedByEffect = new Map<string, string>();

  add(record: ApprovalRecord): void {
    this.approvals.set(record.nonce, structuredClone(record));
  }

  async consumeExact(
    expected: Omit<ApprovalRecord, "expiresAt" | "approved" | "used">,
    effectKey: string,
    now: number,
  ): Promise<boolean> {
    const record = this.approvals.get(expected.nonce);
    const exact =
      record?.approved === true &&
      record.expiresAt > now &&
      record.runId === expected.runId &&
      record.callId === expected.callId &&
      record.toolName === expected.toolName &&
      record.toolVersion === expected.toolVersion &&
      record.argumentsHash === expected.argumentsHash &&
      record.effectClass === expected.effectClass;
    if (!exact || !record) return false;
    if (record.used) return this.consumedByEffect.get(record.nonce) === effectKey;
    this.approvals.set(record.nonce, { ...record, used: true });
    this.consumedByEffect.set(record.nonce, effectKey);
    return true;
  }
}

class AgentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentError";
  }
}

class RunCanceledError extends AgentError {
  constructor() {
    super("run_canceled");
    this.name = "RunCanceledError";
  }
}

class RunRevokedError extends AgentError {
  constructor() {
    super("run_revoked");
    this.name = "RunRevokedError";
  }
}

class StaleRunLeaseError extends AgentError {
  constructor() {
    super("stale_run_lease");
    this.name = "StaleRunLeaseError";
  }
}

class BudgetExceededError extends AgentError {
  constructor(kind: string) {
    super(`budget_exceeded_${kind}`);
    this.name = "BudgetExceededError";
  }
}

class UnknownToolOutcomeError extends AgentError {
  constructor() {
    super("tool_effect_outcome_unknown");
    this.name = "UnknownToolOutcomeError";
  }
}

export interface AgentRunLoopOptions {
  readonly providerTimeoutMs: number;
  readonly toolTimeoutMs?: number;
  readonly controlPollMs?: number;
  readonly runLeaseMs?: number;
  readonly defaultMaxOutputBytes?: number;
  readonly defaultMaxToolResultBytes?: number;
  readonly defaultMaxTotalToolResultBytes?: number;
  readonly defaultMaxProviderInputBytes?: number;
  readonly defaultMaxTotalProviderInputBytes?: number;
}

export class AgentRunLoop {
  constructor(
    private readonly options: AgentRunLoopOptions,
    private readonly clock: Clock,
    private readonly repository: AgentRunRepository,
    private readonly contextSource: AgentContextSource,
    private readonly provider: AgentProvider,
    private readonly tools: AgentToolRegistry,
    private readonly approvals: ApprovalStore,
    private readonly authorization: AuthorizationGate,
    private readonly effects: EffectLedger,
    private readonly logger: StructuredLogger,
    private readonly telemetry: OpenTelemetry,
  ) {}

  repositoryAdapter(): AgentRunRepository {
    return this.repository;
  }

  clockAdapter(): Clock {
    return this.clock;
  }

  executionLeaseMs(): number {
    return this.runLeaseMs();
  }

  handlerDependencies(): readonly RuntimeAdapter[] {
    return Object.freeze([
      this.repository,
      this.contextSource,
      this.provider,
      this.approvals,
      this.authorization,
      this.effects,
      ...this.tools.entries(),
    ]);
  }

  async execute(runId: string, leaseGeneration: number): Promise<void> {
    const initial = await this.repository.control(runId);
    let progress = await this.repository.progress(runId, leaseGeneration);
    const checkpoint = async (
      state: AgentRunState,
      code: string,
      details?: JsonValue,
    ): Promise<void> => {
      progress = { ...progress, sequence: progress.sequence + 1 };
      await this.repository.checkpoint(runId, leaseGeneration, {
        sequence: progress.sequence,
        state,
        code,
        ...(details !== undefined ? { details } : {}),
        createdAt: this.clock.now(),
      });
      await this.repository.saveProgress(runId, leaseGeneration, progress);
    };

    await this.telemetry.span(
      "worker.agent.run",
      { "run.id": runId, "workspace.id": initial.workspaceId, "lease.generation": leaseGeneration },
      async (span) => {
        try {
          await this.assertCurrent(initial, leaseGeneration);
          await this.repository.transition(runId, leaseGeneration, "authorizing", "worker_claimed");
          await this.assertCurrent(initial, leaseGeneration);
          const recoveredDispatch = await this.repository.providerDispatch(
            runId,
            progress.toolResults.length + 1,
          );
          let context: ContextBundle;
          if (recoveredDispatch) {
            context = this.contextFromDispatch(recoveredDispatch, initial, progress);
          } else {
            await this.repository.transition(
              runId,
              leaseGeneration,
              "collecting_context",
              "context_started",
            );
            context = await this.collectContext(initial, leaseGeneration);
            await this.repository.saveManifest(runId, leaseGeneration, context.manifest);
            await checkpoint("collecting_context", "context_collected", { bytes: context.bytes });
          }
          await this.assertCurrent(initial, leaseGeneration);
          await this.repository.transition(runId, leaseGeneration, "running", "provider_started");

          while (true) {
            await this.assertCurrent(initial, leaseGeneration);
            let step = progress.pendingStep;
            if (!step) {
              const currentProviderSequence = progress.toolResults.length + 1;
              const dispatch =
                recoveredDispatch?.providerSequence === currentProviderSequence
                  ? recoveredDispatch
                  : undefined;
              await this.reauthorizeContext(initial, leaseGeneration, context.manifest);
              const providerInput: AgentProviderInput = {
                runId,
                context: context.structuredContent,
                toolResults: progress.toolResults,
                remaining: this.remainingBudgets(initial.budgets, context.bytes, progress),
              };
              const computedProviderInput = this.canonicalProviderInput(providerInput);
              if (dispatch && computedProviderInput !== dispatch.canonicalInput) {
                throw new AgentError("provider_dispatch_input_conflict");
              }
              const canonicalProviderInput = dispatch?.canonicalInput ?? computedProviderInput;
              const providerInputBytes =
                dispatch?.inputBytes ?? Buffer.byteLength(canonicalProviderInput, "utf8");
              this.assertProviderInputBudget(initial.budgets, progress, providerInputBytes);
              step = await this.providerStep(
                providerInput,
                canonicalProviderInput,
                providerInputBytes,
                context.manifest,
                progress,
                initial,
                leaseGeneration,
                dispatch,
              );
              this.assertProviderStep(step, initial.budgets);
              const nextToolCalls = progress.toolCalls + (step.type === "tool_call" ? 1 : 0);
              progress = {
                ...progress,
                outputTokens: progress.outputTokens + step.usage.outputTokens,
                costMicros: progress.costMicros + step.usage.costMicros,
                toolCalls: nextToolCalls,
                providerInputBytes: (progress.providerInputBytes ?? 0) + providerInputBytes,
                pendingStep: structuredClone(step),
              };
              this.assertBudgets(initial.budgets, context.bytes, progress);
              await this.repository.saveProgress(runId, leaseGeneration, progress);
            }

            if (step.type === "final") {
              const outputBytes = Buffer.byteLength(step.text, "utf8");
              if (outputBytes > this.maxOutputBytes(initial.budgets)) {
                throw new BudgetExceededError("output_bytes");
              }
              await checkpoint("running", "final_prepared", {
                outputTokens: progress.outputTokens,
                costMicros: progress.costMicros,
                outputBytes,
              });
              await this.assertCurrent(initial, leaseGeneration);
              progress = { ...progress };
              delete (progress as { pendingStep?: AgentStep }).pendingStep;
              await this.repository.commitFinalAndSucceed({
                runId,
                leaseGeneration,
                authorizationEpoch: initial.authorizationEpoch,
                text: step.text,
                progress,
              });
              this.logger.log("info", "agent.run.succeeded", {
                traceId: span.traceId,
                spanId: span.spanId,
                workspaceId: initial.workspaceId,
                runId,
                outcome: "succeeded",
                attributes: {
                  outputTokens: progress.outputTokens,
                  toolCalls: progress.toolCalls,
                  costMicros: progress.costMicros,
                },
              });
              return;
            }

            const result = await this.executeTool(
              initial,
              leaseGeneration,
              step,
              this.maxToolResultBytes(initial.budgets),
              checkpoint,
            );
            assertJsonValue(result);
            const resultBytes = Buffer.byteLength(canonical(result), "utf8");
            if (resultBytes > this.maxToolResultBytes(initial.budgets)) {
              throw new BudgetExceededError("tool_result_bytes");
            }
            const totalResultBytes = Buffer.byteLength(
              canonical([...progress.toolResults, result]),
              "utf8",
            );
            if (totalResultBytes > this.maxTotalToolResultBytes(initial.budgets)) {
              throw new BudgetExceededError("total_tool_result_bytes");
            }
            progress = {
              ...progress,
              toolResults: [...progress.toolResults, result],
            };
            delete (progress as { pendingStep?: AgentStep }).pendingStep;
            await this.repository.saveProgress(runId, leaseGeneration, progress);
            await this.repository.transition(
              runId,
              leaseGeneration,
              "running",
              "tool_result_recorded",
            );
          }
        } catch (error) {
          await this.cancelProvider(runId);
          if (error instanceof StaleRunLeaseError) {
            this.logger.log("warn", "agent.run.lease_lost", {
              traceId: span.traceId,
              spanId: span.spanId,
              workspaceId: initial.workspaceId,
              runId,
              outcome: "ownership_transferred",
            });
            return;
          }
          const state: AgentRunState =
            error instanceof RunCanceledError
              ? "canceled"
              : error instanceof RunRevokedError
                ? "revoked"
                : "failed";
          const code = this.stableErrorCode(error);
          try {
            await checkpoint(state, code);
            await this.repository.transition(runId, leaseGeneration, state, code);
          } catch (writeError) {
            if (
              !(writeError instanceof StaleRunLeaseError) &&
              this.stableErrorCode(writeError) !== "stale_run_lease"
            ) {
              throw writeError;
            }
            return;
          }
          this.logger.log(state === "failed" ? "error" : "warn", "agent.run.terminal", {
            traceId: span.traceId,
            spanId: span.spanId,
            workspaceId: initial.workspaceId,
            runId,
            outcome: state,
            attributes: { code },
          });
        }
      },
    );
  }

  private async collectContext(
    initial: AgentRunControl,
    leaseGeneration: number,
  ): Promise<ContextBundle> {
    await this.assertCurrent(initial, leaseGeneration);
    const metadataList = await this.runAbortable(
      initial,
      leaseGeneration,
      this.options.providerTimeoutMs,
      () => this.contextSource.list(initial.runId),
    );
    if (metadataList.length > 1_000) throw new BudgetExceededError("context_items");
    const manifest: ContextManifestEntry[] = [];
    const structured: Array<ContextMetadata & { readonly content: string }> = [];
    let bytes = 0;
    for (const metadata of metadataList) {
      if (
        !/^[A-Za-z0-9._:-]{1,256}$/.test(metadata.resourceId) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(metadata.sourceType) ||
        !Number.isSafeInteger(metadata.revision) ||
        metadata.revision < 0 ||
        metadata.redactions.length > 100 ||
        metadata.redactions.some((value) => value.length > 128)
      ) {
        throw new AgentError("context_metadata_invalid");
      }
      await this.assertCurrent(initial, leaseGeneration);
      const allowed = await this.authorization.canPerform({
        workspaceId: initial.workspaceId,
        operation: "agent.context.read",
        resourceId: metadata.resourceId,
        authorizationEpoch: initial.authorizationEpoch,
      });
      if (!allowed) throw new RunRevokedError();
      const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
      bytes += metadataBytes;
      const remaining = initial.budgets.maxContextBytes - bytes;
      if (remaining < 0) throw new BudgetExceededError("context_bytes");
      const content = await this.runAbortable(
        initial,
        leaseGeneration,
        this.options.providerTimeoutMs,
        (signal) => this.contextSource.read(initial.runId, metadata, remaining, signal),
      );
      await this.assertCurrent(initial, leaseGeneration);
      const stillAllowed = await this.authorization.canPerform({
        workspaceId: initial.workspaceId,
        operation: "agent.context.read",
        resourceId: metadata.resourceId,
        authorizationEpoch: initial.authorizationEpoch,
      });
      if (!stillAllowed) throw new RunRevokedError();
      const sourceBytes = Buffer.byteLength(content, "utf8");
      bytes += sourceBytes;
      if (bytes > initial.budgets.maxContextBytes) throw new BudgetExceededError("context_bytes");
      manifest.push({
        ...metadata,
        bytes: sourceBytes,
        sha256: createHash("sha256").update(content).digest("hex"),
        retrievedAt: this.clock.now(),
      });
      structured.push({ ...metadata, content });
    }
    const structuredContent = JSON.stringify(structured);
    const serializedBytes = Buffer.byteLength(structuredContent, "utf8");
    if (serializedBytes > initial.budgets.maxContextBytes) {
      throw new BudgetExceededError("context_bytes");
    }
    return { manifest, structuredContent, bytes: serializedBytes };
  }

  private async executeTool(
    initial: AgentRunControl,
    leaseGeneration: number,
    step: Extract<AgentStep, { readonly type: "tool_call" }>,
    maxResultBytes: number,
    checkpoint: (state: AgentRunState, code: string, details?: JsonValue) => Promise<void>,
  ): Promise<JsonValue> {
    await this.assertCurrent(initial, leaseGeneration);
    const tool = this.tools.get(step.toolName, step.toolVersion);
    if (step.effectClass !== undefined && step.effectClass !== tool.effectClass) {
      throw new AgentError("tool_policy_mismatch");
    }
    assertJsonValue(step.arguments);
    const normalizedArguments = tool.normalizeArguments(structuredClone(step.arguments));
    assertJsonValue(normalizedArguments);
    if (Buffer.byteLength(canonical(normalizedArguments), "utf8") > 256 * 1024) {
      throw new AgentError("tool_arguments_too_large");
    }
    const hash = argumentsHash(normalizedArguments);
    const identity = `${initial.runId}:${step.callId}:${tool.name}@${tool.version}:${tool.effectClass}:${hash}`;
    const identityFingerprint = createHash("sha256").update(identity).digest("hex");
    const effectKey = `agent-tool:${identityFingerprint}`;
    const existing = await this.effects.get(effectKey);
    if (existing?.state === "succeeded") return existing.result ?? null;
    if (existing?.state === "failed_permanent") throw new AgentError("tool_failed_permanent");

    if (tool.approvalPolicy === "required") {
      await this.repository.transition(
        initial.runId,
        leaseGeneration,
        "awaiting_approval",
        "approval_required",
      );
      if (!step.approvalNonce) throw new AgentError("approval_missing");
      const approved = await this.approvals.consumeExact(
        {
          nonce: step.approvalNonce,
          runId: initial.runId,
          callId: step.callId,
          toolName: tool.name,
          toolVersion: tool.version,
          argumentsHash: hash,
          effectClass: tool.effectClass,
        },
        effectKey,
        this.clock.now(),
      );
      if (!approved) throw new AgentError("approval_invalid_or_expired");
    }
    await this.assertCurrent(initial, leaseGeneration);
    const allowed = await this.authorization.canPerform({
      workspaceId: initial.workspaceId,
      operation: `agent.tool.${tool.name}`,
      resourceId: initial.runId,
      authorizationEpoch: initial.authorizationEpoch,
    });
    if (!allowed) throw new RunRevokedError();
    await this.repository.transition(
      initial.runId,
      leaseGeneration,
      "executing_tool",
      "tool_started",
    );

    const acquisition = await this.effects.acquire({
      effectKey,
      identityFingerprint,
      payloadFingerprint: hash,
      ownerId: identity,
      ownerGeneration: leaseGeneration,
      leaseExpiresAt:
        this.clock.now() +
        this.effectLeaseMs(this.options.toolTimeoutMs ?? this.options.providerTimeoutMs),
      allowTakeover: true,
    });
    if (!acquisition.acquired) {
      if (acquisition.record.state === "succeeded") return acquisition.record.result ?? null;
      throw new UnknownToolOutcomeError();
    }
    const claim = acquisition.claim;
    if (
      acquisition.previousState === "started" ||
      acquisition.previousState === "outcome_unknown"
    ) {
      let reconciliation: ReconciliationResult;
      try {
        reconciliation = await this.runAbortable(
          initial,
          leaseGeneration,
          this.options.toolTimeoutMs ?? this.options.providerTimeoutMs,
          (signal) => tool.reconcile(effectKey, signal),
          claim,
        );
      } catch (error) {
        if (error instanceof ProviderTimeoutError) {
          await this.effects.outcomeUnknown(claim);
          await checkpoint("executing_tool", "tool_effect_outcome_unknown", { effectKey });
          throw new UnknownToolOutcomeError();
        }
        throw error;
      }
      await this.assertCurrent(initial, leaseGeneration);
      if (reconciliation.type === "succeeded") {
        await this.effects.succeeded(
          claim,
          reconciliation.providerReference,
          reconciliation.result,
        );
        return reconciliation.result ?? null;
      }
      if (
        reconciliation.type === "unknown" ||
        acquisition.previousState === "outcome_unknown" ||
        !tool.retryWhenReconciledNotFound
      ) {
        await this.effects.outcomeUnknown(claim);
        await checkpoint("executing_tool", "tool_effect_outcome_unknown", { effectKey });
        throw new UnknownToolOutcomeError();
      }
    }

    let result: EffectResult;
    try {
      result = await this.runAbortable(
        initial,
        leaseGeneration,
        this.options.toolTimeoutMs ?? this.options.providerTimeoutMs,
        (signal) => tool.execute(normalizedArguments, effectKey, signal),
        claim,
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        await this.effects.outcomeUnknown(claim);
        await checkpoint("executing_tool", "tool_effect_outcome_unknown", { effectKey });
        throw new UnknownToolOutcomeError();
      }
      throw error;
    }
    await this.assertCurrent(initial, leaseGeneration);
    return this.applyToolResult(claim, effectKey, step.callId, result, maxResultBytes, checkpoint);
  }

  private async applyToolResult(
    claim: EffectClaim,
    effectKey: string,
    callId: string,
    result: EffectResult,
    maxResultBytes: number,
    checkpoint: (state: AgentRunState, code: string, details?: JsonValue) => Promise<void>,
  ): Promise<JsonValue> {
    if (result.type === "succeeded") {
      const value = result.result ?? null;
      assertJsonValue(value);
      if (Buffer.byteLength(canonical(value), "utf8") > maxResultBytes) {
        await this.effects.failedPermanent(claim);
        throw new BudgetExceededError("tool_result_bytes");
      }
      await this.effects.succeeded(claim, result.providerReference, value);
      await checkpoint("executing_tool", "tool_succeeded", { effectKey, callId });
      return value;
    }
    if (result.type === "outcome_unknown") {
      await this.effects.outcomeUnknown(claim);
      await checkpoint("executing_tool", "tool_effect_outcome_unknown", { effectKey });
      throw new UnknownToolOutcomeError();
    }
    if (result.type === "permanent_failure") await this.effects.failedPermanent(claim);
    throw new AgentError(
      `tool_${result.type}_${result.code}`.replace(/[^a-z0-9_]/gi, "_").slice(0, 80),
    );
  }

  private async providerStep(
    input: AgentProviderInput,
    canonicalInput: string,
    inputBytes: number,
    manifest: readonly ContextManifestEntry[],
    progress: AgentRunProgress,
    initial: AgentRunControl,
    leaseGeneration: number,
    recoveredDispatch?: ProviderDispatchFence,
  ): Promise<AgentStep> {
    const providerSequence = progress.toolResults.length + 1;
    const computedInputFingerprint = createHash("sha256")
      .update(this.provider.adapterName)
      .update("\0")
      .update(canonicalInput)
      .digest("hex");
    const inputFingerprint = recoveredDispatch?.inputFingerprint ?? computedInputFingerprint;
    if (inputFingerprint !== computedInputFingerprint) {
      throw new AgentError("provider_dispatch_fingerprint_conflict");
    }
    const computedRequestId = `provider:${createHash("sha256")
      .update(`${initial.runId}\0${providerSequence}\0${inputFingerprint}`)
      .digest("hex")}`;
    const requestId = recoveredDispatch?.requestId ?? computedRequestId;
    if (requestId !== computedRequestId) throw new AgentError("provider_dispatch_request_conflict");
    const contextBinding: ProviderContextBinding[] = manifest
      .map(({ resourceId, revision, sha256 }) => ({ resourceId, revision, sha256 }))
      .sort(
        (left, right) =>
          left.resourceId.localeCompare(right.resourceId) || left.revision - right.revision,
      );
    const contextBindingHash = createHash("sha256")
      .update(JSON.stringify(contextBinding))
      .digest("hex");
    if (inputBytes <= 0) throw new AgentError("provider_input_invalid");
    const identityFingerprint = createHash("sha256")
      .update(`${initial.runId}\0${progress.toolResults.length + 1}\0${this.provider.adapterName}`)
      .digest("hex");
    const effectKey = `agent-${requestId}`;
    const acquisition = await this.effects.acquire({
      effectKey,
      identityFingerprint,
      payloadFingerprint: inputFingerprint,
      ownerId: requestId,
      ownerGeneration: leaseGeneration,
      leaseExpiresAt: this.clock.now() + this.effectLeaseMs(this.options.providerTimeoutMs),
      allowTakeover: true,
    });
    if (!acquisition.acquired) {
      if (acquisition.record.state === "succeeded" && acquisition.record.result !== undefined) {
        return structuredClone(acquisition.record.result) as unknown as AgentStep;
      }
      throw new AgentError("provider_effect_outcome_unknown");
    }

    const claim = acquisition.claim;
    try {
      const step = await this.runAbortable(
        initial,
        leaseGeneration,
        this.options.providerTimeoutMs,
        async (signal) => {
          await this.repository.recordProviderDispatch({
            runId: initial.runId,
            providerSequence,
            leaseGeneration,
            authorizationEpoch: initial.authorizationEpoch,
            requestId,
            inputFingerprint,
            canonicalInput,
            inputBytes,
            contextBindingHash,
            context: contextBinding,
          });
          if (signal.aborted) throw signal.reason;
          const dispatched = await this.authorization.dispatchAuthorizedContext(
            {
              workspaceId: initial.workspaceId,
              runId: initial.runId,
              authorizationEpoch: initial.authorizationEpoch,
              resourceIds: contextBinding.map((entry) => entry.resourceId),
            },
            async () => {
              if (signal.aborted) throw signal.reason;
              const recovered = await this.provider.reconcile(requestId, inputFingerprint, signal);
              if (recovered) return recovered;
              if (recoveredDispatch || acquisition.previousState === "outcome_unknown") {
                throw new AgentError("provider_effect_outcome_unknown");
              }
              if (signal.aborted) throw signal.reason;
              const dispatchInput = this.canonicalProviderInput(input);
              if (
                dispatchInput !== canonicalInput ||
                Buffer.byteLength(dispatchInput, "utf8") !== inputBytes
              ) {
                throw new AgentError("provider_input_mutated");
              }
              this.assertProviderInputBudget(initial.budgets, progress, inputBytes);
              return this.provider.next(requestId, inputFingerprint, dispatchInput, signal);
            },
          );
          if (!dispatched.authorized) throw new RunRevokedError();
          return dispatched.value;
        },
        claim,
      );
      assertJsonValue(step as unknown);
      await this.effects.succeeded(claim, requestId, step as unknown as JsonValue);
      return step;
    } catch (error) {
      if (
        error instanceof ProviderTimeoutError ||
        (error instanceof AgentError && error.code === "provider_effect_outcome_unknown")
      ) {
        await this.effects.outcomeUnknown(claim).catch(() => undefined);
      }
      throw error;
    }
  }

  private contextFromDispatch(
    dispatch: ProviderDispatchFence,
    initial: AgentRunControl,
    progress: AgentRunProgress,
  ): ContextBundle {
    const expectedContextBindingHash = createHash("sha256")
      .update(JSON.stringify(dispatch.context))
      .digest("hex");
    if (
      dispatch.runId !== initial.runId ||
      dispatch.authorizationEpoch !== initial.authorizationEpoch ||
      dispatch.providerSequence !== progress.toolResults.length + 1 ||
      dispatch.inputBytes !== Buffer.byteLength(dispatch.canonicalInput, "utf8") ||
      expectedContextBindingHash !== dispatch.contextBindingHash ||
      dispatch.context.length > 1_000 ||
      dispatch.context.some(
        (entry, index) =>
          !/^[A-Za-z0-9._:-]{1,256}$/.test(entry.resourceId) ||
          !Number.isSafeInteger(entry.revision) ||
          entry.revision < 0 ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          (index > 0 && (dispatch.context[index - 1]?.resourceId ?? "") >= entry.resourceId),
      )
    ) {
      throw new AgentError("provider_dispatch_recovery_invalid");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(dispatch.canonicalInput);
    } catch {
      throw new AgentError("provider_dispatch_recovery_invalid");
    }
    assertJsonValue(decoded);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new AgentError("provider_dispatch_recovery_invalid");
    }
    const wire = decoded as Readonly<Record<string, JsonValue>>;
    if (
      wire.runId !== initial.runId ||
      typeof wire.context !== "string" ||
      canonical(wire.toolResults ?? null) !== canonical(progress.toolResults)
    ) {
      throw new AgentError("provider_dispatch_recovery_invalid");
    }
    if (canonical(decoded) !== dispatch.canonicalInput) {
      throw new AgentError("provider_dispatch_recovery_invalid");
    }
    const manifest: ContextManifestEntry[] = dispatch.context.map((entry) => ({
      ...entry,
      bytes: 0,
      sourceType: "dispatch_recovery",
      trustClass: "workspace_untrusted",
      redactions: [],
      retrievedAt: 0,
    }));
    return {
      manifest,
      structuredContent: wire.context,
      bytes: Buffer.byteLength(wire.context, "utf8"),
    };
  }

  private async reauthorizeContext(
    initial: AgentRunControl,
    leaseGeneration: number,
    manifest: readonly ContextManifestEntry[],
  ): Promise<void> {
    await this.assertCurrent(initial, leaseGeneration);
    for (const entry of manifest) {
      const allowed = await this.authorization.canPerform({
        workspaceId: initial.workspaceId,
        operation: "agent.context.read",
        resourceId: entry.resourceId,
        authorizationEpoch: initial.authorizationEpoch,
      });
      if (!allowed) throw new RunRevokedError();
    }
    await this.assertCurrent(initial, leaseGeneration);
  }

  private async runAbortable<T>(
    initial: AgentRunControl,
    leaseGeneration: number,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
    effectClaim?: EffectClaim,
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let rejectAbort: ((reason: unknown) => void) | undefined;
    let polling = false;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abortWith = (reason: unknown): void => {
      if (controller.signal.aborted) return;
      controller.abort(reason);
      rejectAbort?.(reason);
    };
    timeout = setTimeout(() => abortWith(new ProviderTimeoutError()), timeoutMs);
    const check = async (): Promise<void> => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        await this.assertCurrent(initial, leaseGeneration);
        if (effectClaim) {
          await this.effects.heartbeat(
            effectClaim,
            this.clock.now() + this.effectLeaseMs(timeoutMs),
          );
        }
      } catch (error) {
        abortWith(error);
      } finally {
        polling = false;
      }
    };
    poll = setInterval(() => void check(), this.options.controlPollMs ?? 10);
    poll.unref?.();
    try {
      return await Promise.race([operation(controller.signal), abortPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (poll) clearInterval(poll);
      if (controller.signal.aborted) await this.cancelProvider(initial.runId);
    }
  }

  private async cancelProvider(runId: string): Promise<void> {
    if (!this.provider.cancel) return;
    let cancellation: Promise<void>;
    try {
      cancellation = Promise.resolve(this.provider.cancel(runId));
    } catch {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        cancellation,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(1_000, this.options.providerTimeoutMs));
        }),
      ]);
    } catch {
      // Cancellation is best effort and must not mask durable business state.
    } finally {
      if (timer) clearTimeout(timer);
      void cancellation.catch(() => undefined);
    }
  }

  private remainingBudgets(
    budgets: AgentBudgets,
    contextBytes: number,
    progress: AgentRunProgress,
  ): AgentBudgets {
    return {
      maxContextBytes: Math.max(0, budgets.maxContextBytes - contextBytes),
      maxOutputTokens: Math.max(0, budgets.maxOutputTokens - progress.outputTokens),
      maxToolCalls: Math.max(0, budgets.maxToolCalls - progress.toolCalls),
      maxCostMicros: Math.max(0, budgets.maxCostMicros - progress.costMicros),
      maxOutputBytes: Math.max(0, this.maxOutputBytes(budgets)),
      maxToolResultBytes: Math.max(0, this.maxToolResultBytes(budgets)),
      maxTotalToolResultBytes: Math.max(
        0,
        this.maxTotalToolResultBytes(budgets) -
          Buffer.byteLength(canonical([...progress.toolResults]), "utf8"),
      ),
      maxProviderInputBytes: Math.max(0, this.maxProviderInputBytes(budgets)),
      maxTotalProviderInputBytes: Math.max(
        0,
        this.maxTotalProviderInputBytes(budgets) - (progress.providerInputBytes ?? 0),
      ),
    };
  }

  private assertUsage(usage: AgentUsage): void {
    if (
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.outputTokens < 0 ||
      !Number.isSafeInteger(usage.costMicros) ||
      usage.costMicros < 0
    ) {
      throw new AgentError("provider_usage_invalid");
    }
  }

  private assertProviderStep(step: AgentStep, budgets: AgentBudgets): void {
    if (typeof step !== "object" || step === null || !step.usage) {
      throw new AgentError("provider_step_invalid");
    }
    this.assertUsage(step.usage);
    if (step.type === "final") {
      if (typeof step.text !== "string") throw new AgentError("provider_step_invalid");
      if (Buffer.byteLength(step.text, "utf8") > this.maxOutputBytes(budgets)) {
        throw new BudgetExceededError("output_bytes");
      }
      return;
    }
    if (
      step.type !== "tool_call" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(step.callId) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(step.toolName) ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(step.toolVersion)
    ) {
      throw new AgentError("provider_step_invalid");
    }
    assertJsonValue(step.arguments);
    if (Buffer.byteLength(canonical(step.arguments), "utf8") > 256 * 1024) {
      throw new AgentError("tool_arguments_too_large");
    }
  }

  private assertBudgets(
    budgets: AgentBudgets,
    contextBytes: number,
    progress: AgentRunProgress,
  ): void {
    if (contextBytes > budgets.maxContextBytes) throw new BudgetExceededError("context_bytes");
    if (progress.outputTokens > budgets.maxOutputTokens)
      throw new BudgetExceededError("output_tokens");
    if (progress.toolCalls > budgets.maxToolCalls) throw new BudgetExceededError("tool_calls");
    if (progress.costMicros > budgets.maxCostMicros) throw new BudgetExceededError("cost");
  }

  private maxOutputBytes(budgets: AgentBudgets): number {
    return (
      budgets.maxOutputBytes ?? this.options.defaultMaxOutputBytes ?? budgets.maxOutputTokens * 16
    );
  }

  private maxToolResultBytes(budgets: AgentBudgets): number {
    return budgets.maxToolResultBytes ?? this.options.defaultMaxToolResultBytes ?? 256 * 1024;
  }

  private maxTotalToolResultBytes(budgets: AgentBudgets): number {
    return (
      budgets.maxTotalToolResultBytes ?? this.options.defaultMaxTotalToolResultBytes ?? 1024 * 1024
    );
  }

  private maxProviderInputBytes(budgets: AgentBudgets): number {
    return (
      budgets.maxProviderInputBytes ??
      this.options.defaultMaxProviderInputBytes ??
      budgets.maxContextBytes + this.maxTotalToolResultBytes(budgets)
    );
  }

  private maxTotalProviderInputBytes(budgets: AgentBudgets): number {
    return (
      budgets.maxTotalProviderInputBytes ??
      this.options.defaultMaxTotalProviderInputBytes ??
      this.maxProviderInputBytes(budgets) * Math.max(1, budgets.maxToolCalls + 1)
    );
  }

  private canonicalProviderInput(input: AgentProviderInput): string {
    const remaining: Record<string, JsonValue> = {
      maxContextBytes: input.remaining.maxContextBytes,
      maxOutputTokens: input.remaining.maxOutputTokens,
      maxToolCalls: input.remaining.maxToolCalls,
      maxCostMicros: input.remaining.maxCostMicros,
    };
    for (const key of [
      "maxOutputBytes",
      "maxToolResultBytes",
      "maxTotalToolResultBytes",
      "maxProviderInputBytes",
      "maxTotalProviderInputBytes",
    ] as const) {
      const value = input.remaining[key];
      if (value !== undefined) remaining[key] = value;
    }
    const wire: JsonValue = {
      runId: input.runId,
      context: input.context,
      toolResults: input.toolResults,
      remaining,
    };
    return canonical(wire);
  }

  private assertProviderInputBudget(
    budgets: AgentBudgets,
    progress: AgentRunProgress,
    bytes: number,
  ): void {
    if (bytes > this.maxProviderInputBytes(budgets)) {
      throw new BudgetExceededError("provider_input_bytes");
    }
    if ((progress.providerInputBytes ?? 0) + bytes > this.maxTotalProviderInputBytes(budgets)) {
      throw new BudgetExceededError("total_provider_input_bytes");
    }
  }

  private async assertCurrent(initial: AgentRunControl, leaseGeneration: number): Promise<void> {
    const current = await this.repository.control(initial.runId);
    if (current.leaseGeneration !== leaseGeneration) throw new StaleRunLeaseError();
    if (current.cancelRequested) throw new RunCanceledError();
    if (
      !current.installationEnabled ||
      current.currentAuthorizationEpoch !== initial.authorizationEpoch
    ) {
      throw new RunRevokedError();
    }
    const targetExpiry = this.clock.now() + this.runLeaseMs();
    const renewedExpiry = await this.repository.heartbeatLease(
      initial.runId,
      leaseGeneration,
      targetExpiry,
    );
    if (renewedExpiry !== targetExpiry) throw new StaleRunLeaseError();
  }

  private runLeaseMs(): number {
    return (
      this.options.runLeaseMs ??
      Math.max(
        Math.max(this.options.providerTimeoutMs, this.options.toolTimeoutMs ?? 0) * 2,
        (this.options.controlPollMs ?? 10) * 4,
      )
    );
  }

  private effectLeaseMs(operationTimeoutMs: number): number {
    return Math.max(operationTimeoutMs * 2, this.runLeaseMs());
  }

  private stableErrorCode(error: unknown): string {
    if (error instanceof AgentError) return error.code;
    if (error instanceof ProviderTimeoutError) return "provider_timeout";
    return errorCode(error);
  }
}

const terminalRunStates = new Set<AgentRunState>([
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "revoked",
]);

/** Reviewed bridge from the durable outbox request to the separately fenced AgentRun lease. */
export class AgentRunJobHandler implements JobHandler {
  readonly retryWhenReconciledNotFound = true;
  readonly dependencies: readonly RuntimeAdapter[];

  constructor(
    private readonly loop: AgentRunLoop,
    private readonly repository: AgentRunRepository,
  ) {
    if (loop.repositoryAdapter() !== repository)
      throw new Error("agent_handler_repository_mismatch");
    const runLeaseMs = loop.executionLeaseMs();
    if (!Number.isSafeInteger(runLeaseMs) || runLeaseMs < 1_000 || runLeaseMs > 300_000) {
      throw new Error("agent_handler_lease_invalid");
    }
    this.dependencies = loop.handlerDependencies();
  }

  async execute(job: OutboxJob, effectKey: string, signal: AbortSignal): Promise<EffectResult> {
    if (job.kind !== "agent.run") {
      return { type: "permanent_failure", code: "unsupported_agent_job" };
    }
    const runId = this.runId(job);
    if (signal.aborted) throw signal.reason;
    const claim = await this.repository.claimExecution({
      runId,
      workspaceId: job.workspaceId,
      requestId: effectKey,
      leaseMs: this.loop.executionLeaseMs(),
    });
    if (
      claim.control.runId !== runId ||
      claim.control.workspaceId !== job.workspaceId ||
      (claim.type === "claimed" && claim.control.executionRequestId !== effectKey)
    ) {
      return { type: "permanent_failure", code: "agent_run_claim_mismatch" };
    }
    if (claim.type === "busy") {
      return { type: "outcome_unknown", code: "agent_run_in_progress" };
    }
    if (claim.type === "claimed") {
      if (signal.aborted) throw signal.reason;
      await this.loop.execute(runId, claim.control.leaseGeneration);
    }
    const current = await this.repository.control(runId);
    if (current.runId !== runId || current.workspaceId !== job.workspaceId) {
      return { type: "permanent_failure", code: "agent_run_control_mismatch" };
    }
    if (!terminalRunStates.has(current.state)) {
      return { type: "outcome_unknown", code: "agent_run_not_terminal" };
    }
    return { type: "succeeded", result: { runId, state: current.state } };
  }

  async reconcile(
    _effectKey: string,
    job: OutboxJob,
    signal: AbortSignal,
  ): Promise<ReconciliationResult> {
    if (job.kind !== "agent.run") return { type: "unknown" };
    if (signal.aborted) throw signal.reason;
    const runId = this.runId(job);
    const current = await this.repository.control(runId);
    if (current.runId !== runId || current.workspaceId !== job.workspaceId) {
      return { type: "unknown" };
    }
    if (terminalRunStates.has(current.state)) {
      return { type: "succeeded", result: { runId, state: current.state } };
    }
    if (current.state === "queued" || current.leaseExpiresAt <= this.loop.clockAdapter().now()) {
      return { type: "not_found" };
    }
    return { type: "unknown" };
  }

  private runId(job: OutboxJob): string {
    if (typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) {
      throw new AgentError("agent_job_payload_invalid");
    }
    const runId = (job.payload as Readonly<Record<string, JsonValue>>).runId;
    if (typeof runId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(runId)) {
      throw new AgentError("agent_job_run_id_invalid");
    }
    return runId;
  }
}

export const createAgentRunJobHandler = (
  loop: AgentRunLoop,
  repository: AgentRunRepository,
): AgentRunJobHandler =>
  markReviewedHandler(new AgentRunJobHandler(loop, repository), ["agent.run"]);

export class InMemoryAgentRunRepository implements AgentRunRepository {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "in-memory-agent-run-repository";
  private readonly runs = new Map<string, AgentRunControl>();
  private readonly progressByRun = new Map<string, AgentRunProgress>();
  readonly checkpoints = new Map<string, AgentCheckpoint[]>();
  readonly manifests = new Map<string, readonly ContextManifestEntry[]>();
  readonly finalContent = new Map<string, string>();
  readonly providerDispatches = new Map<string, ProviderDispatchFence>();
  private readonly providerDispatchByTurn = new Map<string, ProviderDispatchFence>();

  constructor(private readonly clock: Clock = { now: () => 0 }) {}

  add(run: AgentRunControl): void {
    this.runs.set(run.runId, structuredClone(run));
    this.progressByRun.set(run.runId, emptyProgress());
  }

  async claimExecution(input: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly requestId: string;
    readonly leaseMs: number;
  }): Promise<
    | { readonly type: "claimed"; readonly control: AgentRunControl }
    | { readonly type: "busy"; readonly control: AgentRunControl }
    | { readonly type: "terminal"; readonly control: AgentRunControl }
  > {
    const run = this.mustGet(input.runId);
    if (
      run.workspaceId !== input.workspaceId ||
      !/^effect:[a-f0-9]{64}$/.test(input.requestId) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 1_000 ||
      input.leaseMs > 300_000
    ) {
      throw new AgentError("agent_run_claim_invalid");
    }
    if (terminalRunStates.has(run.state)) {
      return { type: "terminal", control: structuredClone(run) };
    }
    if (run.state !== "queued" && run.leaseExpiresAt > this.clock.now()) {
      return { type: "busy", control: structuredClone(run) };
    }
    if (
      run.cancelRequested ||
      !run.installationEnabled ||
      run.currentAuthorizationEpoch !== run.authorizationEpoch
    ) {
      throw new RunRevokedError();
    }
    const claimed: AgentRunControl = {
      ...run,
      state: "authorizing",
      leaseGeneration: run.leaseGeneration + 1,
      leaseExpiresAt: this.clock.now() + input.leaseMs,
      executionRequestId: input.requestId,
    };
    this.runs.set(input.runId, claimed);
    return { type: "claimed", control: structuredClone(claimed) };
  }

  cancel(runId: string): void {
    const run = this.mustGet(runId);
    this.runs.set(runId, { ...run, cancelRequested: true });
  }

  revoke(runId: string): void {
    const run = this.mustGet(runId);
    this.runs.set(runId, {
      ...run,
      installationEnabled: false,
      currentAuthorizationEpoch: run.currentAuthorizationEpoch + 1,
    });
  }

  reassignLease(runId: string, leaseGeneration: number, leaseExpiresAt?: number): void {
    const run = this.mustGet(runId);
    this.runs.set(runId, {
      ...run,
      leaseGeneration,
      leaseExpiresAt: leaseExpiresAt ?? run.leaseExpiresAt,
    });
  }

  async control(runId: string): Promise<AgentRunControl> {
    return structuredClone(this.mustGet(runId));
  }

  async transition(runId: string, leaseGeneration: number, state: AgentRunState): Promise<void> {
    const run = this.assertLease(runId, leaseGeneration);
    if (["succeeded", "failed", "canceled", "expired", "revoked"].includes(run.state)) {
      throw new AgentError("terminal_run_is_immutable");
    }
    this.runs.set(runId, { ...run, state });
  }

  async saveManifest(
    runId: string,
    leaseGeneration: number,
    manifest: readonly ContextManifestEntry[],
  ): Promise<void> {
    this.assertLease(runId, leaseGeneration);
    this.manifests.set(runId, structuredClone(manifest));
  }

  async checkpoint(
    runId: string,
    leaseGeneration: number,
    checkpoint: AgentCheckpoint,
  ): Promise<void> {
    this.assertLease(runId, leaseGeneration);
    const existing = this.checkpoints.get(runId) ?? [];
    if ((existing.at(-1)?.sequence ?? 0) >= checkpoint.sequence) return;
    this.checkpoints.set(runId, [...existing, structuredClone(checkpoint)]);
  }

  async progress(runId: string, leaseGeneration: number): Promise<AgentRunProgress> {
    this.assertLease(runId, leaseGeneration);
    return structuredClone(this.progressByRun.get(runId) ?? emptyProgress());
  }

  async saveProgress(
    runId: string,
    leaseGeneration: number,
    progress: AgentRunProgress,
  ): Promise<void> {
    this.assertLease(runId, leaseGeneration);
    const current = this.progressByRun.get(runId) ?? emptyProgress();
    if (
      progress.sequence < current.sequence ||
      progress.outputTokens < current.outputTokens ||
      progress.costMicros < current.costMicros ||
      progress.toolCalls < current.toolCalls ||
      (progress.providerInputBytes ?? 0) < (current.providerInputBytes ?? 0) ||
      progress.toolResults.length < current.toolResults.length
    ) {
      throw new AgentError("agent_progress_regression");
    }
    this.progressByRun.set(runId, structuredClone(progress));
  }

  async heartbeatLease(
    runId: string,
    leaseGeneration: number,
    leaseExpiresAt: number,
  ): Promise<number> {
    const run = this.assertLease(runId, leaseGeneration);
    if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= this.clock.now()) {
      throw new StaleRunLeaseError();
    }
    this.runs.set(runId, { ...run, leaseExpiresAt });
    return leaseExpiresAt;
  }

  async providerDispatch(
    runId: string,
    providerSequence: number,
  ): Promise<ProviderDispatchFence | undefined> {
    if (
      !/^[A-Za-z0-9._:-]{1,256}$/.test(runId) ||
      !Number.isSafeInteger(providerSequence) ||
      providerSequence < 1
    ) {
      throw new AgentError("provider_dispatch_lookup_invalid");
    }
    const dispatch = this.providerDispatchByTurn.get(`${runId}\0${providerSequence}`);
    return dispatch ? structuredClone(dispatch) : undefined;
  }

  async recordProviderDispatch(input: ProviderDispatchFence): Promise<"created" | "existing"> {
    const run = this.assertLease(input.runId, input.leaseGeneration);
    if (run.cancelRequested) throw new RunCanceledError();
    if (!run.installationEnabled || run.currentAuthorizationEpoch !== input.authorizationEpoch) {
      throw new RunRevokedError();
    }
    if (
      !/^provider:[a-f0-9]{64}$/.test(input.requestId) ||
      !/^[a-f0-9]{64}$/.test(input.inputFingerprint) ||
      !/^[a-f0-9]{64}$/.test(input.contextBindingHash) ||
      !Number.isSafeInteger(input.providerSequence) ||
      input.providerSequence < 1 ||
      !Number.isSafeInteger(input.inputBytes) ||
      input.inputBytes < 1 ||
      input.inputBytes !== Buffer.byteLength(input.canonicalInput, "utf8") ||
      input.canonicalInput.length === 0 ||
      input.context.length > 1_000 ||
      input.context.some(
        (entry, index) =>
          !/^[A-Za-z0-9._:-]{1,256}$/.test(entry.resourceId) ||
          !Number.isSafeInteger(entry.revision) ||
          entry.revision < 0 ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          (index > 0 && (input.context[index - 1]?.resourceId ?? "") >= entry.resourceId),
      )
    ) {
      throw new AgentError("provider_dispatch_binding_invalid");
    }
    const expectedContextHash = createHash("sha256")
      .update(JSON.stringify(input.context))
      .digest("hex");
    if (expectedContextHash !== input.contextBindingHash) {
      throw new AgentError("provider_dispatch_context_hash_mismatch");
    }
    const turnKey = `${input.runId}\0${input.providerSequence}`;
    const existingTurn = this.providerDispatchByTurn.get(turnKey);
    if (existingTurn && existingTurn.requestId !== input.requestId) {
      throw new AgentError("provider_dispatch_turn_conflict");
    }
    const existing = this.providerDispatches.get(input.requestId);
    if (existing) {
      const resumedBinding = { ...existing, leaseGeneration: input.leaseGeneration };
      if (JSON.stringify(resumedBinding) !== JSON.stringify(input)) {
        throw new AgentError("provider_dispatch_binding_conflict");
      }
      return "existing";
    }
    const stored = structuredClone(input);
    this.providerDispatches.set(input.requestId, stored);
    this.providerDispatchByTurn.set(turnKey, stored);
    return "created";
  }

  async commitFinalAndSucceed(input: {
    readonly runId: string;
    readonly leaseGeneration: number;
    readonly authorizationEpoch: number;
    readonly text: string;
    readonly progress: AgentRunProgress;
  }): Promise<void> {
    const run = this.assertLease(input.runId, input.leaseGeneration);
    if (
      run.cancelRequested ||
      !run.installationEnabled ||
      run.currentAuthorizationEpoch !== input.authorizationEpoch
    ) {
      throw new RunRevokedError();
    }
    if (run.state === "succeeded") {
      if (this.finalContent.get(input.runId) !== input.text) {
        throw new AgentError("final_content_conflict");
      }
      return;
    }
    this.progressByRun.set(input.runId, structuredClone(input.progress));
    this.finalContent.set(input.runId, input.text);
    this.runs.set(input.runId, { ...run, state: "succeeded" });
  }

  private assertLease(runId: string, leaseGeneration: number): AgentRunControl {
    const run = this.mustGet(runId);
    if (
      run.leaseGeneration !== leaseGeneration ||
      !Number.isSafeInteger(run.leaseExpiresAt) ||
      run.leaseExpiresAt <= this.clock.now()
    ) {
      throw new StaleRunLeaseError();
    }
    return run;
  }

  private mustGet(runId: string): AgentRunControl {
    const run = this.runs.get(runId);
    if (!run) throw new AgentError("run_not_found");
    return run;
  }
}

export class StaticAgentContextSource implements AgentContextSource {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "static-agent-context-source";
  private readonly byId = new Map<string, ContextSource>();

  constructor(sources: readonly ContextSource[]) {
    for (const source of sources) this.byId.set(source.resourceId, structuredClone(source));
  }

  async list(): Promise<readonly ContextMetadata[]> {
    return [...this.byId.values()].map(({ content: _content, ...metadata }) =>
      structuredClone(metadata),
    );
  }

  async read(
    _runId: string,
    metadata: ContextMetadata,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw signal.reason;
    const source = this.byId.get(metadata.resourceId);
    if (!source || source.revision !== metadata.revision)
      throw new AgentError("context_revision_missing");
    if (Buffer.byteLength(source.content, "utf8") > maxBytes) {
      throw new BudgetExceededError("context_bytes");
    }
    return source.content;
  }
}

export class ScriptedAgentProvider implements AgentProvider {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "scripted-agent-provider";
  readonly inputs: AgentProviderInput[] = [];
  readonly canonicalInputs: string[] = [];
  readonly requestIds: string[] = [];
  cancelCalls = 0;
  private readonly completed = new Map<
    string,
    { readonly inputFingerprint: string; readonly step: AgentStep }
  >();

  constructor(
    private readonly steps: Array<AgentStep | ((signal: AbortSignal) => Promise<AgentStep>)>,
    private readonly beforeStep?: (index: number) => void,
  ) {}

  async reconcile(
    requestId: string,
    inputFingerprint: string,
    signal: AbortSignal,
  ): Promise<AgentStep | undefined> {
    if (signal.aborted) throw signal.reason;
    const completed = this.completed.get(requestId);
    if (completed && completed.inputFingerprint !== inputFingerprint) {
      throw new AgentError("provider_request_identity_conflict");
    }
    return completed ? structuredClone(completed.step) : undefined;
  }

  async next(
    requestId: string,
    inputFingerprint: string,
    canonicalInput: string,
    signal: AbortSignal,
  ): Promise<AgentStep> {
    const existing = await this.reconcile(requestId, inputFingerprint, signal);
    if (existing) return existing;
    const input = JSON.parse(canonicalInput) as AgentProviderInput;
    this.requestIds.push(requestId);
    this.canonicalInputs.push(canonicalInput);
    this.inputs.push(structuredClone(input));
    const index = this.inputs.length - 1;
    this.beforeStep?.(index);
    const step = this.steps.shift();
    if (!step) throw new AgentError("provider_script_exhausted");
    const resolved = typeof step === "function" ? await step(signal) : step;
    this.completed.set(requestId, {
      inputFingerprint,
      step: structuredClone(resolved),
    });
    return resolved;
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }
}
