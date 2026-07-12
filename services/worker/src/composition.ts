import type {
  AuthorizationGate,
  FileAuthority,
  MalwareScanner,
  NotificationDeliveryAuthority,
  NotificationProvider,
  ObjectStore,
  SearchBackend,
  SearchRebuildSource,
  TextExtractor,
} from "./adapters.js";
import type {
  AgentContextSource,
  AgentProvider,
  AgentRunRepository,
  AgentToolRegistry,
  ApprovalStore,
} from "./agent.js";
import {
  type AgentToolExecutionBoundary,
  isBoundaryEnforcedAgentTool,
  isReviewedAgentToolExecutionBoundary,
} from "./agent-tool-boundary.js";
import type { WorkerEnvironment } from "./config.js";
import type { DigestDeliveryAuthority } from "./digest.js";
import type { JobKind } from "./domain.js";
import type { EffectLedger, HandlerRegistry, OutboxStore, RuntimeAdapter } from "./outbox.js";
import type { LogSink, OpenTelemetry, SpanExporter, StructuredLogger } from "./telemetry.js";
import type { WorkspaceExportAuthority, WorkspaceExportMaterializer } from "./workspace-export.js";

export interface WorkerProductionPorts {
  readonly outbox: OutboxStore;
  readonly effects: EffectLedger;
  readonly agentRuns: AgentRunRepository;
  readonly approvals: ApprovalStore;
  readonly search: SearchBackend;
  readonly rebuildSource: SearchRebuildSource;
  readonly files: FileAuthority;
  readonly objects: ObjectStore;
  readonly scanner: MalwareScanner;
  readonly extractor: TextExtractor;
  readonly authorization: AuthorizationGate;
  readonly contextSource: AgentContextSource;
  readonly notificationAuthority: NotificationDeliveryAuthority;
  readonly digestAuthority: DigestDeliveryAuthority;
  readonly notificationProvider: NotificationProvider;
  readonly agentProvider: AgentProvider;
  readonly agentToolExecutionBoundary: AgentToolExecutionBoundary;
  readonly workspaceExportAuthority: WorkspaceExportAuthority;
  readonly workspaceExportMaterializer: WorkspaceExportMaterializer;
  readonly logSink: LogSink;
  readonly logger: StructuredLogger;
  readonly spanExporter: SpanExporter;
  readonly telemetry: OpenTelemetry;
  readonly handlers: HandlerRegistry;
  readonly tools: AgentToolRegistry;
}

export class CompositionValidationError extends Error {
  constructor(readonly invalidAdapters: readonly string[]) {
    super(`Invalid production worker graph: ${invalidAdapters.join(", ")}`);
    this.name = "CompositionValidationError";
  }
}

type AdapterEntry = readonly [string, RuntimeAdapter, readonly string[]];

const entries = (ports: WorkerProductionPorts): readonly AdapterEntry[] => [
  [
    "outbox",
    ports.outbox,
    [
      "enqueue",
      "recoverOwned",
      "claim",
      "heartbeat",
      "complete",
      "completeWorkspaceExport",
      "completeWorkspaceExportCleanup",
      "retry",
      "outcomeUnknown",
      "deadLetter",
      "get",
    ],
  ],
  [
    "effects",
    ports.effects,
    ["acquire", "get", "heartbeat", "succeeded", "outcomeUnknown", "failedPermanent"],
  ],
  [
    "agentRuns",
    ports.agentRuns,
    [
      "claimExecution",
      "control",
      "transition",
      "saveManifest",
      "checkpoint",
      "progress",
      "saveProgress",
      "heartbeatLease",
      "providerDispatch",
      "recordProviderDispatch",
      "commitFinalAndSucceed",
    ],
  ],
  ["approvals", ports.approvals, ["consumeExact"]],
  [
    "search",
    ports.search,
    ["apply", "version", "beginRebuild", "applyRebuild", "activateRebuild", "activeGeneration"],
  ],
  ["rebuildSource", ports.rebuildSource, ["documents"]],
  [
    "files",
    ports.files,
    [
      "plan",
      "detectedType",
      "markClean",
      "markRejected",
      "recordExtractedText",
      "claimDeletion",
      "finalizeDeletion",
      "releaseDeletion",
      "pendingDeletionClaims",
      "recordOrphanDiscrepancy",
      "reconcile",
    ],
  ],
  ["objects", ports.objects, ["readStream", "writeClean", "stat", "deleteIfMatch", "list"]],
  ["scanner", ports.scanner, ["scan"]],
  ["extractor", ports.extractor, ["extract"]],
  [
    "authorization",
    ports.authorization,
    ["canPerform", "dispatchAuthorizedContext", "dispatchAuthorizedOperation"],
  ],
  ["contextSource", ports.contextSource, ["list", "read"]],
  ["notificationAuthority", ports.notificationAuthority, ["resolvePlan", "dispatchCurrentPlan"]],
  [
    "digestAuthority",
    ports.digestAuthority,
    ["claimDue", "resolvePlan", "dispatchCurrentPlan", "recordOutcome"],
  ],
  ["notificationProvider", ports.notificationProvider, ["send", "reconcile"]],
  ["agentProvider", ports.agentProvider, ["next", "reconcile"]],
  [
    "agentToolExecutionBoundary",
    ports.agentToolExecutionBoundary,
    ["normalize", "execute", "reconcile"],
  ],
  [
    "workspaceExportAuthority",
    ports.workspaceExportAuthority,
    ["resolvePlan", "dispatchCurrentPlan", "resolveCleanupPlan", "dispatchCurrentCleanupPlan"],
  ],
  [
    "workspaceExportMaterializer",
    ports.workspaceExportMaterializer,
    ["materialize", "reconcile", "deleteExact", "reconcileDelete"],
  ],
  ["logSink", ports.logSink, ["write"]],
  ["spanExporter", ports.spanExporter, ["export"]],
];

