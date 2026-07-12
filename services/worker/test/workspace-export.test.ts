import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceExportCleanupHandler,
  createWorkspaceExportHandler,
  deriveEffectIdentity,
  FakeClock,
  HandlerRegistry,
  InMemoryEffectLedger,
  InMemorySpanExporter,
  InMemoryTransactionalOutbox,
  type JsonValue,
  type LeaseToken,
  newJob,
  OpenTelemetry,
  OutboxConsumer,
  type OutboxJob,
  RetryPolicy,
  StructuredLogger,
  type WorkspaceExportAuthority,
  type WorkspaceExportCleanupPlan,
  type WorkspaceExportCleanupPlanInput,
  type WorkspaceExportCleanupRequest,
  type WorkspaceExportDeleteReconciliation,
  type WorkspaceExportDeleteResult,
  type WorkspaceExportMaterializationRequest,
  type WorkspaceExportMaterializationResult,
  type WorkspaceExportMaterializer,
  type WorkspaceExportPlan,
  type WorkspaceExportPlanInput,
  type WorkspaceExportReconciliationResult,
} from "../src/index.js";

const claimedJob = (): OutboxJob => ({
  ...newJob(
    {
      id: "job-1",
      workspaceId: "workspace-1",
      kind: "workspace.export.generate",
      payload: {
        exportId: "export-1",
        lifecycleEpoch: 3,
        workspaceRevision: 7,
        exportRevision: 1,
      },
    },
    1_000,
  ),
  state: "leased",
  leaseOwner: "service-1",
  leaseWorkerSlotId: "worker-1",
  leaseExpiresAt: 60_000,
  leaseGeneration: 2,
});

const claimedCleanupJob = (): OutboxJob => ({
  ...newJob(
    {
      id: "cleanup-job-1",
      workspaceId: "workspace-1",
      kind: "workspace.export.cleanup",
      payload: {
        exportId: "export-1",
        exportRevision: 3,
        artifactKey: "exports/workspace-1/export-1/export.tar.zst",
        contentHash: "a".repeat(64),
        artifactVersion: "object-version-1",
        sizeBytes: 42,
      },
    },
    1_000,
  ),
  state: "leased",
  leaseOwner: "service-1",
  leaseWorkerSlotId: "worker-1",
  leaseExpiresAt: 60_000,
  leaseGeneration: 2,
});

class ExportAuthority implements WorkspaceExportAuthority {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "test-export-authority";
  resolveCalls: WorkspaceExportPlanInput[] = [];
  dispatchCalls = 0;
  current = true;
  planOverride?: WorkspaceExportPlan;

  async resolvePlan(input: WorkspaceExportPlanInput): Promise<WorkspaceExportPlan | undefined> {
    this.resolveCalls.push(input);
    return this.planOverride ?? { ...input, reconcileOnly: false };
  }

  async dispatchCurrentPlan<T>(
    _plan: WorkspaceExportPlan,
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }> {
    this.dispatchCalls += 1;
    return this.current ? { current: true, value: await operation() } : { current: false };
  }

  async resolveCleanupPlan(
    input: WorkspaceExportCleanupPlanInput,
  ): Promise<WorkspaceExportCleanupPlan | undefined> {
    return input;
  }

  async dispatchCurrentCleanupPlan<T>(
    _plan: WorkspaceExportCleanupPlan,
    operation: () => Promise<T>,
  ): Promise<{ readonly current: true; readonly value: T } | { readonly current: false }> {
    return this.current ? { current: true, value: await operation() } : { current: false };
  }
}

class ExportMaterializer implements WorkspaceExportMaterializer {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "test-export-materializer";
  requests: WorkspaceExportMaterializationRequest[] = [];
  next: WorkspaceExportMaterializationResult = {
    type: "succeeded",
    artifactKey: "exports/workspace-1/export-1/export.tar.zst",
    contentHash: "A".repeat(64),
    sizeBytes: 42,
    providerReference: "object-version-1",
  };
  reconciled: WorkspaceExportReconciliationResult = { type: "not_found" };
  reconcileKeys: string[] = [];
  deleteRequests: WorkspaceExportCleanupRequest[] = [];
  deleteNext: WorkspaceExportDeleteResult = { type: "deleted" };
  deleteReconciled: WorkspaceExportDeleteReconciliation = { type: "not_found" };
  deleteReconcileKeys: string[] = [];

