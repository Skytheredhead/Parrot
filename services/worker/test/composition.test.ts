import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRunLoop,
  AgentToolRegistry,
  CompositionValidationError,
  FakeClock,
  HandlerRegistry,
  InMemoryAgentRunRepository,
  InMemoryApprovalStore,
  InMemoryAuthorizationGate,
  InMemoryEffectLedger,
  InMemoryNotificationProvider,
  InMemoryObjectStore,
  InMemorySearchBackend,
  InMemorySpanExporter,
  InMemoryTransactionalOutbox,
  OpenTelemetry,
  ScriptedAgentProvider,
  StaticAgentContextSource,
  StructuredLogger,
  composeWorkerRuntime,
  createAgentRunJobHandler,
  createFileProcessingHandler,
  createNotificationDeliveryHandler,
  createSearchIndexHandler,
  type AgentTool,
  type JobKind,
  type RuntimeAdapter,
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
  const tools = new AgentToolRegistry().register({
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
    notificationProvider: new InMemoryNotificationProvider(),
    agentProvider: new ScriptedAgentProvider([]),
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

test("production composition validates methods, the complete handler graph, and tools", () => {
  const base = testGraph();
  const logSink = durableAdapter("logs", ["write"]) as WorkerProductionPorts["logSink"];
  const spanExporter = durableAdapter("spans", ["export"]) as WorkerProductionPorts["spanExporter"];
  const ports = {
    outbox: durableAdapter("outbox", [
      "enqueue",
      "recoverOwned",
      "claim",
      "heartbeat",
      "complete",
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
    approvals: durableAdapter("approvals", ["consumeExact"]),
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
    authorization: durableAdapter("authorization", ["canPerform", "dispatchAuthorizedContext"]),
    contextSource: durableAdapter("context", ["list", "read"]),
    notificationProvider: durableAdapter("notifications", ["send", "reconcile"]),
    agentProvider: durableAdapter("agent-provider", ["next", "reconcile"]),
    logSink,
    logger: new StructuredLogger("production", "info", logSink),
    spanExporter,
    telemetry: new OpenTelemetry(new FakeClock(0), spanExporter),
    handlers: new HandlerRegistry(),
    tools: new AgentToolRegistry(),
  } as unknown as WorkerProductionPorts;
  const durableTool: AgentTool = {
    adapterKind: "durable",
    adapterName: "durable-tool",
    assertProductionReady: () => true,
    ready: async () => true,
    name: "durable-tool",
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
  };
  ports.tools.register(durableTool);
  const notificationHandler = createNotificationDeliveryHandler(
    ports.authorization,
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
  ports.handlers.register("notification.deliver", notificationHandler);
  for (const kind of ["search.upsert", "search.tombstone", "search.rebuild"] as const) {
    ports.handlers.register(kind, searchHandler);
  }
  for (const kind of ["file.scan", "file.extract", "file.cleanup"] as const) {
    ports.handlers.register(kind, fileHandler);
  }
  ports.handlers.register("agent.run", agentHandler);
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
  Object.assign(durableTool, {
    adapterKind: "test-only",
    execute: async () => ({ type: "permanent_failure", code: "mutated" }),
  });
  assert.equal(sealedTool.adapterKind, "durable");
  assert.equal(sealedTool.execute, sealedExecute);

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
  const { recoverOwned: _recoverOwned, ...outboxWithoutRecovery } = ports.outbox;
  const noOwnedLeaseRecovery = {
    ...ports,
    outbox: outboxWithoutRecovery,
  } as WorkerProductionPorts;
  assert.throws(
    () => composeWorkerRuntime("production", noOwnedLeaseRecovery),
    /outbox:missing_method:recoverOwned/,
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
