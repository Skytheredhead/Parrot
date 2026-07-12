import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRunLoop,
  type AgentTool,
  AgentToolRegistry,
  CompositionValidationError,
  composeWorkerRuntime,
  createAgentRunJobHandler,
  createBoundaryEnforcedAgentTool,
  createFileProcessingHandler,
  createNotificationDeliveryHandler,
  createReviewedAgentToolExecutionBoundary,
  createSearchIndexHandler,
  createWorkspaceExportCleanupHandler,
  createWorkspaceExportHandler,
  FakeClock,
  HandlerRegistry,
  InMemoryAgentRunRepository,
  InMemoryApprovalStore,
  InMemoryAuthorizationGate,
  InMemoryEffectLedger,
  InMemoryNotificationDeliveryAuthority,
  InMemoryNotificationProvider,
  InMemoryObjectStore,
  InMemorySearchBackend,
  InMemorySpanExporter,
  InMemoryTransactionalOutbox,
  type JobKind,
  OpenTelemetry,
  type RuntimeAdapter,
  ScriptedAgentProvider,
  StaticAgentContextSource,
  StructuredLogger,
  type WorkerProductionPorts,
} from "../src/index.js";

const jobKinds: readonly JobKind[] = [
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

const testGraph = (): WorkerProductionPorts => {
  const clock = new FakeClock(0);
  const outbox = new InMemoryTransactionalOutbox(clock);
  const search = new InMemorySearchBackend();
  const files = {
    adapterKind: "test-only",
    adapterName: "test-file-authority",
  };
  const scanner = {
    adapterKind: "test-only" as const,
    adapterName: "test-scanner",
    async scan() {
      return { clean: true, engine: "test" };
    },
  };
  const extractor = {
    adapterKind: "test-only" as const,
    adapterName: "test-extractor",
    async extract() {
      return "";
    },
  };
  const handlers = new HandlerRegistry();
  for (const kind of jobKinds) {
    handlers.registerTestOnly(kind, {
      retryWhenReconciledNotFound: false,
      dependencies: [outbox],
      async execute() {
        return { type: "permanent_failure", code: "test" };
      },
      async reconcile() {
        return { type: "unknown" };
      },
    });
  }
  const agentToolExecutionBoundary: WorkerProductionPorts["agentToolExecutionBoundary"] = {
    adapterKind: "test-only",
    adapterName: "test-tool-boundary",
    async normalize(input) {
      return input.arguments;
    },
    async execute() {
      return { type: "succeeded" };
    },
    async reconcile() {
      return { type: "not_found" };
    },
  };
  const tools = new AgentToolRegistry(agentToolExecutionBoundary).register({
    adapterKind: "test-only",
    adapterName: "test-tool",
    name: "test",
    version: "1",
    effectClass: "read",
    approvalPolicy: "never",
    retryWhenReconciledNotFound: false,
    normalizeArguments: (value) => value,
    async execute() {
      return { type: "succeeded" };
    },
    async reconcile() {
      return { type: "not_found" };
    },
  });
  const logSink = {
    adapterKind: "test-only" as const,
    adapterName: "test-log-sink",
    write() {},
  };
  const spanExporter = new InMemorySpanExporter();
  return {
    outbox,
    effects: new InMemoryEffectLedger(clock),
    agentRuns: new InMemoryAgentRunRepository(),
    approvals: new InMemoryApprovalStore(),
    search,
    rebuildSource: search,
    files: files as WorkerProductionPorts["files"],
    objects: new InMemoryObjectStore(),
    scanner,
    extractor,
    authorization: new InMemoryAuthorizationGate(),
    contextSource: new StaticAgentContextSource([]),
    notificationAuthority: new InMemoryNotificationDeliveryAuthority(),
    digestAuthority: {
      adapterKind: "test-only",
      adapterName: "test-digest-authority",
      async claimDue() {
        return [];
      },
      async resolvePlan() {
        throw new Error("no digest claim");
      },
      async dispatchCurrentPlan() {
        return { current: false };
      },
      async recordOutcome() {
        return false;
      },
    },
    notificationProvider: new InMemoryNotificationProvider(),
    agentProvider: new ScriptedAgentProvider([]),
    agentToolExecutionBoundary,
    workspaceExportAuthority: {
      adapterKind: "test-only",
      adapterName: "test-workspace-export-authority",
      async resolvePlan() {
        return undefined;
      },
      async dispatchCurrentPlan() {
        return { current: false };
      },
      async resolveCleanupPlan() {
        return undefined;
      },
      async dispatchCurrentCleanupPlan() {
        return { current: false };
      },
    },
    workspaceExportMaterializer: {
      adapterKind: "test-only",
      adapterName: "test-workspace-export-materializer",
      async materialize() {
        return { type: "permanent_failure", code: "provider_rejected" };
      },
      async reconcile() {
        return { type: "not_found" };
      },
      async deleteExact() {
        return { type: "not_found" };
      },
      async reconcileDelete() {
        return { type: "not_found" };
      },
    },
    logSink,
    logger: new StructuredLogger("test", "debug", logSink),
    spanExporter,
    telemetry: new OpenTelemetry(clock, spanExporter),
    handlers,
    tools,
  };
};

const durableAdapter = (name: string, methods: readonly string[]): RuntimeAdapter => {
  const adapter: Record<string, unknown> = {
    adapterKind: "durable",
    adapterName: name,
    assertProductionReady: () => true,
    ready: async () => true,
  };
  for (const method of methods) adapter[method] = () => Promise.resolve(undefined);
  return adapter as unknown as RuntimeAdapter;
};

test("production composition rejects every in-memory authority", () => {
  const ports = testGraph();
  assert.throws(() => composeWorkerRuntime("production", ports), CompositionValidationError);
  assert.doesNotThrow(() => composeWorkerRuntime("test", ports));
});

test("production composition validates methods, the complete handler graph, and tools", async () => {
  const base = testGraph();
  const logSink = durableAdapter("logs", ["write"]) as WorkerProductionPorts["logSink"];
  const spanExporter = durableAdapter("spans", ["export"]) as WorkerProductionPorts["spanExporter"];
  const toolBoundaryDefinition = {
    adapterKind: "durable" as const,
    adapterName: "agent-tool-boundary",
    assertProductionReady: () => true,
    ready: async () => true,
    async normalize(
      input: Parameters<WorkerProductionPorts["agentToolExecutionBoundary"]["normalize"]>[0],
    ) {
      return input.arguments;
    },
    async execute() {
      return { type: "succeeded" as const };
    },
    async reconcile() {
      return { type: "not_found" as const };
    },
  };
  const toolBoundary = createReviewedAgentToolExecutionBoundary(toolBoundaryDefinition);
  const ports = {
    outbox: durableAdapter("outbox", [
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
    ]),
    effects: durableAdapter("effects", [
      "acquire",
      "get",
      "heartbeat",
      "succeeded",
      "outcomeUnknown",
      "failedPermanent",
    ]),
    agentRuns: durableAdapter("agent-runs", [
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
    ]),
    approvals: durableAdapter("approvals", ["prepareExact", "consumeExact"]),
    search: durableAdapter("search", [
      "apply",
      "version",
      "beginRebuild",
      "applyRebuild",
      "activateRebuild",
      "activeGeneration",
    ]),
    rebuildSource: durableAdapter("rebuild-source", ["documents"]),
    files: durableAdapter("files", [
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
    ]),
    objects: durableAdapter("objects", [
      "readStream",
      "writeClean",
      "stat",
      "deleteIfMatch",
      "list",
    ]),
    scanner: durableAdapter("scanner", ["scan"]),
    extractor: durableAdapter("extractor", ["extract"]),
    authorization: durableAdapter("authorization", [
      "canPerform",
      "dispatchAuthorizedContext",
      "dispatchAuthorizedOperation",
    ]),
    contextSource: durableAdapter("context", ["list", "read"]),
    notificationAuthority: durableAdapter("notification-authority", [
      "resolvePlan",
      "dispatchCurrentPlan",
    ]),
    digestAuthority: durableAdapter("digest-authority", [
      "claimDue",
      "resolvePlan",
      "dispatchCurrentPlan",
      "recordOutcome",
    ]),
    notificationProvider: durableAdapter("notifications", ["send", "reconcile"]),
    agentProvider: durableAdapter("agent-provider", ["next", "reconcile"]),
    agentToolExecutionBoundary: toolBoundary,
    workspaceExportAuthority: durableAdapter("workspace-export-authority", [
      "resolvePlan",
      "dispatchCurrentPlan",
      "resolveCleanupPlan",
      "dispatchCurrentCleanupPlan",
    ]),
    workspaceExportMaterializer: durableAdapter("workspace-export-materializer", [
      "materialize",
      "reconcile",
      "deleteExact",
      "reconcileDelete",
    ]),
    logSink,
    logger: new StructuredLogger("production", "info", logSink),
    spanExporter,
    telemetry: new OpenTelemetry(new FakeClock(0), spanExporter),
    handlers: new HandlerRegistry(),
    tools: new AgentToolRegistry(toolBoundary),
  } as unknown as WorkerProductionPorts;
  const durableTool = createBoundaryEnforcedAgentTool(toolBoundary, {
    adapterKind: "durable",
    adapterName: "durable-tool",
    name: "durable-tool",
    version: "1",
    effectClass: "read",
    approvalPolicy: "never",
    retryWhenReconciledNotFound: false,
  });
  ports.tools.register(durableTool);
  const notificationHandler = createNotificationDeliveryHandler(
    ports.authorization,
    ports.notificationAuthority,
    ports.notificationProvider,
  );
  const searchHandler = createSearchIndexHandler(ports.search, ports.rebuildSource);
  const fileHandler = createFileProcessingHandler(
    ports.objects,
    ports.scanner,
    ports.extractor,
    ports.files,
  );
  const agentLoop = new AgentRunLoop(
    { providerTimeoutMs: 1_000, runLeaseMs: 1_000 },
    new FakeClock(0),
    ports.agentRuns,
    ports.contextSource,
    ports.agentProvider,
    ports.tools,
    ports.approvals,
    ports.authorization,
    ports.effects,
    ports.logger,
    ports.telemetry,
  );
  const agentHandler = createAgentRunJobHandler(agentLoop, ports.agentRuns);
  const workspaceExportHandler = createWorkspaceExportHandler(
    ports.workspaceExportAuthority,
    ports.workspaceExportMaterializer,
  );
  const workspaceExportCleanupHandler = createWorkspaceExportCleanupHandler(
    ports.workspaceExportAuthority,
    ports.workspaceExportMaterializer,
  );
  ports.handlers.register("notification.deliver", notificationHandler);
  for (const kind of ["search.upsert", "search.tombstone", "search.rebuild"] as const) {
    ports.handlers.register(kind, searchHandler);
  }
  for (const kind of ["file.scan", "file.extract", "file.cleanup"] as const) {
    ports.handlers.register(kind, fileHandler);
  }
  ports.handlers.register("agent.run", agentHandler);
  ports.handlers.register("workspace.export.generate", workspaceExportHandler);
  ports.handlers.register("workspace.export.cleanup", workspaceExportCleanupHandler);
  const runtime = composeWorkerRuntime("production", ports);
  assert.equal(runtime.outbox.adapterKind, "durable");
  assert.equal(runtime.tools.isSealed(), true);
  const sealedTool = runtime.tools.get("durable-tool", "1");
  const sealedExecute = sealedTool.execute;
  assert.equal(Object.isFrozen(sealedTool), true);
  assert.equal(Object.isFrozen(runtime.tools.entries()), true);
  assert.equal(Object.isFrozen(runtime.handlers.entries()), true);
  assert.equal(Object.isFrozen(runtime.handlers.entries()[0]), true);
  assert.equal(Object.hasOwn(agentHandler, "execute"), true);
  const reviewedExecute = agentHandler.execute;
  const agentHandlerPrototype = Object.getPrototypeOf(agentHandler) as {
    execute: typeof agentHandler.execute;
  };
  const prototypeExecute = agentHandlerPrototype.execute;
  try {
    agentHandlerPrototype.execute = async () => ({ type: "permanent_failure", code: "mutated" });
    assert.equal(agentHandler.execute, reviewedExecute);
    assert.equal(runtime.handlers.isReviewed("agent.run", agentHandler), true);
  } finally {
    agentHandlerPrototype.execute = prototypeExecute;
  }
  assert.throws(
    () =>
      runtime.tools.register({
        ...durableTool,
        adapterKind: "test-only",
        adapterName: "late-test-tool",
        name: "late-test-tool",
      }),
    /tool_registry_sealed/,
  );
  assert.throws(() => Object.assign(sealedTool, { adapterKind: "test-only" }), TypeError);
  assert.throws(
    () => Object.assign(sealedTool, { execute: async () => ({ type: "succeeded" }) }),
    TypeError,
  );
  assert.throws(
    () =>
      Object.assign(durableTool, {
        adapterKind: "test-only",
        execute: async () => ({ type: "permanent_failure", code: "mutated" }),
      }),
    TypeError,
  );
  assert.equal(sealedTool.adapterKind, "durable");
  assert.equal(sealedTool.execute, sealedExecute);
  const capturedBoundaryExecute = toolBoundary.execute;
  assert.throws(
    () => Object.assign(toolBoundary, { execute: async () => ({ type: "permanent_failure" }) }),
    TypeError,
  );
  Object.assign(toolBoundaryDefinition, {
    execute: async () => ({ type: "permanent_failure" as const }),
  });
  assert.equal(toolBoundary.execute, capturedBoundaryExecute);
  assert.deepEqual(
    await toolBoundary.execute(
      {
        workspaceId: "workspace-1",
        runId: "run-1",
        authorizationEpoch: 1,
        toolName: "durable-tool",
        toolVersion: "1",
        idempotencyKey: "effect-1",
        arguments: null,
      },
      new AbortController().signal,
    ),
    { type: "succeeded" },
  );
  let unreviewedConformanceCalls = 0;
  const unreviewedBoundary: WorkerProductionPorts["agentToolExecutionBoundary"] = {
    adapterKind: "durable",
    adapterName: "unreviewed-tool-boundary",
    assertProductionReady: () => {
      unreviewedConformanceCalls += 1;
      return true;
    },
    ready: async () => true,
    async normalize(input) {
      return input.arguments;
    },
    async execute() {
      return { type: "succeeded" };
    },
    async reconcile() {
      return { type: "not_found" };
    },
  };
  assert.throws(
    () =>
      composeWorkerRuntime("production", {
        ...ports,
        agentToolExecutionBoundary: unreviewedBoundary,
      }),
    /tools:execution_boundary_unreviewed/,
  );
  assert.equal(unreviewedConformanceCalls, 0);

  let rawNormalizationCalls = 0;
  const rawDurableTool: AgentTool = {
    adapterKind: "durable",
    adapterName: "raw-durable-tool",
    assertProductionReady: () => true,
    ready: async () => true,
    name: "raw-durable-tool",
    version: "1",
    effectClass: "read",
    approvalPolicy: "never",
    retryWhenReconciledNotFound: false,
    normalizeArguments: (value) => {
      rawNormalizationCalls += 1;
      return value;
    },
    async execute() {
      return { type: "succeeded" };
    },
    async reconcile() {
      return { type: "not_found" };
    },
  };
  assert.throws(
    () =>
      composeWorkerRuntime("production", {
        ...ports,
        tools: new AgentToolRegistry(toolBoundary).register(rawDurableTool),
      }),
    /tools:unreviewed_execution_boundary:raw-durable-tool@1/,
  );
  assert.equal(rawNormalizationCalls, 0);

  const swappedBoundary = createReviewedAgentToolExecutionBoundary({
    ...toolBoundaryDefinition,
    adapterName: "swapped-agent-tool-boundary",
  });
  const swappedTool = createBoundaryEnforcedAgentTool(swappedBoundary, {
    adapterKind: "durable",
    adapterName: "swapped-boundary-tool",
    name: "swapped-boundary-tool",
    version: "1",
    effectClass: "read",
    approvalPolicy: "never",
    retryWhenReconciledNotFound: false,
  });
  assert.throws(
    () =>
      composeWorkerRuntime("production", {
        ...ports,
        tools: new AgentToolRegistry(swappedBoundary).register(swappedTool),
      }),
    /tools:boundary_not_bound_to_graph/,
  );

  assert.throws(
    () =>
      new HandlerRegistry().register("agent.run", {
        retryWhenReconciledNotFound: false,
        dependencies: agentHandler.dependencies,
        async execute() {
          return { type: "succeeded" };
        },
        async reconcile() {
          return { type: "succeeded" };
        },
      }),
    /unreviewed_handler:agent.run/,
  );

  const dummyHandlers = new HandlerRegistry();
  for (const kind of jobKinds) {
    dummyHandlers.registerTestOnly(kind, {
      retryWhenReconciledNotFound: false,
      dependencies: [ports.outbox],
      async execute() {
        return { type: "permanent_failure", code: "dummy" };
      },
      async reconcile() {
        return { type: "unknown" };
      },
    });
  }
  assert.throws(
    () => composeWorkerRuntime("production", { ...ports, handlers: dummyHandlers }),
    /handlers:unreviewed:agent.run/,
  );

  const incomplete = {
    ...ports,
    scanner: durableAdapter("broken-scanner", []),
  } as WorkerProductionPorts;
  assert.throws(() => composeWorkerRuntime("production", incomplete), /missing_method:scan/);
  const noPreferencePlanner = {
    ...ports,
    notificationAuthority: durableAdapter("broken-notification-authority", []),
  } as WorkerProductionPorts;
  assert.throws(
    () => composeWorkerRuntime("production", noPreferencePlanner),
    /notificationAuthority:missing_method:resolvePlan/,
  );
  const noCurrentPlanDispatch = {
    ...ports,
    notificationAuthority: durableAdapter("broken-notification-authority", ["resolvePlan"]),
  } as WorkerProductionPorts;
  assert.throws(
    () => composeWorkerRuntime("production", noCurrentPlanDispatch),
    /notificationAuthority:missing_method:dispatchCurrentPlan/,
  );
  const noFinalNotificationFence = {
    ...ports,
    authorization: durableAdapter("broken-notification-authorization", [
      "canPerform",
      "dispatchAuthorizedContext",
    ]),
  } as WorkerProductionPorts;
  assert.throws(
    () => composeWorkerRuntime("production", noFinalNotificationFence),
    /authorization:missing_method:dispatchAuthorizedOperation/,
  );
  const noDigestOutcomeFence = {
    ...ports,
    digestAuthority: durableAdapter("broken-digest-authority", [
      "claimDue",
      "resolvePlan",
      "dispatchCurrentPlan",
    ]),
  } as WorkerProductionPorts;
  assert.throws(
    () => composeWorkerRuntime("production", noDigestOutcomeFence),
    /digestAuthority:missing_method:recordOutcome/,
  );
  const noExportAuthorityFence = {
    ...ports,
    workspaceExportAuthority: durableAdapter("broken-workspace-export-authority", ["resolvePlan"]),
  } as WorkerProductionPorts;
  assert.throws(
    () => composeWorkerRuntime("production", noExportAuthorityFence),
    /workspaceExportAuthority:missing_method:dispatchCurrentPlan/,
  );
  const { recoverOwned: _recoverOwned, ...outboxWithoutRecovery } = ports.outbox;
  const noOwnedLeaseRecovery = {
    ...ports,
    outbox: outboxWithoutRecovery,
  } as WorkerProductionPorts;
  assert.throws(
    () => composeWorkerRuntime("production", noOwnedLeaseRecovery),
    /outbox:missing_method:recoverOwned/,
  );
  const { completeWorkspaceExport: _completeWorkspaceExport, ...outboxWithoutExportCompletion } =
    ports.outbox;
  const noDedicatedExportCompletion = {
    ...ports,
    outbox: outboxWithoutExportCompletion,
  } as WorkerProductionPorts;
  assert.throws(
    () => composeWorkerRuntime("production", noDedicatedExportCompletion),
    /outbox:missing_method:completeWorkspaceExport/,
  );
  const nonconformant = {
    ...ports,
    scanner: {
      ...ports.scanner,
      assertProductionReady: () => false,
    },
  } as WorkerProductionPorts;
  assert.throws(() => composeWorkerRuntime("production", nonconformant), /conformance_failed/);
  const { ready: _ready, ...scannerWithoutReadiness } = ports.scanner;
  const noLiveReadiness = {
    ...ports,
    scanner: scannerWithoutReadiness,
  } as WorkerProductionPorts;
  assert.throws(
    () => composeWorkerRuntime("production", noLiveReadiness),
    /scanner:missing_readiness_check/,
  );
  assert.equal(base.handlers.entries().length, jobKinds.length);
});