  async materialize(
    request: WorkspaceExportMaterializationRequest,
  ): Promise<WorkspaceExportMaterializationResult> {
    this.requests.push(request);
    return this.next;
  }

  async reconcile(materializationKey: string): Promise<WorkspaceExportReconciliationResult> {
    this.reconcileKeys.push(materializationKey);
    return this.reconciled;
  }

  async deleteExact(request: WorkspaceExportCleanupRequest): Promise<WorkspaceExportDeleteResult> {
    this.deleteRequests.push(request);
    return this.deleteNext;
  }

  async reconcileDelete(cleanupKey: string): Promise<WorkspaceExportDeleteReconciliation> {
    this.deleteReconcileKeys.push(cleanupKey);
    return this.deleteReconciled;
  }
}

test("workspace export materialization uses an exact live plan and bounded artifact result", async () => {
  const authority = new ExportAuthority();
  const materializer = new ExportMaterializer();
  const handler = createWorkspaceExportHandler(authority, materializer);
  const job = claimedJob();

  assert.deepEqual(await handler.execute(job, job.effectKey, new AbortController().signal), {
    type: "succeeded",
    providerReference: "object-version-1",
    result: {
      exportId: "export-1",
      exportRevision: 1,
      artifactKey: "exports/workspace-1/export-1/export.tar.zst",
      contentHash: "a".repeat(64),
      artifactVersion: "object-version-1",
      sizeBytes: 42,
    },
  });
  assert.equal(authority.resolveCalls.length, 1);
  assert.equal(authority.dispatchCalls, 1);
  assert.equal(materializer.requests.length, 1);
  assert.match(
    materializer.requests[0]?.materializationKey ?? "",
    /^workspace-export:[a-f0-9]{64}$/,
  );
  assert.equal(materializer.requests[0]?.artifactPrefix, "exports/workspace-1/export-1/");
  assert.equal(materializer.requests[0]?.deleteAfter, 1_000 + 14 * 24 * 60 * 60 * 1_000);
});

test("stale authority plans fail before materialization", async () => {
  const authority = new ExportAuthority();
  authority.planOverride = {
    jobId: "job-1",
    exportId: "export-1",
    workspaceId: "workspace-1",
    lifecycleEpoch: 4,
    workspaceRevision: 7,
    exportRevision: 1,
    leaseOwner: "service-1",
    workerSlotId: "worker-1",
    leaseGeneration: 2,
    reconcileOnly: false,
  };
  const materializer = new ExportMaterializer();
  const handler = createWorkspaceExportHandler(authority, materializer);

  assert.deepEqual(await handler.execute(claimedJob(), "ignored", new AbortController().signal), {
    type: "permanent_failure",
    code: "workspace_export_authority_stale",
  });
  assert.equal(materializer.requests.length, 0);
});

test("fenced expired-lease reconciliation can never replay materialization", async () => {
  const authority = new ExportAuthority();
  authority.planOverride = {
    jobId: "job-1",
    exportId: "export-1",
    workspaceId: "workspace-1",
    lifecycleEpoch: 3,
    workspaceRevision: 7,
    exportRevision: 1,
    leaseOwner: "service-1",
    workerSlotId: "worker-1",
    leaseGeneration: 2,
    reconcileOnly: true,
  };
  const materializer = new ExportMaterializer();
  const handler = createWorkspaceExportHandler(authority, materializer);
  const job = claimedJob();
  assert.deepEqual(await handler.reconcile("ignored", job, new AbortController().signal), {
    type: "not_found",
  });
  assert.deepEqual(await handler.execute(job, "ignored", new AbortController().signal), {
    type: "permanent_failure",
    code: "workspace_export_reconciliation_only",
  });
  assert.equal(materializer.requests.length, 0);
});

