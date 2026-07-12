import { describe, expect, it, vi } from "vitest";
import {
  addThreadReply,
  bootstrapOwner,
  connectTicketedRealtime,
  createNamedThread,
  LIVE_QUERIES,
  readProductionConfig,
  uploadFileWithCapability,
} from "./production-runtime.js";

const location = { origin: "https://parrot.skylarenns.com", pathname: "/" };

describe("Parrot production runtime", () => {
  it("never silently enables demo mode for a production build", () => {
    const config = readProductionConfig({ MODE: "production", PROD: true }, location);
    expect(config.live).toBe(true);
    expect(config.configured).toBe(false);
    expect(config.missing).toEqual([
      "VITE_WORKOS_API_HOSTNAME",
      "VITE_SPACETIMEDB_URI",
      "VITE_SPACETIMEDB_DATABASE_NAME",
    ]);
  });

  it("allows explicitly isolated WorkOS staging mode without an auth API hostname", () => {
    const config = readProductionConfig(
      {
        MODE: "production",
        PROD: true,
        VITE_WORKOS_DEV_MODE: "true",
        VITE_SPACETIMEDB_URI: "wss://db.example.test",
        VITE_SPACETIMEDB_DATABASE_NAME: "parrot",
        VITE_PARROT_WORKSPACE_ID: "01900000-0000-7000-8000-000000000001",
      },
      location,
    );
    expect(config.configured).toBe(true);
    expect(config.devMode).toBe(true);
    expect(config.redirectUri).toBe("https://parrot.skylarenns.com/callback");
  });

  it("mints a fresh gateway ticket for every initial connection and reconnect", async () => {
    const gateway = {
      databaseToken: vi
        .fn()
        .mockResolvedValueOnce({ token: "ticket-1", expiresAt: "later" })
        .mockResolvedValueOnce({ token: "ticket-2", expiresAt: "later" }),
    };
    const connect = vi.fn(({ token }) => token);
    const input = { gateway, workspaceId: "workspace-1", connect };

    await expect(connectTicketedRealtime(input)).resolves.toBe("ticket-1");
    await expect(connectTicketedRealtime(input)).resolves.toBe("ticket-2");
    expect(gateway.databaseToken).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls.map(([options]) => options.token)).toEqual(["ticket-1", "ticket-2"]);
  });

  it("subscribes only to caller-scoped public views", () => {
    expect(LIVE_QUERIES).toContain("SELECT * FROM my_workspaces");
    expect(LIVE_QUERIES).toContain("SELECT * FROM visible_posts");
    expect(LIVE_QUERIES.some((query) => query.includes("pending_outbox"))).toBe(false);
  });

  it("uses the checksum-bound capability before completing an upload", async () => {
    const bytes = new TextEncoder().encode("parrot");
    const file = {
      name: "brief.txt",
      type: "text/plain",
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    };
    const gateway = {
      createUpload: vi.fn().mockResolvedValue({
        uploadId: "upload-1",
        capability: {
          url: "https://objects.example.test/one-write",
          method: "PUT",
          requiredHeaders: { "x-required": "bound" },
        },
      }),
      completeUpload: vi.fn().mockResolvedValue({ uploadId: "upload-1", lifecycle: "quarantined" }),
    };
    const fetcher = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      uploadFileWithCapability({ gateway, workspaceId: "ws", spaceId: "space", file, fetcher }),
    ).resolves.toEqual({ uploadId: "upload-1", lifecycle: "quarantined" });
    expect(gateway.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "brief.txt",
        checksumSha256: "4488b8b86b1ac061dbe37242297e5827dad889823fd1a5acaed43dec0108d048",
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://objects.example.test/one-write",
      expect.objectContaining({
        method: "PUT",
        headers: { "x-required": "bound" },
        credentials: "omit",
        redirect: "error",
      }),
    );
    expect(gateway.completeUpload).toHaveBeenCalledWith("upload-1");
  });

  it("uses generated workspace, named-thread, and contribution reducer contracts", async () => {
    const connection = {
      reducers: {
        bootstrapOwner: vi.fn(),
        createNamedThread: vi.fn(),
        addContribution: vi.fn(),
      },
    };
    const postId = "01900000-0000-7000-8000-000000000001";
    const threadId = "01900000-0000-7000-8000-000000000002";

    await bootstrapOwner(connection, "Skylar Enns");
    await createNamedThread(connection, postId, "Opening tease");
    await addThreadReply(connection, threadId, "Ready for review.");

    expect(connection.reducers.bootstrapOwner).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Skylar Enns", workspaceName: "Parrot" }),
    );
    expect(connection.reducers.createNamedThread).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Opening tease", rootPostId: expect.anything() }),
    );
    expect(connection.reducers.addContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Ready for review.",
        kind: { tag: "Message" },
        parentContributionId: undefined,
      }),
    );
  });
});
