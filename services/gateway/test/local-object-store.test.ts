import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "../src/app.js";
import type { GatewayDependencies, ObjectCapabilityUploadGrant } from "../src/contracts.js";
import { LocalCapabilityObjectStore } from "../src/production/local-object-store.js";
import { createGatewayDependencies } from "../src/production/parrot.js";
import { createTestDependencies } from "../src/testing/fakes.js";
import { TEST_CONFIG } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(now = new Date("2026-07-12T12:00:00.000Z")) {
  const root = await mkdtemp(join(tmpdir(), "parrot-object-test-"));
  roots.push(root);
  const secret = join(root, "capability-secret");
  await writeFile(secret, "a sufficiently long mounted capability secret", { mode: 0o400 });
  const store = await LocalCapabilityObjectStore.create({
    publicOrigin: "https://parrotapi.skylarenns.com",
    rootDirectory: join(root, "objects"),
    hmacSecretFile: secret,
    maxUploadBytes: 1_024,
    now: () => now,
  });
  return { store, now, root, secret };
}

function uploadHeaders(body: Uint8Array, type = "text/plain") {
  return {
    "content-type": type,
    "content-length": String(body.byteLength),
    "x-checksum-sha256": createHash("sha256").update(body).digest("hex"),
    "if-none-match": "*",
  };
}