export const workerRuntimeAdapters = (ports: WorkerProductionPorts): readonly RuntimeAdapter[] => {
  const adapters = new Set<RuntimeAdapter>(entries(ports).map(([, adapter]) => adapter));
  if (typeof ports.tools?.entries === "function") {
    for (const tool of ports.tools.entries()) adapters.add(tool);
  }
  return Object.freeze([...adapters]);
};

const allJobKinds: readonly JobKind[] = [
  "notification.deliver",
  "search.upsert",
  "search.tombstone",
  "search.rebuild",
  "file.scan",
  "file.extract",
  "file.cleanup",
  "agent.run",
  "workspace.export.generate",
  "workspace.export.cleanup",
];

const expectedHandlerDependencies = (
  ports: WorkerProductionPorts,
): Readonly<Record<JobKind, readonly RuntimeAdapter[]>> => ({
  "notification.deliver": [
    ports.authorization,
    ports.notificationAuthority,
    ports.notificationProvider,
  ],
  "search.upsert": [ports.search, ports.rebuildSource],
  "search.tombstone": [ports.search, ports.rebuildSource],
  "search.rebuild": [ports.search, ports.rebuildSource],
  "file.scan": [ports.objects, ports.scanner, ports.extractor, ports.files],
  "file.extract": [ports.objects, ports.scanner, ports.extractor, ports.files],
  "file.cleanup": [ports.objects, ports.scanner, ports.extractor, ports.files],
  "agent.run": [
    ports.agentRuns,
    ports.contextSource,
    ports.agentProvider,
    ports.approvals,
    ports.authorization,
    ports.effects,
    ports.agentToolExecutionBoundary,
    ...(typeof ports.tools?.entries === "function" ? ports.tools.entries() : []),
  ],
  "workspace.export.generate": [ports.workspaceExportAuthority, ports.workspaceExportMaterializer],
  "workspace.export.cleanup": [ports.workspaceExportAuthority, ports.workspaceExportMaterializer],
});

