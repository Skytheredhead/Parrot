import assert from "node:assert/strict";
import test from "node:test";
import {
  EnvValidationError,
  FileProcessingHandler,
  InMemoryObjectStore,
  InMemorySearchBackend,
  SearchIndexHandler,
  loadWorkerConfig,
  newJob,
  type FileAuthority,
  type FileProcessingPlan,
  type MalwareScanner,
  type SearchDocument,
  type SearchRebuildSource,
  type TextExtractor,
} from "../src/index.js";

test("environment validation rejects unsafe lease and heartbeat settings", () => {
  assert.throws(
    () =>
      loadWorkerConfig({
        WORKER_ENVIRONMENT: "production",
        WORKER_ID: "worker-1",
        WORKER_LEASE_MS: "1000",
        WORKER_HEARTBEAT_MS: "600",
      }),
    EnvValidationError,
  );
});

test("process configuration rejects relative adapter modules and unbounded claims", () => {
  assert.throws(
    () =>
      loadWorkerConfig({
        WORKER_ENVIRONMENT: "production",
        WORKER_ID: "worker-1",
        WORKER_ADAPTER_MODULE: "./adapter.js",
        WORKER_LEASE_MS: "1000",
        WORKER_HEARTBEAT_MS: "100",
        WORKER_CLAIM_TIMEOUT_MS: "1000",
      }),
    (error: unknown) =>
      error instanceof EnvValidationError &&
      error.issues.some((issue) => issue.includes("WORKER_ADAPTER_MODULE")) &&
      error.issues.some((issue) => issue.includes("WORKER_CLAIM_TIMEOUT_MS")),
  );
});

test("search index ignores stale versions and applies tombstones monotonically", async () => {
  const backend = new InMemorySearchBackend();
  const handler = new SearchIndexHandler(backend, backend);
  const upsert = newJob(
    {
      id: "search-1",
      workspaceId: "workspace-1",
      kind: "search.upsert",
      effectKey: "search:resource-1:2",
      payload: {
        resourceId: "resource-1",
        resourceRevision: 2,
        aclRevision: 1,
        body: "new text",
        visibilityIds: ["space-1"],
      },
    },
    0,
  );
  await handler.execute(upsert, upsert.effectKey, new AbortController().signal);
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    resourceRevision: 1,
    aclRevision: 1,
    body: "stale text",
    visibilityIds: ["space-1"],
    tombstone: false,
  });
  assert.equal(backend.index.get("workspace-1:resource-1")?.body, "new text");

  const tombstone = newJob(
    {
      id: "search-2",
      workspaceId: "workspace-1",
      kind: "search.tombstone",
      effectKey: "search:resource-1:3",
      payload: {
        resourceId: "resource-1",
        resourceRevision: 3,
        aclRevision: 1,
        visibilityIds: [],
      },
    },
    0,
  );
  await handler.execute(tombstone, tombstone.effectKey, new AbortController().signal);
  assert.equal(backend.index.get("workspace-1:resource-1")?.tombstone, true);
  assert.equal(backend.index.get("workspace-1:resource-1")?.resourceRevision, 3);
});

test("search rebuild remains shadowed after a crash and activates atomically with concurrent deltas", async () => {
  const backend = new InMemorySearchBackend();
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "old",
    resourceRevision: 1,
    aclRevision: 1,
    body: "still queryable",
    visibilityIds: [],
    tombstone: false,
  });
  const crashingSource: SearchRebuildSource = {
    adapterKind: "test-only",
    adapterName: "crashing-rebuild-source",
    async *documents(): AsyncIterable<SearchDocument> {
      yield {
        workspaceId: "workspace-1",
        resourceId: "new",
        resourceRevision: 1,
        aclRevision: 1,
        body: "shadow only",
        visibilityIds: [],
        tombstone: false,
      };
      throw new Error("source_crashed");
    },
  };
  const handler = new SearchIndexHandler(backend, crashingSource);
  const job = newJob(
    {
      id: "rebuild-1",
      workspaceId: "workspace-1",
      kind: "search.rebuild",
      effectKey: "rebuild:1",
      payload: { rebuildId: "generation-1", generation: 1 },
    },
    0,
  );
  await assert.rejects(
    handler.execute(job, job.effectKey, new AbortController().signal),
    /source_crashed/,
  );
  assert.equal(backend.index.get("workspace-1:old")?.body, "still queryable");
  assert.equal(backend.index.has("workspace-1:new"), false);

  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "delta",
    resourceRevision: 2,
    aclRevision: 1,
    body: "arrived during rebuild",
    visibilityIds: [],
    tombstone: false,
  });
  await backend.activateRebuild("workspace-1", "generation-1", 1);
  assert.equal(backend.index.get("workspace-1:new")?.body, "shadow only");
  assert.equal(backend.index.get("workspace-1:delta")?.body, "arrived during rebuild");
  assert.equal(backend.index.has("workspace-1:old"), false);
});

