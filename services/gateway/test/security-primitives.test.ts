import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { safeErrorFields } from "../src/observability.js";
import { HmacSearchCursorCodec } from "../src/search/cursor.js";
import { HmacSha256WebhookVerifier } from "../src/webhooks/verifier.js";

describe("security primitives", () => {
  it("binds and authenticates search cursor state", async () => {
    const codec = new HmacSearchCursorCodec([Buffer.alloc(32, 1)]);
    const binding = {
      principalId: "user-1",
      workspaceId: "workspace-1",
      queryHash: "query-hash",
      authzEpoch: 4,
    };
    const cursor = await codec.encode({
      ...binding,
      engineCursor: "engine-page-2",
      expiresAt: 200,
    });
    await expect(codec.decode(cursor, binding, 100)).resolves.toBe("engine-page-2");
    await expect(
      codec.decode(cursor, { ...binding, principalId: "user-2" }, 100),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(codec.decode(cursor, { ...binding, authzEpoch: 5 }, 100)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(codec.decode(cursor, binding, 201)).rejects.toMatchObject({ statusCode: 400 });
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    await expect(codec.decode(tampered, binding, 100)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("supports webhook key rotation while rejecting bad signatures and stale timestamps", async () => {
    const oldKey = Buffer.alloc(32, 2);
    const currentKey = Buffer.alloc(32, 3);
    const verifier = new HmacSha256WebhookVerifier([currentKey, oldKey]);
    const body = Buffer.from('{"event":"test"}');
    const receivedAt = new Date("2026-07-11T12:00:00.000Z");
    const timestamp = String(Math.floor(receivedAt.getTime() / 1_000));
    const eventId = "event-rotation";
    const signature = createHmac("sha256", oldKey)
      .update(`${timestamp}.${eventId}.`)
      .update(body)
      .digest("hex");
    await expect(
      verifier.verify({
        headers: {
          "x-webhook-id": eventId,
          "x-webhook-timestamp": timestamp,
          "x-webhook-signature": `v1=${"0".repeat(64)},v1=${signature}`,
        },
        body,
        receivedAt,
        maxSkewSeconds: 300,
      }),
    ).resolves.toEqual({ eventId });
    await expect(
      verifier.verify({
        headers: {
          "x-webhook-id": eventId,
          "x-webhook-timestamp": String(Number(timestamp) - 301),
          "x-webhook-signature": `v1=${signature}`,
        },
        body,
        receivedAt,
        maxSkewSeconds: 300,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("allowlists error fields instead of serializing nested provider secrets", () => {
    const error = Object.assign(
      new Error("signed=https://objects.test/file?signature=top-secret"),
      {
        code: "ETIMEDOUT",
        retryable: true,
        config: { headers: { authorization: "Bearer top-secret" } },
      },
    );
    const fields = safeErrorFields(error);
    expect(fields).toEqual({ name: "Error", code: "ETIMEDOUT", retryable: true });
    expect(JSON.stringify(fields)).not.toContain("top-secret");
    expect(JSON.stringify(fields)).not.toContain("authorization");
  });
});