test("artifact paths, hashes, sizes, and provider references are fail-closed", async () => {
  const authority = new ExportAuthority();
  const materializer = new ExportMaterializer();
  materializer.next = {
    type: "succeeded",
    artifactKey: "exports/other-workspace/export-1/export.tar.zst",
    contentHash: "not-a-hash",
    sizeBytes: Number.MAX_SAFE_INTEGER,
    providerReference: "contains whitespace",
  };
  const handler = createWorkspaceExportHandler(authority, materializer);

  assert.deepEqual(await handler.execute(claimedJob(), "ignored", new AbortController().signal), {
    type: "permanent_failure",
    code: "workspace_export_result_invalid",
  });
});

test("artifact key traversal and oversized exports are rejected", async () => {
  const invalidKeys = [
    "exports/workspace-1/export-1/",
    "exports/workspace-1/export-1//export.tar.zst",
    "exports/workspace-1/export-1/./export.tar.zst",
    "exports/workspace-1/export-1/../export.tar.zst",
    "exports/workspace-1/export-1/archive/../../secret",
    "exports/workspace-1/export-1/archive\\secret",
    "exports/workspace-1/export-1/export.tar.zst?download=1",
    "exports/workspace-1/export-1/export.tar.zst#fragment",
    "exports/workspace-1/export-1/%2e%2e/secret",
    "exports/workspace-1/export-1/.hidden",
    "exports/workspace-1/export-1/archive..zst",
    "exports/workspace-1/export-1/archive\u0000zst",
  ];
  for (const artifactKey of invalidKeys) {
    const materializer = new ExportMaterializer();
    materializer.next = {
      type: "succeeded",
      artifactKey,
      contentHash: "d".repeat(64),
      sizeBytes: 42,
      providerReference: "object-version-1",
    };
    const handler = createWorkspaceExportHandler(new ExportAuthority(), materializer);
    assert.deepEqual(
      await handler.execute(claimedJob(), "ignored", new AbortController().signal),
      { type: "permanent_failure", code: "workspace_export_result_invalid" },
      artifactKey,
    );
  }

  const oversized = new ExportMaterializer();
  oversized.next = {
    type: "succeeded",
    artifactKey: "exports/workspace-1/export-1/export.tar.zst",
    contentHash: "d".repeat(64),
    sizeBytes: 1_099_511_627_777,
    providerReference: "object-version-1",
  };
  assert.deepEqual(
    await createWorkspaceExportHandler(new ExportAuthority(), oversized).execute(
      claimedJob(),
      "ignored",
      new AbortController().signal,
    ),
    { type: "permanent_failure", code: "workspace_export_result_invalid" },
  );
});

test("cleanup conditionally deletes the exact registered artifact", async () => {
  const authority = new ExportAuthority();
  const materializer = new ExportMaterializer();
  const handler = createWorkspaceExportCleanupHandler(authority, materializer);
  const result = await handler.execute(
    claimedCleanupJob(),
    "ignored",
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    type: "succeeded",
    result: { exportId: "export-1", cleanupDisposition: "deleted" },
  });
  assert.deepEqual(materializer.deleteRequests[0], {
    exportId: "export-1",
    workspaceId: "workspace-1",
    exportRevision: 3,
    artifactKey: "exports/workspace-1/export-1/export.tar.zst",
    contentHash: "a".repeat(64),
    artifactVersion: "object-version-1",
    sizeBytes: 42,
    cleanupKey: materializer.deleteRequests[0]?.cleanupKey,
  });
  assert.match(materializer.deleteRequests[0]?.cleanupKey ?? "", /^workspace-export-cleanup:/);
});

test("cleanup conditional mismatch retains authority for operator recovery", async () => {
  const materializer = new ExportMaterializer();
  materializer.deleteNext = { type: "conditional_mismatch" };
  const handler = createWorkspaceExportCleanupHandler(new ExportAuthority(), materializer);
  assert.deepEqual(
    await handler.execute(claimedCleanupJob(), "ignored", new AbortController().signal),
    { type: "permanent_failure", code: "workspace_export_cleanup_conditional_mismatch" },
  );
});