const graphIssues = (ports: WorkerProductionPorts): string[] => {
  const issues: string[] = [];
  const toolBoundaryReviewed = isReviewedAgentToolExecutionBoundary(
    ports.agentToolExecutionBoundary,
  );
  if (!toolBoundaryReviewed) issues.push("tools:execution_boundary_unreviewed");
  const graphAdapters = new Set(entries(ports).map(([, adapter]) => adapter));
  if (typeof ports.tools?.entries === "function") {
    for (const tool of ports.tools.entries()) graphAdapters.add(tool);
  }
  for (const [port, adapter, methods] of entries(ports)) {
    if (adapter?.adapterKind !== "durable") {
      issues.push(`${port}:${adapter?.adapterName ?? "missing"}:not_durable`);
      continue;
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(adapter.adapterName)) {
      issues.push(`${port}:invalid_adapter_name`);
    }
    if (port === "agentToolExecutionBoundary" && !toolBoundaryReviewed) continue;
    if (typeof adapter.assertProductionReady !== "function") {
      issues.push(`${port}:missing_conformance_check`);
    } else {
      try {
        if (adapter.assertProductionReady() !== true) issues.push(`${port}:conformance_failed`);
      } catch {
        issues.push(`${port}:conformance_failed`);
      }
    }
    if (typeof adapter.ready !== "function") issues.push(`${port}:missing_readiness_check`);
    for (const method of methods) {
      if (typeof (adapter as unknown as Record<string, unknown>)[method] !== "function") {
        issues.push(`${port}:missing_method:${method}`);
      }
    }
  }
  if (
    typeof ports.logger?.log !== "function" ||
    typeof ports.logger?.sinkAdapter !== "function" ||
    ports.logger.sinkAdapter() !== ports.logSink
  ) {
    issues.push("logger:not_bound_to_graph_sink");
  }
  if (
    typeof ports.telemetry?.span !== "function" ||
    typeof ports.telemetry?.exporterAdapter !== "function" ||
    ports.telemetry.exporterAdapter() !== ports.spanExporter
  ) {
    issues.push("telemetry:not_bound_to_graph_exporter");
  }

  const handlerEntries =
    typeof ports.handlers?.entries === "function" ? ports.handlers.entries() : undefined;
  if (!handlerEntries) issues.push("handlers:registry_invalid");
  const handlerReviewAvailable = typeof ports.handlers?.isReviewed === "function";
  if (!handlerReviewAvailable) issues.push("handlers:review_provenance_unavailable");
  const handlers = new Map(handlerEntries ?? []);
  const dependencyContracts = expectedHandlerDependencies(ports);
  for (const kind of allJobKinds) {
    const handler = handlers.get(kind);
    if (!handler) {
      issues.push(`handlers:missing:${kind}`);
      continue;
    }
    if (!handlerReviewAvailable || !ports.handlers.isReviewed(kind, handler)) {
      issues.push(`handlers:unreviewed:${kind}`);
    }
    if (typeof handler.execute !== "function" || typeof handler.reconcile !== "function") {
      issues.push(`handlers:invalid:${kind}`);
    }
    if (!handler.dependencies || handler.dependencies.length === 0) {
      issues.push(`handlers:dependencies_missing:${kind}`);
      continue;
    }
    for (const dependency of handler.dependencies) {
      if (!graphAdapters.has(dependency)) issues.push(`handlers:dependency_outside_graph:${kind}`);
    }
    const actual = new Set(handler.dependencies);
    const expected = new Set(dependencyContracts[kind]);
    if (
      actual.size !== expected.size ||
      [...expected].some((dependency) => !actual.has(dependency))
    ) {
      issues.push(`handlers:dependency_contract_mismatch:${kind}`);
    }
  }

  const tools = typeof ports.tools?.entries === "function" ? ports.tools.entries() : [];
  if (typeof ports.tools?.entries !== "function") issues.push("tools:registry_invalid");
  const registryBoundary =
    typeof ports.tools?.executionBoundary === "function"
      ? ports.tools.executionBoundary()
      : undefined;
  if (registryBoundary !== ports.agentToolExecutionBoundary) {
    issues.push("tools:boundary_not_bound_to_graph");
  }
  if (tools.length === 0) issues.push("tools:empty");
  for (const tool of tools) {
    const key = `${tool.name}@${tool.version}`;
    if (tool.adapterKind !== "durable") issues.push(`tools:not_durable:${key}`);
    if (!isBoundaryEnforcedAgentTool(tool, ports.agentToolExecutionBoundary)) {
      issues.push(`tools:unreviewed_execution_boundary:${key}`);
    }
    if (typeof tool.assertProductionReady !== "function") {
      issues.push(`tools:missing_conformance_check:${key}`);
    } else {
      try {
        if (tool.assertProductionReady() !== true) issues.push(`tools:conformance_failed:${key}`);
      } catch {
        issues.push(`tools:conformance_failed:${key}`);
      }
    }
    if (typeof tool.ready !== "function") issues.push(`tools:missing_readiness_check:${key}`);
    if (
      !/^[A-Za-z0-9._:-]{1,128}$/.test(tool.name) ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(tool.version)
    ) {
      issues.push(`tools:invalid_identity:${key}`);
    }
    if (tool.effectClass !== "read" && tool.approvalPolicy !== "required") {
      issues.push(`tools:unsafe_approval:${key}`);
    }
    for (const method of ["normalizeArguments", "execute", "reconcile"] as const) {
      if (typeof tool[method] !== "function") issues.push(`tools:missing_method:${key}:${method}`);
    }
  }
  return issues;
};

/** Validates the complete executable graph before staging or production can start. */
export const composeWorkerRuntime = (
  environment: WorkerEnvironment,
  ports: WorkerProductionPorts,
): Readonly<WorkerProductionPorts> => {
  if (environment === "staging" || environment === "production") {
    const issues = graphIssues(ports);
    if (issues.length > 0) throw new CompositionValidationError(issues);
    ports.tools.seal();
  }
  return Object.freeze({ ...ports });
};
