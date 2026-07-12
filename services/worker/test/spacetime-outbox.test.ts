import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSpacetimeOutboxJob,
  type SpacetimeOutboxEnvelope,
  type SpacetimeSearchWorkItem,
} from "../src/spacetime-outbox.js";

const base = (kind: string): SpacetimeOutboxEnvelope => ({
  id: `job-${kind}`,
  workspaceId: "workspace-1",
  kind,
  effectKey: `authority:${kind}:1`,
  resourceType: "resource",
  resourceId: "resource-1",
  resourceRevision: 3n,
  aclRevision: 0n,
  channel: "",
  minimalMessage: "",
  createdAt: new Date(1_000),
  nextAttemptAt: new Date(2_000),
  attempt: 0,
  state: "Pending",
  workerSlotId: "",
  leaseGeneration: 0n,
  lastError: "",
});

test("canonical SpacetimeDB envelopes decode every reviewed worker job kind", () => {
  const rows: Array<readonly [SpacetimeOutboxEnvelope, SpacetimeSearchWorkItem?]> = [
    [
      {
        ...base("notification.deliver"),
        intentId: "intent-1",
        resourceType: "notification",
        resourceId: "intent-1",
        resourceRevision: 0n,
        recipientId: "recipient-1",
        channel: "email",
        authorizationEpoch: 4n,
        minimalMessage: "You were assigned a task",
        payloadResourceId: "task-1",
      },
    ],
    [
      {
        ...base("search.upsert"),
        payloadResourceId: "post-1",
        resourceType: "post",
        resourceId: "post-1",
        version: 3n,
        aclRevision: 7n,
      },
      {
        jobId: "job-search.upsert",
        effectKey: "authority:search.upsert:1",
        workspaceId: "workspace-1",
        resourceType: "post",
        resourceId: "post-1",
        resourceRevision: 3n,
        aclRevision: 7n,
        body: "bounded indexed body",
        allowedIdentities: ["user-1"],
        tombstone: false,
      },
    ],
    [
      {
        ...base("search.tombstone"),
        payloadResourceId: "post-1",
        resourceType: "post",
        resourceId: "post-1",
        version: 3n,
        aclRevision: 8n,
      },
      {
        jobId: "job-search.tombstone",
        effectKey: "authority:search.tombstone:1",
        workspaceId: "workspace-1",
        resourceType: "post",
        resourceId: "post-1",
        resourceRevision: 3n,
        aclRevision: 8n,
        body: "",
        allowedIdentities: [],
        tombstone: true,
      },
    ],
    [
      {
        ...base("search.rebuild"),
        resourceType: "search_rebuild",
        resourceId: "rebuild-1",
        rebuildId: "rebuild-1",
        generation: 3n,
      },
    ],
    [
      {
        ...base("file.scan"),
        resourceType: "file",
        resourceId: "file-1",
        fileId: "file-1",
        version: 3n,
      },
    ],
    [
      {
        ...base("file.extract"),
        resourceType: "file",
        resourceId: "file-1",
        fileId: "file-1",
        version: 3n,
      },
    ],
    [
      {
        ...base("file.cleanup"),
        resourceType: "file",
        resourceId: "file-1",
        fileId: "file-1",
        version: 3n,
      },
    ],
    [
      {
        ...base("agent.run"),
        resourceType: "agent_run",
        resourceId: "run-1",
        resourceRevision: 1n,
        runId: "run-1",
      },
    ],
  ];

  assert.deepEqual(
    rows.map(([row, search]) => decodeSpacetimeOutboxJob(row, search).kind),
    [
      "notification.deliver",
      "search.upsert",
      "search.tombstone",
      "search.rebuild",
      "file.scan",
      "file.extract",
      "file.cleanup",
      "agent.run",
    ],
  );
  assert.equal(
    (
      decodeSpacetimeOutboxJob(rows[1]?.[0] as SpacetimeOutboxEnvelope, rows[1]?.[1]).payload as {
        body: string;
      }
    ).body,
    "bounded indexed body",
  );
  const notification = decodeSpacetimeOutboxJob(rows[0]?.[0] as SpacetimeOutboxEnvelope);
  assert.match(notification.effectKey, /^effect:[a-f0-9]{64}$/);
  assert.notEqual(notification.effectKey, rows[0]?.[0].effectKey);
  const firstAcl = decodeSpacetimeOutboxJob(rows[1]?.[0] as SpacetimeOutboxEnvelope, rows[1]?.[1]);
  const nextAclRow = { ...(rows[1]?.[0] as SpacetimeOutboxEnvelope), aclRevision: 8n };
  const nextAclSearch = { ...(rows[1]?.[1] as SpacetimeSearchWorkItem), aclRevision: 8n };
  assert.notEqual(
    firstAcl.effectKey,
    decodeSpacetimeOutboxJob(nextAclRow, nextAclSearch).effectKey,
  );
});

test("decoder rejects unknown kinds and mismatched protected search work", () => {
  assert.throws(() => decodeSpacetimeOutboxJob(base("file_scan")), /invalid_effect_kind/);
  assert.throws(
    () =>
      decodeSpacetimeOutboxJob(
        {
          ...base("search.upsert"),
          payloadResourceId: "post-1",
          version: 3n,
          aclRevision: 7n,
        },
        {
          jobId: "other-job",
          effectKey: "authority:search.upsert:1",
          workspaceId: "workspace-1",
          resourceType: "post",
          resourceId: "post-1",
          resourceRevision: 3n,
          aclRevision: 7n,
          body: "secret",
          allowedIdentities: [],
          tombstone: false,
        },
      ),
    /search_work_item_mismatch/,
  );
  assert.throws(
    () =>
      decodeSpacetimeOutboxJob(
        {
          ...base("search.upsert"),
          resourceType: "post",
          resourceId: "post-1",
          payloadResourceId: "post-1",
          version: 3n,
          aclRevision: 7n,
        },
        {
          jobId: "job-search.upsert",
          effectKey: "authority:search.upsert:1",
          workspaceId: "workspace-1",
          resourceType: "task",
          resourceId: "post-1",
          resourceRevision: 3n,
          aclRevision: 7n,
          body: "secret",
          allowedIdentities: [],
          tombstone: false,
        },
      ),
    /search_work_item_mismatch/,
  );
  assert.throws(
    () =>
      decodeSpacetimeOutboxJob(
        {
          ...base("search.upsert"),
          resourceType: "post",
          resourceId: "post-1",
          payloadResourceId: "post-1",
          version: 3n,
          aclRevision: 8n,
        },
        {
          jobId: "job-search.upsert",
          effectKey: "authority:search.upsert:1",
          workspaceId: "workspace-1",
          resourceType: "post",
          resourceId: "post-1",
          resourceRevision: 3n,
          aclRevision: 7n,
          body: "secret",
          allowedIdentities: [],
          tombstone: false,
        },
      ),
    /search_work_item_mismatch/,
  );
});
