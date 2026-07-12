import assert from "node:assert/strict";
import test from "node:test";
import {
  type AuthenticatedSpacetimeWorkerTransport,
  SpacetimeAgentContextSource,
  SpacetimeAgentRunRepository,
  SpacetimeApprovalStore,
  SpacetimeEffectLedger,
  SpacetimeFileAuthority,
  SpacetimeSchemaGapError,
  SpacetimeWorkerAuthority,
  type SpacetimeWorkerQuery,
  type SpacetimeWorkerReducer,
  type SpacetimeWorkerView,
} from "../src/production/spacetime-worker.js";

const SERVICE = "service:parrot-worker";
const SUBJECT = "workos:m2m:parrot-worker";

const baseRow = (kind = "file.scan") => ({
  id: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  kind,
  effectKey: "authority-effect",
  resourceType: kind.startsWith("workspace.export") ? "workspace_export" : "file",
  resourceId: "00000000-0000-0000-0000-000000000003",
  resourceRevision: 1n,
  intentId: null,
  recipientId: null,
  channel: "",
  minimalMessage: "",
  payloadResourceId: kind.startsWith("workspace.export")
    ? "00000000-0000-0000-0000-000000000003"
    : null,
  fileId: kind === "file.scan" ? "00000000-0000-0000-0000-000000000003" : null,
  version: 1n,
  createdAt: 1_000,
  nextAttemptAt: 1_000,
  attempt: 0,
  state: { tag: "Pending" },
  leaseOwner: null as string | null,
  workerSlotId: "",
  leaseUntil: null as number | null,
  leaseGeneration: 0n,
  lastError: "",
});

class TransactionalTransport implements AuthenticatedSpacetimeWorkerTransport {
  readonly authentication = "workos_m2m_bearer" as const;
  readonly serviceIdentity = SERVICE;
  readonly bearerSubject = SUBJECT;
  readonly connected = true;
  readonly views = new Set<string>([
    "pending_outbox_work",
    "pending_post_search_documents",
    "pending_workspace_export_plans",
    "pending_workspace_export_cleanup_plans",
    "pending_notification_delivery_plans",
    "pending_notification_digest_schedules",
    "pending_notification_digest_plans",
  ]);
  readonly reducers = new Set<string>([
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
  ]);
  readonly calls: Array<{
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
  }> = [];
  row = baseRow();
  exportPlan: Record<string, unknown> | undefined;

  async select(
    view: SpacetimeWorkerView,
    query: SpacetimeWorkerQuery,
  ): Promise<readonly unknown[]> {
    assert.ok(query.limit >= 1 && query.limit <= 64);
    if (view === "pending_outbox_work") {
      if ("id" in query.where && query.where.id !== this.row.id) return [];
      if ("lease_owner" in query.where && query.where.lease_owner !== this.row.leaseOwner)
        return [];
      return [structuredClone(this.row)];
    }
    if (view === "pending_workspace_export_plans" && this.exportPlan) {
      return [structuredClone(this.exportPlan)];
    }
    return [];
  }