test("an older concurrent search rebuild generation can never replace a newer one", async () => {
  const backend = new InMemorySearchBackend();
  assert.equal(await backend.beginRebuild("workspace-1", "older", 1), "started");
  await backend.applyRebuild("workspace-1", "older", 1, {
    workspaceId: "workspace-1",
    resourceId: "result",
    resourceRevision: 1,
    aclRevision: 1,
    body: "old generation",
    visibilityIds: [],
    tombstone: false,
  });
  assert.equal(await backend.beginRebuild("workspace-1", "newer", 2), "started");
  await backend.applyRebuild("workspace-1", "newer", 2, {
    workspaceId: "workspace-1",
    resourceId: "result",
    resourceRevision: 1,
    aclRevision: 1,
    body: "new generation",
    visibilityIds: [],
    tombstone: false,
  });
  assert.equal(await backend.activateRebuild("workspace-1", "newer", 2), "activated");
  assert.equal(await backend.activateRebuild("workspace-1", "older", 1), "stale");
  assert.equal(backend.index.get("workspace-1:result")?.body, "new generation");
  assert.equal(await backend.activeGeneration("workspace-1"), 2);
});

test("search equal-version conflicts cannot resurrect tombstones or alter content", async () => {
  const backend = new InMemorySearchBackend();
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    resourceRevision: 4,
    aclRevision: 1,
    body: "live",
    visibilityIds: [],
    tombstone: false,
  });
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    resourceRevision: 4,
    aclRevision: 1,
    body: "",
    visibilityIds: [],
    tombstone: true,
  });
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    resourceRevision: 4,
    aclRevision: 1,
    body: "resurrected",
    visibilityIds: [],
    tombstone: false,
  });
  assert.equal(backend.index.get("workspace-1:resource-1")?.tombstone, true);

  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "resource-2",
    resourceRevision: 1,
    aclRevision: 1,
    body: "one",
    visibilityIds: [],
    tombstone: false,
  });
  await assert.rejects(
    backend.apply({
      workspaceId: "workspace-1",
      resourceId: "resource-2",
      resourceRevision: 1,
      aclRevision: 1,
      body: "two",
      visibilityIds: [],
      tombstone: false,
    }),
    /search_version_conflict/,
  );
});

test("ACL generation orders before content revision under adversarial delivery", async () => {
  const backend = new InMemorySearchBackend();
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "restricted-live",
    resourceRevision: 2,
    aclRevision: 10,
    body: "current restricted body",
    visibilityIds: ["remaining-user"],
    tombstone: false,
  });
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "restricted-live",
    resourceRevision: 9_999,
    aclRevision: 9,
    body: "stale broadly visible body",
    visibilityIds: ["remaining-user", "revoked-user"],
    tombstone: false,
  });
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "restricted-live",
    resourceRevision: 10_000,
    aclRevision: 9,
    body: "",
    visibilityIds: [],
    tombstone: true,
  });
  assert.deepEqual(backend.index.get("workspace-1:restricted-live")?.visibilityIds, [
    "remaining-user",
  ]);
  assert.equal(backend.index.get("workspace-1:restricted-live")?.tombstone, false);

  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "restricted-deleted",
    resourceRevision: 1,
    aclRevision: 20,
    body: "",
    visibilityIds: [],
    tombstone: true,
  });
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "restricted-deleted",
    resourceRevision: 50_000,
    aclRevision: 19,
    body: "must not resurrect",
    visibilityIds: ["revoked-user"],
    tombstone: false,
  });
  assert.equal(backend.index.get("workspace-1:restricted-deleted")?.tombstone, true);
});

test("a newer ACL delta dominates stale rebuild content with a higher resource revision", async () => {
  const backend = new InMemorySearchBackend();
  assert.equal(await backend.beginRebuild("workspace-1", "rebuild-acl", 1), "started");
  await backend.applyRebuild("workspace-1", "rebuild-acl", 1, {
    workspaceId: "workspace-1",
    resourceId: "document-1",
    resourceRevision: 1_000,
    aclRevision: 4,
    body: "stale rebuild body",
    visibilityIds: ["revoked-user"],
    tombstone: false,
  });
  await backend.apply({
    workspaceId: "workspace-1",
    resourceId: "document-1",
    resourceRevision: 1,
    aclRevision: 5,
    body: "current restricted body",
    visibilityIds: ["remaining-user"],
    tombstone: false,
  });
  assert.equal(await backend.activateRebuild("workspace-1", "rebuild-acl", 1), "activated");
  assert.deepEqual(backend.index.get("workspace-1:document-1")?.visibilityIds, ["remaining-user"]);
  assert.equal(backend.index.get("workspace-1:document-1")?.aclRevision, 5);
  assert.equal(backend.index.get("workspace-1:document-1")?.resourceRevision, 1);
});

