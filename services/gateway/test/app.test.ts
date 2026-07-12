import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway } from "../src/app.js";
import type { SearchCandidate, StoredFile } from "../src/contracts.js";
import type { TestDependencies } from "../src/testing/fakes.js";
import { createTestDependencies } from "../src/testing/fakes.js";
import { HmacSha256WebhookVerifier } from "../src/webhooks/verifier.js";
import { TEST_CONFIG } from "./helpers.js";

const bearer = { authorization: "Bearer valid-token", origin: "https://app.test" };
const readinessToken = TEST_CONFIG.readiness.token;
if (!readinessToken) throw new Error("test readiness token is required");
const readyHeaders = { "x-readiness-token": readinessToken };

function cleanFile(id: string, lifecycle: StoredFile["lifecycle"] = "clean"): StoredFile {
  return {
    id,
    objectKey: `clean/${id}`,
    objectVersion: "version-clean-1",
    checksumSha256: "b".repeat(64),
    immutable: true,
    workspaceId: "workspace-1",
    spaceId: "space-1",
    displayName: "report.pdf",
    detectedContentType: "application/pdf",
    sizeBytes: 4,
    lifecycle,
  };
}

describe("gateway security boundaries", () => {
  let app: FastifyInstance;
  let deps: TestDependencies;

  beforeEach(async () => {
    deps = createTestDependencies();
    app = await buildGateway(TEST_CONFIG, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects test-only adapters in production composition", async () => {
    await expect(
      buildGateway({ ...TEST_CONFIG, nodeEnv: "production" }, createTestDependencies()),
    ).rejects.toThrow(/durable gateway adapters/);
  });

  it("keeps detailed readiness internal and includes every critical dependency", async () => {
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(404);
    deps.webhookReceipts.readyValue = false;
    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: readyHeaders,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().checks).toContainEqual({ name: "webhook-receipts", ready: false });
    expect(response.json().checks).toContainEqual({ name: "principal-resolver", ready: true });
    expect(response.json().checks).toContainEqual({ name: "agent-tools", ready: true });
    expect(response.json().checks).toContainEqual({ name: "invitation-tokens", ready: true });
    expect(response.json().checks).toContainEqual({ name: "invitations", ready: true });
    expect(response.json().checks).toContainEqual({ name: "sessions", ready: true });
  });

  it("coalesces readiness polls and aborts a hanging probe", async () => {
    await app.close();
    let calls = 0;
    deps.readiness = [
      {
        name: "hanging",
        check: async (_signal) => {
          calls += 1;
          return new Promise<boolean>(() => undefined);
        },
      },
    ];
    app = await buildGateway(
      { ...TEST_CONFIG, readiness: { ...TEST_CONFIG.readiness, timeoutMs: 20 } },
      deps,
    );
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/health/ready", headers: readyHeaders }),
      app.inject({ method: "GET", url: "/health/ready", headers: readyHeaders }),
    ]);
    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(503);
    expect(calls).toBe(1);
  });

  it("resolves JWT subjects through authoritative identity before minting a DB token", async () => {
    deps.principalResolver.principal = {
      ...deps.principalResolver.principal,
      id: "internal-user",
      authzEpoch: 7,
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/db-token",
      headers: bearer,
      payload: { workspaceId: "workspace-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(deps.principalResolver.calls).toHaveLength(1);
    expect(deps.dbTokenBroker.calls[0]).toMatchObject({
      authzEpoch: 7,
      principal: { id: "internal-user" },
    });
    expect(deps.principalResolver.bindings).toHaveLength(1);
    expect(deps.principalResolver.bindings[0]?.resolved).toBe(deps.principalResolver.principal);
    const checked = deps.principalResolver.bindings[0]?.checked;
    expect(Object.isFrozen(checked)).toBe(true);
    expect(checked).toBe(deps.dbTokenBroker.calls[0]?.principal);
  });

  it("fails closed when the authoritative resolver returns a different issuer or subject", async () => {
    deps.principalResolver.principal = {
      ...deps.principalResolver.principal,
      issuer: "https://attacker.test",
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/db-token",
      headers: bearer,
      payload: { workspaceId: "workspace-1" },
    });
    expect(response.statusCode).toBe(401);
    expect(deps.dbTokenBroker.calls).toHaveLength(0);
  });

  it("requires a session-bound CSRF token and rejects duplicate security cookies", async () => {
    const validHeaders = {
      origin: "https://app.test",
      cookie: "__Host-session=valid-session; __Host-csrf=csrf%3Avalid-session",
      "x-csrf-token": "csrf:valid-session",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/db-token",
          headers: validHeaders,
          payload: { workspaceId: "workspace-1" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/db-token",
          headers: {
            origin: "https://app.test",
            cookie: "__Host-session=valid-session; __Host-csrf=same-but-unbound",
            "x-csrf-token": "same-but-unbound",
          },
          payload: { workspaceId: "workspace-1" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/db-token",
          headers: {
            origin: "https://app.test",
            cookie:
              "__Host-session=valid-session; __Host-session=attacker; __Host-csrf=csrf%3Avalid-session",
            "x-csrf-token": "csrf:valid-session",
          },
          payload: { workspaceId: "workspace-1" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("requires checksum-bound single-write uploads and validates observed metadata", async () => {
    const missingChecksum = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: bearer,
      payload: {
        workspaceId: "workspace-1",
        spaceId: "space-1",
        displayName: "report.pdf",
        declaredContentType: "application/pdf",
        sizeBytes: 4,
      },
    });
    expect(missingChecksum.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: bearer,
      payload: {
        workspaceId: "workspace-1",
        spaceId: "space-1",
        displayName: "report.pdf",
        declaredContentType: "application/pdf",
        sizeBytes: 4,
        checksumSha256: "a".repeat(64),
      },
    });
    expect(created.statusCode).toBe(201);
    const uploadId = created.json<{ uploadId: string }>().uploadId;
    expect(deps.objects.uploadCalls[0]?.constraints).toEqual({
      contentType: "application/pdf",
      sizeBytes: 4,
      checksumSha256: "a".repeat(64),
      singleWrite: true,
    });
    const pending = deps.files.pending.get(uploadId);
    if (!pending) throw new Error("expected pending upload");
    deps.objects.quarantine.set(pending.objectKey, {
      sizeBytes: 4,
      contentType: "text/html",
      objectVersion: "version-1",
      checksumSha256: "a".repeat(64),
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/files/uploads/${uploadId}/complete`,
          headers: bearer,
        })
      ).statusCode,
    ).toBe(409);
    deps.objects.quarantine.set(pending.objectKey, {
      sizeBytes: 4,
      contentType: "application/pdf",
      objectVersion: "version-1",
      checksumSha256: "a".repeat(64),
    });
    const completed = await app.inject({
      method: "POST",
      url: `/v1/files/uploads/${uploadId}/complete`,
      headers: bearer,
    });
    expect(completed.statusCode).toBe(200);
    expect(deps.files.observed.get(uploadId)).toMatchObject({
      objectVersion: "version-1",
      checksumSha256: "a".repeat(64),
    });
  });

  it("rejects a signer that fails to bind upload constraints", async () => {
    deps.objects.mutateUploadCapability = (value) => ({
      ...value,
      constraints: {
        ...value.constraints,
        singleWrite: true,
        sizeBytes: value.constraints.sizeBytes + 1,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: bearer,
      payload: {
        workspaceId: "workspace-1",
        spaceId: "space-1",
        displayName: "report.pdf",
        declaredContentType: "application/pdf",
        sizeBytes: 4,
        checksumSha256: "a".repeat(64),
      },
    });
    expect(response.statusCode).toBe(503);

    deps.objects.mutateUploadCapability = (value) => ({ ...value, requiredHeaders: {} });
    const missingHeaders = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: bearer,
      payload: {
        workspaceId: "workspace-1",
        spaceId: "space-1",
        displayName: "report.pdf",
        declaredContentType: "application/pdf",
        sizeBytes: 4,
        checksumSha256: "a".repeat(64),
      },
    });
    expect(missingHeaders.statusCode).toBe(503);

    deps.objects.mutateUploadCapability = (value) => ({
      ...value,
      url: "https://attacker.test/collect",
    });
    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: bearer,
      payload: {
        workspaceId: "workspace-1",
        spaceId: "space-1",
        displayName: "report.pdf",
        declaredContentType: "application/pdf",
        sizeBytes: 4,
        checksumSha256: "a".repeat(64),
      },
    });
    expect(wrongOrigin.statusCode).toBe(503);
  });

  it("rejects non-canonical or caller-mismatched upload reservations from authority", async () => {
    const createPending = deps.files.createPending.bind(deps.files);
    deps.files.createPending = async (input) => ({
      ...(await createPending(input)),
      objectKey: "../../host-escape",
      uploaderId: "another-principal",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: bearer,
      payload: {
        workspaceId: "workspace-1",
        spaceId: "space-1",
        displayName: "report.pdf",
        declaredContentType: "application/pdf",
        sizeBytes: 4,
        checksumSha256: "a".repeat(64),
      },
    });
    expect(response.statusCode).toBe(503);
    expect(deps.objects.uploadCalls).toHaveLength(0);
  });

  it("does not reveal file lifecycle before authorization and pins clean downloads to the scanned version", async () => {
    deps.files.stored.set("file-1", cleanFile("file-1", "quarantined"));
    deps.authorization.allowed = () => false;
    const denied = await app.inject({
      method: "GET",
      url: "/v1/files/file-1/download",
      headers: bearer,
    });
    expect(denied.statusCode).toBe(404);
    deps.authorization.allowed = () => true;
    const unavailableFile = await app.inject({
      method: "GET",
      url: "/v1/files/file-1/download",
      headers: bearer,
    });
    expect(unavailableFile.statusCode).toBe(404);
    expect(denied.json().error).toEqual(unavailableFile.json().error);

    deps.files.stored.set("file-1", cleanFile("file-1"));
    const download = await app.inject({
      method: "GET",
      url: "/v1/files/file-1/download",
      headers: bearer,
    });
    expect(download.statusCode).toBe(200);
    expect(deps.objects.downloadCalls[0]).toMatchObject({
      objectVersion: "version-clean-1",
      checksumSha256: "b".repeat(64),
    });
  });

  it("does not reveal upload lifecycle after uploader authorization is revoked", async () => {
    const create = async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/files/uploads",
        headers: bearer,
        payload: {
          workspaceId: "workspace-1",
          spaceId: "space-1",
          displayName: "report.pdf",
          declaredContentType: "application/pdf",
          sizeBytes: 4,
          checksumSha256: "a".repeat(64),
        },
      });
      return response.json<{ uploadId: string }>().uploadId;
    };
    const pendingId = await create();
    const quarantinedId = await create();
    const row = deps.files.pending.get(quarantinedId);
    if (!row) throw new Error("expected pending upload");
    deps.files.pending.set(quarantinedId, { ...row, lifecycle: "quarantined" });
    deps.authorization.allowed = () => false;

    const responses = await Promise.all(
      [pendingId, quarantinedId].map((uploadId) =>
        app.inject({
          method: "POST",
          url: `/v1/files/uploads/${uploadId}/complete`,
          headers: bearer,
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([404, 404]);
    expect(responses[0]?.json().error).toEqual(responses[1]?.json().error);
  });

  it("fails closed when a download signer does not preserve the scanned object version", async () => {
    deps.files.stored.set("file-1", cleanFile("file-1"));
    deps.objects.mutateDownloadCapability = (value) => ({
      ...value,
      objectVersion: "replaced-version",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/files/file-1/download",
      headers: bearer,
    });
    expect(response.statusCode).toBe(503);
  });

  it("reauthorizes search results and binds cursors to query, principal, workspace, and epoch", async () => {
    const candidates: SearchCandidate[] = [
      {
        resource: { workspaceId: "workspace-1", kind: "message", id: "visible" },
        title: "Visible",
        snippet: "safe",
        occurredAt: "2026-07-11T12:00:00.000Z",
        source: "human",
      },
      {
        resource: { workspaceId: "workspace-1", kind: "dm", id: "hidden" },
        title: "Secret",
        snippet: "must-not-leak",
        occurredAt: "2026-07-11T12:01:00.000Z",
        source: "human",
      },
      {
        resource: { workspaceId: "workspace-1", kind: "message", id: "later" },
        title: "Later",
        snippet: "safe-later",
        occurredAt: "2026-07-11T12:02:00.000Z",
        source: "human",
      },
    ];
    deps.search.candidatesList = candidates;
    deps.authorization.allowed = (request) =>
      request.action !== "search:read_result" || request.resource.id !== "hidden";
    const first = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: bearer,
      payload: { workspaceId: "workspace-1", query: "safe", limit: 1 },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json<{ items: { id: string }[]; nextCursor: string }>();
    expect(body.items).toEqual([expect.objectContaining({ id: "visible" })]);
    expect(first.body).not.toContain("must-not-leak");
    expect(first.body).not.toContain("total");
    const transplanted = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: bearer,
      payload: {
        workspaceId: "workspace-1",
        query: "different",
        limit: 1,
        cursor: body.nextCursor,
      },
    });
    expect(transplanted.statusCode).toBe(400);
  });

  it("keeps search authorization distinct for identical IDs in different spaces", async () => {
    deps.search.candidatesList = [
      {
        resource: {
          workspaceId: "workspace-1",
          kind: "message",
          id: "same-id",
          spaceId: "allowed",
        },
        title: "Allowed",
        snippet: "visible",
        occurredAt: "2026-07-11T12:00:00.000Z",
        source: "human",
      },
      {
        resource: {
          workspaceId: "workspace-1",
          kind: "message",
          id: "same-id",
          spaceId: "denied",
        },
        title: "Denied",
        snippet: "must-not-leak",
        occurredAt: "2026-07-11T12:00:00.000Z",
        source: "human",
      },
    ];
    deps.authorization.allowed = (request) => request.resource.spaceId !== "denied";
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: bearer,
      payload: { workspaceId: "workspace-1", query: "same", limit: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({ title: "Allowed", snippet: "visible" }),
    ]);
    expect(response.body).not.toContain("must-not-leak");
  });

  it("rejects unbounded search adapter fields and cursors", async () => {
    deps.search.candidatesList = [
      {
        resource: { workspaceId: "workspace-1", kind: "message", id: "x".repeat(200_000) },
        title: "Unsafe",
        snippet: "Unsafe",
        occurredAt: "2026-07-11T12:00:00.000Z",
        source: "human",
      },
    ];
    const oversizedCandidate = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: bearer,
      payload: { workspaceId: "workspace-1", query: "unsafe", limit: 1 },
    });
    expect(oversizedCandidate.statusCode).toBe(503);

    deps.search.candidatesList = [];
    deps.search.candidates = async () => ({ candidates: [], nextCursor: "x".repeat(1_025) });
    const oversizedCursor = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: bearer,
      payload: { workspaceId: "workspace-1", query: "unsafe", limit: 1 },
    });
    expect(oversizedCursor.statusCode).toBe(503);
  });

  it("filters foreign candidates, bounds returned text, and charges each external search page", async () => {
    deps.search.candidatesList = [
      {
        resource: { workspaceId: "workspace-1", kind: "message", id: "hidden" },
        title: "Hidden",
        snippet: "hidden",
        occurredAt: "2026-07-11T12:00:00.000Z",
        source: "human",
      },
      {
        resource: { workspaceId: "workspace-2", kind: "message", id: "foreign" },
        title: "Foreign",
        snippet: "must-not-cross",
        occurredAt: "2026-07-11T12:01:00.000Z",
        source: "human",
      },
      {
        resource: { workspaceId: "workspace-1", kind: "message", id: "visible" },
        title: "T".repeat(2_000),
        snippet: "S".repeat(20_000),
        occurredAt: "2026-07-11T12:02:00.000Z",
        source: "human",
      },
    ];
    deps.authorization.allowed = (request) =>
      request.action !== "search:read_result" || request.resource.id !== "hidden";
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: bearer,
      payload: { workspaceId: "workspace-1", query: "bounded", limit: 1 },
    });
    expect(response.statusCode).toBe(200);
    const item = response.json().items[0];
    expect(item.id).toBe("visible");
    expect(Buffer.byteLength(item.title, "utf8")).toBeLessThanOrEqual(
      TEST_CONFIG.search.maxTitleBytes,
    );
    expect(Buffer.byteLength(item.snippet, "utf8")).toBeLessThanOrEqual(
      TEST_CONFIG.search.maxSnippetBytes,
    );
    expect(response.body).not.toContain("must-not-cross");
    expect(deps.authorization.requests.some((request) => request.resource.id === "foreign")).toBe(
      false,
    );
    expect(
      deps.rateLimits.workspaceCalls.filter((call) => call.scope === "search-page"),
    ).toHaveLength(3);
  });

  it("rejects stale search authorization before querying the derived index", async () => {
    deps.authorization.scope = { ...deps.authorization.scope, authzEpoch: 2 };
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: bearer,
      payload: { workspaceId: "workspace-1", query: "stale", limit: 20 },
    });
    expect(response.statusCode).toBe(403);
    expect(deps.search.calls).toHaveLength(0);
  });

  it("atomically deduplicates verified webhook receipts and uses route-scoped CSRF exemption", async () => {
    const key = Buffer.alloc(32, 3);
    deps.webhooks.endpoints.set("example", {
      endpoint: { id: "endpoint-1", provider: "example", enabled: true },
      verifier: new HmacSha256WebhookVerifier([key]),
    });
    const payload = JSON.stringify({ event: "message.created" });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const eventId = "event-1";
    const signature = `v1=${createHmac("sha256", key).update(`${timestamp}.${eventId}.`).update(payload).digest("hex")}`;
    const request = {
      method: "POST" as const,
      url: "/v1/webhooks/example",
      headers: {
        "content-type": "application/json",
        "x-webhook-id": eventId,
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature,
      },
      payload,
    };
    const responses = await Promise.all([
      app.inject(request),
      app.inject(request),
      app.inject(request),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([202, 202, 202]);
    expect(responses.filter((response) => response.json().duplicate === false)).toHaveLength(1);
    expect(deps.webhookReceipts.queue).toHaveLength(1);
  });

  it("authorizes the exact tool and scopes idempotency to principal, run, and tool", async () => {
    deps.authorization.allowed = (request) => request.resource.kind !== "tool";
    const denied = await app.inject({
      method: "POST",
      url: "/v1/agent/runs/run-1/tools/calendar_lookup",
      headers: { ...bearer, "idempotency-key": "invocation:12345" },
      payload: { workspaceId: "workspace-1", arguments: {} },
    });
    expect(denied.statusCode).toBe(403);
    expect(deps.agentTools.calls).toHaveLength(0);

    deps.authorization.allowed = () => true;
    for (const runId of ["run-1", "run-2"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/agent/runs/${runId}/tools/calendar_lookup`,
            headers: { ...bearer, "idempotency-key": "invocation:12345" },
            payload: { workspaceId: "workspace-1", arguments: {} },
          })
        ).statusCode,
      ).toBe(202);
    }
    expect(deps.agentTools.calls[0]?.idempotencyScope).not.toBe(
      deps.agentTools.calls[1]?.idempotencyScope,
    );
    expect(deps.agentTools.calls[0]?.argumentsHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deps.authorization.requests).toContainEqual(
      expect.objectContaining({
        action: "agent:use_tool",
        resource: expect.objectContaining({ kind: "tool", id: "calendar_lookup" }),
      }),
    );
  });

  it("binds a stable argument fingerprint separately from the idempotency scope", async () => {
    const request = async (argumentsValue: unknown) =>
      app.inject({
        method: "POST",
        url: "/v1/agent/runs/run-1/tools/calendar_lookup",
        headers: { ...bearer, "idempotency-key": "invocation:stable" },
        payload: { workspaceId: "workspace-1", arguments: argumentsValue },
      });

    expect((await request({ beta: 2, alpha: 1 })).statusCode).toBe(202);
    expect((await request({ alpha: 1, beta: 2 })).statusCode).toBe(202);
    expect((await request({ alpha: 1, beta: 3 })).statusCode).toBe(409);

    const [first, reordered, changed] = deps.agentTools.calls.slice(-3);
    expect(first?.idempotencyScope).toBe(reordered?.idempotencyScope);
    expect(first?.argumentsHash).toBe(reordered?.argumentsHash);
    expect(changed).toBeUndefined();
  });

  it("rejects structurally abusive tool arguments before invocation", async () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent/runs/run-1/tools/calendar_lookup",
      headers: { ...bearer, "idempotency-key": "invocation:complex" },
      payload: { workspaceId: "workspace-1", arguments: nested },
    });
    expect(response.statusCode).toBe(400);
    expect(deps.agentTools.calls).toHaveLength(0);
  });

  it("issues purpose-, audience-, epoch-, and one-use-bound agent stream capabilities", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent/runs/run-1/stream-ticket",
      headers: bearer,
      payload: { workspaceId: "workspace-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(deps.agentStreams.calls[0]).toMatchObject({
      audience: "agent-stream-test",
      purpose: "agent-stream",
      authzEpoch: 1,
      singleUse: true,
    });
  });

  it("rejects an agent stream capability with an unapproved URL or expiry", async () => {
    deps.agentStreams.mutateTicket = (value) => ({
      ...value,
      streamUrl: "https://attacker.test/collect",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent/runs/run-1/stream-ticket",
      headers: bearer,
      payload: { workspaceId: "workspace-1" },
    });
    expect(response.statusCode).toBe(503);
  });

  it("enforces a principal-global budget before request-supplied workspace partitions", async () => {
    deps.rateLimits.principalAllowed = false;
    deps.rateLimits.retryAfterSeconds = 7;
    for (const workspaceId of ["guessed-1", "guessed-2"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers: bearer,
        payload: { workspaceId, query: "budgeted", limit: 20 },
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("7");
    }
    expect(deps.rateLimits.principalCalls).toHaveLength(2);
    expect(deps.rateLimits.workspaceCalls).toHaveLength(0);
  });
});