test("cleanup timeout reconciles exact deletion without repeating it", async () => {
  const materializer = new ExportMaterializer();
  materializer.deleteNext = { type: "outcome_unknown", code: "provider_timeout" };
  const handler = createWorkspaceExportCleanupHandler(new ExportAuthority(), materializer);
  const job = claimedCleanupJob();
  assert.deepEqual(await handler.execute(job, "ignored", new AbortController().signal), {
    type: "outcome_unknown",
    code: "provider_timeout",
  });
  materializer.deleteReconciled = { type: "deleted" };
  assert.deepEqual(await handler.reconcile("ignored", job, new AbortController().signal), {
    type: "succeeded",
    result: { exportId: "export-1", cleanupDisposition: "deleted" },
  });
  assert.equal(materializer.deleteReconcileKeys[0], materializer.deleteRequests[0]?.cleanupKey);
  assert.equal(materializer.deleteRequests.length, 1);
});

test("ambiguous materialization reconciles by the stable semantic key", async () => {
  const authority = new ExportAuthority();
  const materializer = new ExportMaterializer();
  materializer.next = { type: "outcome_unknown", code: "provider_timeout" };
  const handler = createWorkspaceExportHandler(authority, materializer);
  const job = claimedJob();

  assert.deepEqual(await handler.execute(job, "ignored", new AbortController().signal), {
    type: "outcome_unknown",
    code: "provider_timeout",
  });
  materializer.reconciled = {
    type: "succeeded",
    artifactKey: "exports/workspace-1/export-1/export.tar.zst",
    contentHash: "b".repeat(64),
    sizeBytes: 84,
    providerReference: "object-version-2",
  };
  const reconciled = await handler.reconcile("ignored", job, new AbortController().signal);
  assert.equal(reconciled.type, "succeeded");
  assert.equal(materializer.reconcileKeys[0], materializer.requests[0]?.materializationKey);
});

test("export semantic identity changes when an authority snapshot changes", () => {
  const first = claimedJob();
  const next: OutboxJob = {
    ...first,
    payload: { ...(first.payload as object), workspaceRevision: 8 },
  };
  assert.notEqual(deriveEffectIdentity(first).effectKey, deriveEffectIdentity(next).effectKey);
});

class ExportRoutingOutbox extends InMemoryTransactionalOutbox {
  genericCalls: string[] = [];
  exportCalls: import("../src/index.js").WorkspaceExportCompletion[] = [];
  cleanupCalls: import("../src/index.js").WorkspaceExportCleanupCompletion[] = [];

  override async complete(_lease: LeaseToken, _result?: JsonValue): Promise<void> {
    this.genericCalls.push("complete");
    throw new Error("generic_export_completion_called");
  }

  override async retry(_lease: LeaseToken, _nextAttemptAt: number, _code: string): Promise<void> {
    this.genericCalls.push("retry");
    throw new Error("generic_export_retry_called");
  }

  override async outcomeUnknown(
    _lease: LeaseToken,
    _nextAttemptAt: number,
    _code: string,
  ): Promise<void> {
    this.genericCalls.push("outcomeUnknown");
    throw new Error("generic_export_unknown_called");
  }

  override async deadLetter(_lease: LeaseToken, _reason: string): Promise<void> {
    this.genericCalls.push("deadLetter");
    throw new Error("generic_export_dead_letter_called");
  }

  override async completeWorkspaceExport(
    lease: LeaseToken,
    outcome: import("../src/index.js").WorkspaceExportCompletion,
  ): Promise<void> {
    this.exportCalls.push(structuredClone(outcome));
    await super.completeWorkspaceExport(lease, outcome);
  }

  override async completeWorkspaceExportCleanup(
    lease: LeaseToken,
    outcome: import("../src/index.js").WorkspaceExportCleanupCompletion,
  ): Promise<void> {
    this.cleanupCalls.push(structuredClone(outcome));
    await super.completeWorkspaceExportCleanup(lease, outcome);
  }
}

const exportJob = (id: string): OutboxJob =>
  newJob(
    {
      id,
      workspaceId: "workspace-1",
      kind: "workspace.export.generate",
      payload: {
        exportId: "export-1",
        lifecycleEpoch: 3,
        workspaceRevision: 7,
        exportRevision: 1,
      },
    },
    1_000,
  );