const filePlan: FileProcessingPlan = {
  workspaceId: "workspace-1",
  fileId: "file-1",
  version: 2,
  sourceKey: "uploads/workspace-1/file-1/v2",
  cleanDestinationKey: "clean/workspace-1/file-1/v2",
  cleanupPrefix: "tmp/workspace-1/file-1/",
  allowedTypes: ["text/plain"],
  maxBytes: 8,
  maxExtractedCharacters: 8,
};

const fileAuthority = (overrides: Partial<FileAuthority> = {}): FileAuthority => ({
  adapterKind: "test-only",
  adapterName: "test-file-authority",
  async plan() {
    return filePlan;
  },
  async detectedType() {
    return "text/plain";
  },
  async markClean() {},
  async markRejected() {},
  async recordExtractedText() {},
  async claimDeletion(plan, key, objectVersionTag) {
    return key.endsWith("allowed")
      ? {
          claimId: `claim:${key}`,
          generation: 1,
          workspaceId: plan.workspaceId,
          fileId: plan.fileId,
          version: plan.version,
          key,
          objectVersionTag,
        }
      : undefined;
  },
  async finalizeDeletion() {},
  async releaseDeletion() {},
  async pendingDeletionClaims() {
    return [];
  },
  async recordOrphanDiscrepancy() {},
  async reconcile() {
    return { type: "not_found" };
  },
  ...overrides,
});

const scanner: MalwareScanner = {
  adapterKind: "test-only",
  adapterName: "test-malware-scanner",
  async scan(_bytes, signal) {
    assert.equal(signal.aborted, false);
    return { clean: true, engine: "test" };
  },
};

const extractor: TextExtractor = {
  adapterKind: "test-only",
  adapterName: "test-text-extractor",
  async extract(bytes) {
    return Buffer.from(bytes).toString("utf8");
  },
};

test("file processing rejects payload key and cleanup-prefix substitution before object access", async () => {
  const store = new InMemoryObjectStore();
  store.objects.set("victim/other-tenant", Buffer.from("secret"));
  store.objects.set("tmp/workspace-1/file-1/allowed", Buffer.from("ok"));
  const handler = new FileProcessingHandler(store, scanner, extractor, fileAuthority());
  const scanJob = newJob(
    {
      id: "file-scan",
      workspaceId: "workspace-1",
      kind: "file.scan",
      effectKey: "file:scan",
      payload: { fileId: "file-1", version: 2, objectKey: "victim/other-tenant" },
    },
    0,
  );
  assert.deepEqual(
    await handler.execute(scanJob, scanJob.effectKey, new AbortController().signal),
    { type: "permanent_failure", code: "file_plan_mismatch" },
  );
  assert.deepEqual(store.reads, []);

  const cleanupJob = newJob(
    {
      id: "file-cleanup",
      workspaceId: "workspace-1",
      kind: "file.cleanup",
      effectKey: "file:cleanup",
      payload: { fileId: "file-1", version: 2, prefix: "victim/" },
    },
    0,
  );
  assert.deepEqual(
    await handler.execute(cleanupJob, cleanupJob.effectKey, new AbortController().signal),
    { type: "permanent_failure", code: "file_plan_mismatch" },
  );
  assert.deepEqual(store.deletions, []);
});

test("file cleanup derives its prefix from authority and reauthorizes every object", async () => {
  const store = new InMemoryObjectStore();
  store.objects.set("tmp/workspace-1/file-1/allowed", Buffer.from("a"));
  store.objects.set("tmp/workspace-1/file-1/denied", Buffer.from("b"));
  store.objects.set("tmp/other-tenant/allowed", Buffer.from("c"));
  const discrepancies: string[] = [];
  const authority = fileAuthority({
    async recordOrphanDiscrepancy(_plan, key) {
      discrepancies.push(key);
    },
  });
  const handler = new FileProcessingHandler(store, scanner, extractor, authority);
  const job = newJob(
    {
      id: "cleanup-valid",
      workspaceId: "workspace-1",
      kind: "file.cleanup",
      effectKey: "cleanup:valid",
      payload: { fileId: "file-1", version: 2 },
    },
    0,
  );
  assert.deepEqual(await handler.execute(job, job.effectKey, new AbortController().signal), {
    type: "succeeded",
    result: { deleted: 1 },
  });
  assert.deepEqual(store.deletions, ["tmp/workspace-1/file-1/allowed"]);
  assert.deepEqual(discrepancies, ["tmp/workspace-1/file-1/denied"]);
  assert.equal(store.objects.has("tmp/other-tenant/allowed"), true);
});