describe("proxy-aware IP limits", () => {
  it("does not trust spoofed forwarding headers in direct mode", async () => {
    const deps = createTestDependencies();
    const app = await buildGateway(
      { ...TEST_CONFIG, rateLimit: { max: 1, window: "1 minute" }, trustedProxyCidrs: [] },
      deps,
    );
    try {
      const first = await app.inject({
        method: "POST",
        url: "/v1/db-token",
        headers: { ...bearer, "x-forwarded-for": "198.51.100.1" },
        payload: { workspaceId: "workspace-1" },
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/db-token",
        headers: { ...bearer, "x-forwarded-for": "198.51.100.2" },
        payload: { workspaceId: "workspace-1" },
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(deps.rateLimits.ipCalls.map((call) => call.ip)).toEqual(["127.0.0.1", "127.0.0.1"]);
    } finally {
      await app.close();
    }
  });

  it("separates clients only when the immediate proxy is explicitly trusted", async () => {
    const deps = createTestDependencies();
    const app = await buildGateway(
      {
        ...TEST_CONFIG,
        rateLimit: { max: 1, window: "1 minute" },
        trustedProxyCidrs: ["127.0.0.1"],
      },
      deps,
    );
    try {
      const first = await app.inject({
        method: "POST",
        url: "/v1/db-token",
        headers: { ...bearer, "x-forwarded-for": "198.51.100.1" },
        payload: { workspaceId: "workspace-1" },
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/db-token",
        headers: { ...bearer, "x-forwarded-for": "198.51.100.2" },
        payload: { workspaceId: "workspace-1" },
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(deps.rateLimits.ipCalls.map((call) => call.ip)).toEqual([
        "198.51.100.1",
        "198.51.100.2",
      ]);
    } finally {
      await app.close();
    }
  });
});
