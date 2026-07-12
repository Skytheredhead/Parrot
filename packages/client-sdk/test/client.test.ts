import { describe, expect, it, vi } from "vitest";
import { GatewayClientError, ProjectConversationClient } from "../src/index.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("ProjectConversationClient", () => {
  it("rejects unsafe base URLs", () => {
    expect(() => new ProjectConversationClient({ baseUrl: "http://api.example.test" })).toThrow(
      /HTTPS/,
    );
    expect(
      () => new ProjectConversationClient({ baseUrl: "https://user:pass@example.test" }),
    ).toThrow(/HTTPS/);
  });

  it("allows loopback HTTP for local development", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ token: "db", expiresAt: "soon" }),
    );
    const client = new ProjectConversationClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: fetcher,
    });
    await client.databaseToken("workspace-1");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses bearer authorization without reading a CSRF token", async () => {
    const csrfToken = vi.fn(() => "csrf");
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ token: "db", expiresAt: "soon" }),
    );
    const client = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      accessToken: () => "access-token",
      csrfToken,
      fetch: fetcher,
    });
    await client.databaseToken("workspace-1");
    const [, request] = fetcher.mock.calls[0] ?? [];
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer access-token");
    expect(csrfToken).not.toHaveBeenCalled();
  });

  it("sends session requests with CSRF and credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ items: [] }));
    const client = new ProjectConversationClient({
      baseUrl: "https://api.example.test/base",
      csrfToken: async () => "csrf-token",
      fetch: fetcher,
    });
    await client.search({ workspaceId: "workspace-1", query: "release" });
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.example.test/base/v1/search");
    expect(request?.credentials).toBe("include");
    expect(request?.redirect).toBe("error");
    expect(request?.cache).toBe("no-store");
    expect(new Headers(request?.headers).get("x-csrf-token")).toBe("csrf-token");
  });

  it("does not send CSRF on a download GET", async () => {
    const csrfToken = vi.fn(() => "csrf-token");
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        fileId: "file-1",
        contentType: "text/plain",
        sizeBytes: 1,
        capability: { url: "https://objects.test/file", expiresAt: "soon", objectVersion: "v1" },
      }),
    );
    const client = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      csrfToken,
      fetch: fetcher,
    });
    await client.fileDownload("file-1");
    expect(csrfToken).not.toHaveBeenCalled();
  });

  it("rejects path injection and invalid idempotency keys before fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      fetch: fetcher,
    });
    expect(() => client.completeUpload("../admin")).toThrow(/uploadId/);
    expect(() =>
      client.invokeAgentTool({
        workspaceId: "workspace-1",
        runId: "run-1",
        toolName: "email",
        idempotencyKey: "short",
        arguments: {},
      }),
    ).toThrow(/idempotencyKey/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards cancellation signals and exact idempotency headers", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ invocationId: "inv-1", status: "accepted" }),
    );
    const client = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      fetch: fetcher,
    });
    const controller = new AbortController();
    await client.invokeAgentTool(
      {
        workspaceId: "workspace-1",
        runId: "run-1",
        toolName: "email",
        idempotencyKey: "request-1234",
        arguments: { recipient: "owner@example.test" },
      },
      { signal: controller.signal },
    );
    const [, request] = fetcher.mock.calls[0] ?? [];
    expect(request?.signal).toBe(controller.signal);
    expect(new Headers(request?.headers).get("idempotency-key")).toBe("request-1234");
  });

  it("keeps invitation bearer material in a POST body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        status: "accepted",
        workspaceId: "workspace-1",
        membershipId: "membership-1",
        role: "member",
        useCount: 1,
        useLimit: 1,
      }),
    );
    const client = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      accessToken: () => "access-token",
      fetch: fetcher,
    });
    const token = `inv1.00000000-0000-4000-8000-000000000000.${"a".repeat(43)}`;
    await client.redeemInvitation(token);
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.example.test/v1/invitations/redeem");
    expect(request?.method).toBe("POST");
    expect(request?.body).toBe(JSON.stringify({ token }));
    expect(String(url)).not.toContain(token);
  });

  it("uses an authenticated CSRF-bound DELETE for session revocation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ revoked: true }));
    const client = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      csrfToken: () => "csrf-token",
      fetch: fetcher,
    });
    await client.revokeSession("session-2");
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.example.test/v1/sessions/session-2");
    expect(request?.method).toBe("DELETE");
    expect(new Headers(request?.headers).get("x-csrf-token")).toBe("csrf-token");
  });

  it("surfaces structured gateway failures and retry guidance", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        { error: { code: "rate_limited", message: "Slow down" }, requestId: "request-1234" },
        { status: 429, headers: { "retry-after": "7", "x-request-id": "request-1234" } },
      ),
    );
    const client = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      fetch: fetcher,
    });
    const failure = await client
      .search({ workspaceId: "workspace-1", query: "release" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayClientError);
    expect(failure).toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "Slow down",
      requestId: "request-1234",
      retryAfterSeconds: 7,
    });
  });

  it("rejects malformed and oversized gateway responses", async () => {
    const malformed = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      fetch: async () => new Response("not-json", { status: 200 }),
    });
    await expect(
      malformed.search({ workspaceId: "workspace-1", query: "release" }),
    ).rejects.toMatchObject({
      code: "invalid_gateway_response",
    });

    const oversized = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      maxResponseBytes: 16,
      fetch: async () => jsonResponse({ value: "x".repeat(64) }),
    });
    await expect(oversized.databaseToken("workspace-1")).rejects.toMatchObject({
      code: "response_too_large",
    });

    const wrongContentType = new ProjectConversationClient({
      baseUrl: "https://api.example.test",
      fetch: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    });
    await expect(
      wrongContentType.search({ workspaceId: "workspace-1", query: "release" }),
    ).rejects.toMatchObject({ code: "invalid_gateway_response" });
  });
});