  async reduce(
    reducer: SpacetimeWorkerReducer,
    input: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.calls.push({ name: reducer, input });
    if (reducer === "claim_outbox_job" || reducer === "recover_outbox_job") {
      this.row = {
        ...this.row,
        state: { tag: "Leased" },
        attempt: this.row.attempt + 1,
        leaseOwner: SERVICE,
        workerSlotId: String(input.workerSlotId),
        leaseUntil: 31_000,
        leaseGeneration: this.row.leaseGeneration + 1n,
      };
      if (this.exportPlan) {
        this.exportPlan = {
          ...this.exportPlan,
          state: { tag: "Leased" },
          leaseOwner: SERVICE,
          workerSlotId: String(input.workerSlotId),
          leaseGeneration: this.row.leaseGeneration,
        };
      }
    }
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

class AgentTransport extends TransactionalTransport {
  plan: Record<string, unknown> = {
    runId: "00000000-0000-0000-0000-000000000010",
    workspaceId: "00000000-0000-0000-0000-000000000002",
    state: { tag: "Queued" },
    version: 1n,
    authorizationEpoch: 1n,
    currentAuthorizationEpoch: 1n,
    installationEnabled: true,
    cancelRequested: false,
    leaseGeneration: 0n,
    leaseOwner: null,
    leaseUntil: null,
    executionRequestId: "",
    maxContextBytes: 1_000n,
    maxOutputTokens: 100n,
    maxToolCalls: 4,
    maxCostMicros: 1_000n,
    maxOutputBytes: 1_000n,
    maxToolResultBytes: 500n,
    maxTotalToolResultBytes: 1_000n,
    maxProviderInputBytes: 1_000n,
    maxTotalProviderInputBytes: 2_000n,
  };
  effect: Record<string, unknown> | undefined;
  approval: Record<string, unknown> | undefined;
  contextCandidate: Record<string, unknown> | undefined;
  filePlan: Record<string, unknown> | undefined;
  fileClaim: Record<string, unknown> | undefined;
  fileOutcome: Record<string, unknown> | undefined;

  constructor() {
    super();
    for (const view of [
      "service_agent_execution_plans",
      "service_agent_run_progress",
      "service_agent_provider_dispatches",
      "service_worker_effects",
      "service_agent_approval_bindings",
      "service_file_deletion_claims",
      "service_file_processing_outcomes",
    ]) {
      this.views.add(view);
    }
    for (const reducer of [
      "service_claim_agent_execution",
      "service_transition_agent_run",
      "service_save_agent_progress",
      "service_append_agent_checkpoint",
      "service_record_agent_provider_dispatch",
      "service_commit_agent_final",
      "heartbeat_agent_run",
      "record_agent_context_post",
      "record_agent_context_contribution",
      "service_prepare_agent_tool_call",
      "consume_agent_tool_approval",
      "service_acquire_worker_effect",
      "service_update_worker_effect",
      "register_clean_file_object",
      "record_file_scan_outcome",
      "record_file_extraction",
      "service_claim_file_deletion",
      "service_finalize_file_deletion",
      "service_release_file_deletion",
      "service_record_file_orphan",
    ]) {
      this.reducers.add(reducer);
    }
  }

  override async select(
    view: SpacetimeWorkerView,
    query: SpacetimeWorkerQuery,
  ): Promise<readonly unknown[]> {
    if (view === "service_agent_execution_plans") return [structuredClone(this.plan)];
    if (view === "service_worker_effects") return this.effect ? [structuredClone(this.effect)] : [];
    if (view === "service_agent_approval_bindings")
      return this.approval ? [structuredClone(this.approval)] : [];
    if (view === "service_agent_run_progress" || view === "service_agent_provider_dispatches")
      return [];
    if (view === "agent_context_candidates" && this.contextCandidate)
      return [structuredClone(this.contextCandidate)];
    if (view === "file_processing_plans" && this.filePlan) return [structuredClone(this.filePlan)];
    if (view === "service_file_deletion_claims" && this.fileClaim)
      return [structuredClone(this.fileClaim)];
    if (view === "service_file_processing_outcomes" && this.fileOutcome)
      return [structuredClone(this.fileOutcome)];
    return super.select(view, query);
  }

  override async reduce(
    reducer: SpacetimeWorkerReducer,
    input: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.calls.push({ name: reducer, input });
    const body = input.input as Record<string, unknown> | undefined;
    if (reducer === "service_claim_agent_execution" && body) {
      this.plan = {
        ...this.plan,
        state: { tag: "Authorizing" },
        version: 2n,
        leaseGeneration: 1n,
        leaseOwner: SERVICE,
        leaseUntil: 31_000,
        executionRequestId: body.executionRequestId,
      };
      return;
    }
    if (reducer === "service_acquire_worker_effect" && body) {
      this.effect = {
        ...body,
        state: { tag: "Started" },
        ownerIdentity: SERVICE,
        authorityKind: "agent.run",
        leaseExpiresAtMillis: body.leaseExpiresAtMillis,
        providerReference: "",
        resultJson: "",
        updatedAt: 1_000,
      };
      return;
    }
    if (reducer === "service_update_worker_effect" && body && this.effect) {
      this.effect = {
        ...this.effect,
        state: body.outcome,
        leaseExpiresAtMillis: body.leaseExpiresAtMillis,
        providerReference: body.providerReference,
        resultJson: body.resultJson,
        updatedAt: 1_001,
      };
      return;
    }
    if (reducer === "service_prepare_agent_tool_call" && body) {
      if (this.approval) return;
      this.approval = {
        approvalId: "00000000-0000-0000-0000-000000000099",
        nonceHash: body.nonceHash,
        runId: body.runId,
        callId: body.providerCallId,
        toolName: body.toolName,
        toolVersion: body.toolVersion,
        argumentsHash: body.normalizedArgsHash,
        effectClass: body.effectClass,
        effectKey: body.effectKey,
        expiresAt: 60_000,
        state: { tag: "Pending" },
      };
      return;
    }
    if (reducer === "consume_agent_tool_approval" && this.approval) {
      this.approval = { ...this.approval, state: { tag: "Consumed" } };
      return;
    }
    if (reducer === "service_claim_file_deletion" && body) {
      this.fileClaim = {
        claimId: "00000000-0000-0000-0000-000000000077",
        generation: 2n,
        workspaceId: this.filePlan?.workspaceId,
        fileId: body.fileId,
        fileRevision: body.expectedRevision,
        key: body.key,
        objectVersionTag: body.objectVersionTag,
      };
      return;
    }
    if (
      reducer === "service_finalize_file_deletion" ||
      reducer === "service_release_file_deletion"
    ) {
      this.fileClaim = undefined;
      return;
    }
    if (
      reducer === "register_clean_file_object" ||
      reducer === "record_file_scan_outcome" ||
      reducer === "record_file_extraction" ||
      reducer === "service_record_file_orphan"
    )
      return;
    await super.reduce(reducer, input);
  }
}

const authority = (transport = new TransactionalTransport()) => ({
  transport,
  authority: new SpacetimeWorkerAuthority(transport, {
    expectedServiceIdentity: SERVICE,
    expectedBearerSubject: SUBJECT,
    now: () => 1_000,
  }),
});

test("production authority requires the exact WorkOS M2M service binding", () => {
  const transport = new TransactionalTransport();
  assert.throws(
    () =>
      new SpacetimeWorkerAuthority(transport, {
        expectedServiceIdentity: "service:other",
        expectedBearerSubject: SUBJECT,
      }),
    /spacetime_workos_service_identity_mismatch/,
  );
  const built = authority(transport).authority;
  assert.equal(built.assertProductionReady(), true);
});

test("claim transaction is reread and exact service/slot/generation fences are verified", async () => {
  const { authority: store, transport } = authority();
  const claimed = await store.claim("worker-1", 30_000);
  assert.ok(claimed);
  assert.equal(claimed.job.kind, "file.scan");
  assert.deepEqual(claimed.lease, {
    jobId: transport.row.id,
    owner: SERVICE,
    workerSlotId: "worker-1",
    generation: 1,
    expiresAt: 31_000,
  });
  assert.deepEqual(transport.calls[0], {
    name: "claim_outbox_job",
    input: {
      jobId: transport.row.id,
      expectedGeneration: 0n,
      workerSlotId: "worker-1",
      leaseSeconds: 30,
    },
  });
});

test("export completion can only use its dedicated reducer", async () => {
  const { authority: store, transport } = authority();
  transport.row = baseRow("workspace.export.generate");
  transport.exportPlan = {
    jobId: transport.row.id,
    exportId: transport.row.resourceId,
    workspaceId: transport.row.workspaceId,
    lifecycleEpoch: 1n,
    workspaceRevision: 1n,
    exportRevision: 1n,
    reconcileOnly: false,
    state: { tag: "Pending" },
    leaseOwner: null,
    workerSlotId: "",
    leaseGeneration: 0n,
  };
  const claimed = await store.claim("worker-1", 30_000);
  assert.ok(claimed);
  await store.completeWorkspaceExport(claimed.lease, {
    type: "succeeded",
    exportId: transport.row.resourceId,
    exportRevision: 1,
    artifactKey: "exports/workspace/export/archive.tar",
    contentHash: "a".repeat(64),
    artifactVersion: "object-v1",
    sizeBytes: 42,
  });
  assert.equal(transport.calls.at(-1)?.name, "complete_workspace_export");
  assert.equal(
    transport.calls.some((call) => call.name === "complete_outbox_job"),
    false,
  );
});

test("unsupported outbox insertion fails closed while generic completion stays fenced", async () => {
  const { authority: store, transport } = authority();
  await assert.rejects(
    store.enqueue({} as never),
    (error: unknown) =>
      error instanceof SpacetimeSchemaGapError &&
      error.operation === "outbox.enqueue_internal_only",
  );
  const claimed = await store.claim("worker-1", 30_000);
  assert.ok(claimed);
  await store.complete(claimed.lease, { effectLedgerOwnsThisResult: true });
  assert.equal(transport.calls.at(-1)?.name, "complete_outbox_job");
});

test("agent claims bind the authority job id separately from the derived request id", async () => {
  const transport = new AgentTransport();
  const repository = new SpacetimeAgentRunRepository(transport, () => 1_000);
  const claimed = await repository.claimExecution({
    runId: String(transport.plan.runId),
    workspaceId: String(transport.plan.workspaceId),
    authorityJobId: "00000000-0000-0000-0000-000000000001",
    requestId: `effect:${"a".repeat(64)}`,
    leaseMs: 30_000,
  });
  assert.equal(claimed.type, "claimed");
  const input = transport.calls.at(-1)?.input.input as Record<string, unknown>;
  assert.equal(input.authorityJobId, "00000000-0000-0000-0000-000000000001");
  assert.equal(input.executionRequestId, `effect:${"a".repeat(64)}`);
});

test("durable effects require and forward exact run authority", async () => {
  const transport = new AgentTransport();
  const ledger = new SpacetimeEffectLedger(transport);
  const base = {
    effectKey: `agent-provider:${"a".repeat(64)}`,
    identityFingerprint: "b".repeat(64),
    payloadFingerprint: "c".repeat(64),
    ownerId: `provider:${"d".repeat(64)}`,
    ownerGeneration: 1,
    leaseExpiresAt: 30_000,
  };
  await assert.rejects(ledger.acquire(base), /worker_effect.authority_binding/);
  const acquired = await ledger.acquire({
    ...base,
    authority: {
      workspaceId: String(transport.plan.workspaceId),
      runId: String(transport.plan.runId),
    },
  });
  assert.equal(acquired.acquired, true);
  const input = transport.calls.at(-1)?.input.input as Record<string, unknown>;
  assert.equal(input.workspaceId, transport.plan.workspaceId);
  assert.equal(input.runId, transport.plan.runId);
});

test("tool preparation hashes the nonce and consumes only the exact approved binding", async () => {
  const transport = new AgentTransport();
  const approvals = new SpacetimeApprovalStore(transport);
  const expected = {
    nonce: "one-time-secret",
    runId: String(transport.plan.runId),
    callId: "provider-call-1",
    toolName: "publish-update",
    toolVersion: "1",
    argumentsHash: "a".repeat(64),
    effectClass: "external",
  } as const;
  const effectKey = `agent-tool:${"b".repeat(64)}`;
  assert.equal(await approvals.prepareExact(expected, effectKey, 1, true, 1_000), "pending");
  assert.notEqual(transport.approval?.nonceHash, expected.nonce);
  transport.approval = { ...transport.approval, state: { tag: "Approved" } };
  assert.equal(await approvals.prepareExact(expected, effectKey, 1, true, 1_000), "approved");
  assert.equal(await approvals.consumeExact(expected, effectKey, 1_000), true);
});

test("context reads remain exact-run, exact-revision and byte bounded", async () => {
  const transport = new AgentTransport();
  transport.contextCandidate = {
    runId: transport.plan.runId,
    resourceType: "post",
    resourceId: "00000000-0000-0000-0000-000000000020",
    resourceRevision: 3n,
    title: "Status",
    body: "bounded context",
    createdAt: 1_000,
  };
  const source = new SpacetimeAgentContextSource(transport);
  const metadata = await source.list(String(transport.plan.runId));
  assert.equal(metadata.length, 1);
  assert.equal(
    await source.read(
      String(transport.plan.runId),
      metadata[0] as NonNullable<(typeof metadata)[number]>,
      100,
      new AbortController().signal,
    ),
    "bounded context",
  );
  await assert.rejects(
    source.read(
      String(transport.plan.runId),
      metadata[0] as NonNullable<(typeof metadata)[number]>,
      3,
      new AbortController().signal,
    ),
    /context_read_bound_exceeded/,
  );
});

test("file authority binds cleanup claims and outcomes to exact service rows", async () => {
  const transport = new AgentTransport();
  transport.filePlan = {
    jobId: "00000000-0000-0000-0000-000000000031",
    workspaceId: transport.plan.workspaceId,
    spaceId: "00000000-0000-0000-0000-000000000032",
    fileId: "00000000-0000-0000-0000-000000000033",
    fileRevision: 4n,
    kind: "file.cleanup",
    sourceKey: "files/workspace/file/source/1",
    sourceObjectVersion: "a".repeat(64),
    sourceChecksumSha256: "a".repeat(64),
    cleanDestinationKey: "files/workspace/file/clean/1",
    cleanupPrefix: "files/workspace/file/",
    maxBytes: 1_000n,
    maxExtractedCharacters: 500n,
    allowedTypes: ["text/plain"],
    state: { tag: "Deleted" },
    leaseGeneration: 5n,
  };
  const authority = new SpacetimeFileAuthority(transport);
  const plan = await authority.plan(
    String(transport.filePlan.workspaceId),
    String(transport.filePlan.fileId),
    4,
    "file.cleanup",
  );
  assert.ok(plan);
  const claim = await authority.claimDeletion(plan, `${plan.cleanupPrefix}clean/1`, "b".repeat(64));
  assert.deepEqual(claim, {
    claimId: "00000000-0000-0000-0000-000000000077",
    generation: 2,
    workspaceId: transport.filePlan.workspaceId,
    fileId: transport.filePlan.fileId,
    version: 4,
    key: `${plan.cleanupPrefix}clean/1`,
    objectVersionTag: "b".repeat(64),
  });
  assert.deepEqual(await authority.pendingDeletionClaims(plan), [claim]);
  await authority.releaseDeletion(claim, "object_version_changed");
  const release = transport.calls.at(-1);
  assert.ok(release);
  assert.equal(release.name, "service_release_file_deletion");
  assert.deepEqual((release.input.input as Record<string, unknown>).claim, {
    claimId: claim.claimId,
    generation: 2n,
    workspaceId: claim.workspaceId,
    fileId: claim.fileId,
    fileRevision: 4n,
    key: claim.key,
    objectVersionTag: claim.objectVersionTag,
  });
  const replacement = await authority.claimDeletion(
    plan,
    `${plan.cleanupPrefix}source/1`,
    "c".repeat(64),
  );
  assert.ok(replacement);
  await authority.finalizeDeletion(replacement);
  assert.equal(transport.calls.at(-1)?.name, "service_finalize_file_deletion");
  await authority.recordOrphanDiscrepancy(plan, `${plan.cleanupPrefix}unexpected`);
  const orphan = transport.calls.at(-1);
  assert.equal(orphan?.name, "service_record_file_orphan");
  assert.deepEqual(orphan?.input.input, {
    jobId: transport.filePlan.jobId,
    leaseGeneration: 5n,
    fileId: transport.filePlan.fileId,
    expectedRevision: 4n,
    key: `${plan.cleanupPrefix}unexpected`,
  });
  transport.fileOutcome = {
    jobId: transport.filePlan.jobId,
    workspaceId: transport.filePlan.workspaceId,
    fileId: transport.filePlan.fileId,
    fileRevision: 4n,
    kind: "file.cleanup",
    outcome: "succeeded",
  };
  assert.deepEqual(await authority.reconcile(plan, "file.cleanup"), {
    type: "succeeded",
    result: { fileId: transport.filePlan.fileId, version: 4 },
  });
});

test("clean scan registers immutable object identity before recording clean", async () => {
  const transport = new AgentTransport();
  transport.filePlan = {
    jobId: "00000000-0000-0000-0000-000000000041",
    workspaceId: transport.plan.workspaceId,
    spaceId: "00000000-0000-0000-0000-000000000042",
    fileId: "00000000-0000-0000-0000-000000000043",
    fileRevision: 2n,
    kind: "file.scan",
    sourceKey: "files/workspace/file/source/1",
    sourceObjectVersion: "a".repeat(64),
    sourceChecksumSha256: "a".repeat(64),
    cleanDestinationKey: "files/workspace/file/clean/1",
    cleanupPrefix: "files/workspace/file/",
    maxBytes: 1_000n,
    maxExtractedCharacters: 500n,
    allowedTypes: ["text/plain"],
    state: { tag: "Uploaded" },
    leaseGeneration: 3n,
  };
  const authority = new SpacetimeFileAuthority(transport);
  const plan = await authority.plan(
    String(transport.filePlan.workspaceId),
    String(transport.filePlan.fileId),
    2,
    "file.scan",
  );
  assert.ok(plan);
  assert.equal(await authority.detectedType(plan, Buffer.from("hello")), "text/plain");
  const before = transport.calls.length;
  await authority.markClean(plan, "d".repeat(64), "clamav-1.4");
  assert.deepEqual(
    transport.calls.slice(before).map((call) => call.name),
    ["register_clean_file_object", "record_file_scan_outcome"],
  );
  const registration = transport.calls[before]?.input.input as Record<string, unknown>;
  assert.equal(registration.cleanKey, transport.filePlan.cleanDestinationKey);
  assert.equal(registration.objectVersion, "d".repeat(64));
  assert.equal(registration.checksumSha256, "d".repeat(64));
});