const exportConsumer = (
  materializer: ExportMaterializer,
  store = new ExportRoutingOutbox(new FakeClock(1_000)),
  ledger = new InMemoryEffectLedger(new FakeClock(1_000)),
) => {
  const clock = new FakeClock(1_000);
  // The injected stores use the same stable timestamp; no test advances time during a tick.
  const handler = createWorkspaceExportHandler(new ExportAuthority(), materializer);
  const handlers = new HandlerRegistry().register("workspace.export.generate", handler);
  const sink = { adapterKind: "test-only" as const, adapterName: "test-log", write() {} };
  const consumer = new OutboxConsumer(
    { workerId: "worker-1", leaseMs: 10_000 },
    clock,
    store,
    ledger,
    handlers,
    new RetryPolicy(
      { baseMs: 100, capMs: 1_000, jitterRatio: 0, maxAttempts: 4, maxAgeMs: 60_000 },
      () => 0.5,
    ),
    new StructuredLogger("test", "error", sink),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  return { consumer, store, ledger };
};

test("OutboxConsumer routes every export outcome only through dedicated completion", async () => {
  const cases: readonly [
    WorkspaceExportMaterializationResult,
    import("../src/index.js").WorkspaceExportCompletion["type"],
  ][] = [
    [
      {
        type: "succeeded",
        artifactKey: "exports/workspace-1/export-1/export.tar.zst",
        contentHash: "c".repeat(64),
        sizeBytes: 128,
        providerReference: "object-1",
      },
      "succeeded",
    ],
    [{ type: "transient_failure", code: "provider_unavailable" }, "retry"],
    [{ type: "outcome_unknown", code: "provider_timeout" }, "outcome_unknown"],
    [{ type: "permanent_failure", code: "provider_rejected" }, "failed"],
  ];

  for (const [result, expected] of cases) {
    const materializer = new ExportMaterializer();
    materializer.next = result;
    const { consumer, store } = exportConsumer(materializer);
    await store.enqueue(exportJob(`job-${expected}`));
    assert.equal(await consumer.tick(), true);
    assert.equal(store.exportCalls.length, 1);
    assert.equal(store.exportCalls[0]?.type, expected);
    assert.deepEqual(store.genericCalls, []);
  }
});

test("ledger-already-succeeded export recovery uses dedicated completion without rematerializing", async () => {
  const clock = new FakeClock(1_000);
  const store = new ExportRoutingOutbox(clock);
  const ledger = new InMemoryEffectLedger(clock);
  const materializer = new ExportMaterializer();
  const { consumer } = exportConsumer(materializer, store, ledger);

  await store.enqueue(exportJob("job-first"));
  assert.equal(await consumer.tick(), true);
  assert.equal(materializer.requests.length, 1);

  await store.enqueue(exportJob("job-recovered"));
  assert.equal(await consumer.tick(), true);
  assert.equal(materializer.requests.length, 1);
  assert.equal(store.exportCalls.length, 2);
  assert.equal(store.exportCalls[1]?.type, "succeeded");
  assert.deepEqual(store.genericCalls, []);
});

test("OutboxConsumer cleanup success uses only dedicated cleanup completion", async () => {
  const clock = new FakeClock(1_000);
  const store = new ExportRoutingOutbox(clock);
  const ledger = new InMemoryEffectLedger(clock);
  const materializer = new ExportMaterializer();
  const handlers = new HandlerRegistry().register(
    "workspace.export.cleanup",
    createWorkspaceExportCleanupHandler(new ExportAuthority(), materializer),
  );
  const sink = { adapterKind: "test-only" as const, adapterName: "cleanup-log", write() {} };
  const consumer = new OutboxConsumer(
    { workerId: "worker-1", leaseMs: 10_000 },
    clock,
    store,
    ledger,
    handlers,
    new RetryPolicy(
      { baseMs: 100, capMs: 1_000, jitterRatio: 0, maxAttempts: 4, maxAgeMs: 60_000 },
      () => 0.5,
    ),
    new StructuredLogger("test", "error", sink),
    new OpenTelemetry(clock, new InMemorySpanExporter()),
  );
  await store.enqueue(
    newJob(
      {
        id: "cleanup-job-consumer",
        workspaceId: "workspace-1",
        kind: "workspace.export.cleanup",
        payload: claimedCleanupJob().payload,
      },
      1_000,
    ),
  );
  assert.equal(await consumer.tick(), true);
  assert.deepEqual(store.cleanupCalls, [{ type: "deleted", exportId: "export-1" }]);
  assert.deepEqual(store.genericCalls, []);
});