async function bytes(iterable: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("LocalCapabilityObjectStore", () => {
  it("streams an exact single-write upload and pins the immutable download version", async () => {
    const { store } = await fixture();
    const body = Buffer.from("hello parrot");
    const headers = uploadHeaders(body);
    const signed = await store.signQuarantineUpload({
      objectKey: "quarantine/019f54a0-8d36-7daf-b88e-105b6678d3ad",
      constraints: {
        contentType: headers["content-type"],
        sizeBytes: body.byteLength,
        checksumSha256: headers["x-checksum-sha256"],
        singleWrite: true,
      },
      ttlSeconds: 300,
    });
    expect(signed.url).toMatch(
      /^https:\/\/parrotapi\.skylarenns\.com\/v1\/object-capabilities\/upload\/[A-Za-z0-9_-]+$/,
    );
    const token = signed.url.split("/").at(-1);
    if (!token) throw new Error("missing token");
    const grant = await store.authorizeUpload({ token, method: "PUT", headers });
    const stored = await store.consumeUpload({
      grant,
      body: (async function* () {
        yield body.subarray(0, 4);
        yield body.subarray(4);
      })(),
    });
    expect(await store.headQuarantine(grant.objectKey)).toEqual({
      sizeBytes: body.byteLength,
      contentType: "text/plain",
      objectVersion: stored.objectVersion,
      checksumSha256: headers["x-checksum-sha256"],
    });

    const download = await store.signCleanDownload({
      objectKey: grant.objectKey,
      objectVersion: stored.objectVersion,
      checksumSha256: stored.checksumSha256,
      displayName: "message.txt",
      contentType: "text/plain",
      ttlSeconds: 60,
    });
    const downloadToken = download.url.split("/").at(-1);
    if (!downloadToken) throw new Error("missing download token");
    const downloadGrant = await store.authorizeDownload({ token: downloadToken, method: "GET" });
    const opened = await store.openDownload({ grant: downloadGrant });
    expect(await bytes(opened.body)).toEqual(body);
  });

  it("rejects tampering, wrong methods, header drift, encodings, and forged grants", async () => {
    const { store } = await fixture();
    const body = Buffer.from("bounded");
    const headers = uploadHeaders(body);
    const signed = await store.signQuarantineUpload({
      objectKey: "quarantine/safe-key",
      constraints: {
        contentType: "text/plain",
        sizeBytes: body.byteLength,
        checksumSha256: headers["x-checksum-sha256"],
        singleWrite: true,
      },
      ttlSeconds: 300,
    });
    const token = signed.url.split("/").at(-1) ?? "";
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    await expect(
      store.authorizeUpload({ token: tamperedToken, method: "PUT", headers }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.authorizeUpload({ token, method: "POST", headers })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      store.authorizeUpload({
        token,
        method: "PUT",
        headers: { ...headers, "content-length": String(body.byteLength + 1) },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      store.authorizeUpload({
        token,
        method: "PUT",
        headers: { ...headers, "content-encoding": "gzip" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      store.consumeUpload({
        grant: {
          capabilityId: crypto.randomUUID(),
          objectKey: "../../escape",
          objectVersion: crypto.randomUUID(),
          contentType: "text/plain",
          sizeBytes: body.byteLength,
          checksumSha256: headers["x-checksum-sha256"],
          expiresAtEpochSeconds: Number.MAX_SAFE_INTEGER,
        } as ObjectCapabilityUploadGrant,
        body: (async function* () {
          yield body;
        })(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("removes mismatched bodies and keeps object keys immutable across replay", async () => {
    const { store } = await fixture();
    const body = Buffer.from("expected");
    const headers = uploadHeaders(body);
    const signed = await store.signQuarantineUpload({
      objectKey: "quarantine/immutable-key",
      constraints: {
        contentType: "text/plain",
        sizeBytes: body.byteLength,
        checksumSha256: headers["x-checksum-sha256"],
        singleWrite: true,
      },
      ttlSeconds: 300,
    });
    const token = signed.url.split("/").at(-1) ?? "";
    const grant = await store.authorizeUpload({ token, method: "PUT", headers });
    await expect(
      store.consumeUpload({
        grant,
        body: (async function* () {
          yield Buffer.from("mismatch");
        })(),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await store.consumeUpload({
      grant,
      body: (async function* () {
        yield body;
      })(),
    });
    await expect(
      store.consumeUpload({
        grant,
        body: (async function* () {
          yield body;
        })(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects expired capabilities and non-canonical keys", async () => {
    const clock = new Date("2026-07-12T12:00:00.000Z");
    const { store } = await fixture(clock);
    const body = Buffer.from("expires");
    const headers = uploadHeaders(body);
    await expect(
      store.signQuarantineUpload({
        objectKey: "quarantine/../escape",
        constraints: {
          contentType: "text/plain",
          sizeBytes: body.byteLength,
          checksumSha256: headers["x-checksum-sha256"],
          singleWrite: true,
        },
        ttlSeconds: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const signed = await store.signQuarantineUpload({
      objectKey: "quarantine/expires",
      constraints: {
        contentType: "text/plain",
        sizeBytes: body.byteLength,
        checksumSha256: headers["x-checksum-sha256"],
        singleWrite: true,
      },
      ttlSeconds: 1,
    });
    clock.setUTCSeconds(clock.getUTCSeconds() + 2);
    await expect(
      store.authorizeUpload({ token: signed.url.split("/").at(-1) ?? "", method: "PUT", headers }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("serves the exact signed PUT data-plane route without bearer authentication", async () => {
    const { store } = await fixture();
    const body = Buffer.from("route stream");
    const headers = uploadHeaders(body);
    const signed = await store.signQuarantineUpload({
      objectKey: "quarantine/route-key",
      constraints: {
        contentType: "text/plain",
        sizeBytes: body.byteLength,
        checksumSha256: headers["x-checksum-sha256"],
        singleWrite: true,
      },
      ttlSeconds: 300,
    });
    const deps: GatewayDependencies = createTestDependencies();
    deps.objects = store;
    deps.objectCapabilities = store;
    const app = await buildGateway(
      {
        ...TEST_CONFIG,
        allowedOrigins: ["https://app.test"],
        files: {
          ...TEST_CONFIG.files,
          capabilityOrigins: ["https://parrotapi.skylarenns.com"],
        },
      },
      deps,
    );
    try {
      const response = await app.inject({
        method: "PUT",
        url: new URL(signed.url).pathname,
        headers: { ...headers, origin: "https://app.test" },
        payload: body,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        checksumSha256: headers["x-checksum-sha256"],
        sizeBytes: body.byteLength,
      });
    } finally {
      await app.close();
    }
  });

  it("keeps the partial production graph fail-closed without test or in-memory authority", async () => {
    const { root, secret } = await fixture();
    const config = {
      ...TEST_CONFIG,
      nodeEnv: "production" as const,
      files: {
        ...TEST_CONFIG.files,
        capabilityOrigins: ["https://parrotapi.skylarenns.com"],
      },
      production: {
        fileCapabilityPublicOrigin: "https://parrotapi.skylarenns.com",
        localObjectRoot: join(root, "production-objects"),
        fileCapabilityHmacSecretFile: secret,
        spacetime: {
          uri: "ws://127.0.0.1:3001",
          databaseName: "parrot-staging",
          connectTimeoutMs: 1_000,
          commandTimeoutMs: 500,
        },
        gatewaySqlitePath: join(root, "gateway-state.sqlite"),
      },
    };
    const deps = await createGatewayDependencies(config);
    expect(deps.tokenVerifier.adapterName).toBe("oidc-jwks");
    expect(deps.objects.adapterName).toBe("host-local-immutable-object-capabilities");
    expect(await deps.authorization.ready(new AbortController().signal)).toBe(true);
    expect(deps.authorization.adapterName).toBe("caller-attested-spacetimedb-authority");
    expect(deps.rateLimits.adapterName).toBe("host-local-sqlite-rate-limits");
    expect(deps.search.adapterName).toBe("disabled-surface:search-provider");
    expect(await deps.search.ready(new AbortController().signal)).toBe(true);
    await expect(
      deps.search.candidates({
        query: "disabled",
        scope: { workspaceId: "workspace", spaceIds: [], dmMembershipKeys: [], authzEpoch: 0 },
        limit: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    const app = await buildGateway(config, deps);
    await app.close();
  });
});