test("file cleanup conditionally deletes the exact object version claimed by authority", async () => {
  const store = new InMemoryObjectStore();
  const key = "tmp/workspace-1/file-1/allowed";
  store.objects.set(key, Buffer.from("original"));
  const releases: string[] = [];
  const authority = fileAuthority({
    async claimDeletion(plan, claimKey, objectVersionTag) {
      store.objects.set(claimKey, Buffer.from("replacement"));
      return {
        claimId: "claim-race",
        generation: 1,
        workspaceId: plan.workspaceId,
        fileId: plan.fileId,
        version: plan.version,
        key: claimKey,
        objectVersionTag,
      };
    },
    async releaseDeletion(_claim, code) {
      releases.push(code);
    },
  });
  const handler = new FileProcessingHandler(store, scanner, extractor, authority);
  const job = newJob(
    {
      id: "cleanup-race",
      workspaceId: "workspace-1",
      kind: "file.cleanup",
      payload: { fileId: "file-1", version: 2 },
    },
    0,
  );
  assert.deepEqual(await handler.execute(job, job.effectKey, new AbortController().signal), {
    type: "succeeded",
    result: { deleted: 0 },
  });
  assert.equal(Buffer.from(store.objects.get(key) ?? []).toString("utf8"), "replacement");
  assert.deepEqual(releases, ["object_version_changed"]);
});

test("file cleanup reconciliation finalizes a stranded claim after object deletion", async () => {
  const store = new InMemoryObjectStore();
  const claim = {
    claimId: "stranded-claim",
    generation: 3,
    workspaceId: filePlan.workspaceId,
    fileId: filePlan.fileId,
    version: filePlan.version,
    key: "tmp/workspace-1/file-1/already-deleted",
    objectVersionTag: "deleted-version",
  };
  const finalized: string[] = [];
  const authority = fileAuthority({
    async pendingDeletionClaims() {
      return [claim];
    },
    async finalizeDeletion(value) {
      finalized.push(value.claimId);
    },
    async reconcile() {
      return { type: "succeeded", result: { cleanup: true } };
    },
  });
  const handler = new FileProcessingHandler(store, scanner, extractor, authority);
  const job = newJob(
    {
      id: "cleanup-reconcile",
      workspaceId: filePlan.workspaceId,
      kind: "file.cleanup",
      payload: { fileId: filePlan.fileId, version: filePlan.version },
    },
    0,
  );
  assert.deepEqual(await handler.reconcile(job.effectKey, job, new AbortController().signal), {
    type: "succeeded",
    result: { cleanup: true },
  });
  assert.deepEqual(finalized, ["stranded-claim"]);
});

test("file reads and extraction are bounded and lifecycle reconciliation is authoritative", async () => {
  const store = new InMemoryObjectStore();
  store.objects.set(filePlan.sourceKey ?? "", Buffer.from("0123456789"));
  let scans = 0;
  const boundedScanner: MalwareScanner = {
    adapterKind: "test-only",
    adapterName: "bounded-test-scanner",
    async scan() {
      scans += 1;
      return { clean: true, engine: "test" };
    },
  };
  const authority = fileAuthority({
    async reconcile() {
      return { type: "succeeded", result: { fileId: "file-1", version: 2 } };
    },
  });
  const handler = new FileProcessingHandler(store, boundedScanner, extractor, authority);
  const job = newJob(
    {
      id: "bounded-file",
      workspaceId: "workspace-1",
      kind: "file.scan",
      effectKey: "bounded:file",
      payload: { fileId: "file-1", version: 2 },
    },
    0,
  );
  await assert.rejects(
    handler.execute(job, job.effectKey, new AbortController().signal),
    /file_size_limit_exceeded/,
  );
  assert.equal(scans, 0);
  assert.deepEqual(await handler.reconcile(job.effectKey, job, new AbortController().signal), {
    type: "succeeded",
    result: { fileId: "file-1", version: 2 },
  });

  const mismatched = new FileProcessingHandler(
    store,
    boundedScanner,
    extractor,
    fileAuthority({
      async plan() {
        return { ...filePlan, workspaceId: "other-workspace" };
      },
    }),
  );
  assert.deepEqual(await mismatched.reconcile(job.effectKey, job, new AbortController().signal), {
    type: "unknown",
  });
});
