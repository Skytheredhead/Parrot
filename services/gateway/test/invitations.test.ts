import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway } from "../src/app.js";
import { HmacInvitationTokenHasher } from "../src/invitations/token.js";
import { createTestDependencies } from "../src/testing/fakes.js";
import type { TestDependencies } from "../src/testing/fakes.js";
import { TEST_CONFIG } from "./helpers.js";

const bearer = { authorization: "Bearer valid-token", origin: "https://app.test" };

const invitation = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  workspaceId: "workspace-1",
  role: "member",
  spaceIds: ["space-2", "space-1", "space-2"],
  email: " Invitee@Example.COM ",
  expiresInSeconds: 600,
  useLimit: 1,
  ...overrides,
});

describe("invitation security boundary", () => {
  let app: FastifyInstance;
  let deps: TestDependencies;

  beforeEach(async () => {
    deps = createTestDependencies();
    deps.principalResolver.principal = {
      ...deps.principalResolver.principal,
      email: "invitee@example.com",
      emailVerified: true,
    };
    app = await buildGateway(TEST_CONFIG, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function create(body = invitation()) {
    return app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: bearer,
      payload: body,
    });
  }

  async function redeem(token: unknown) {
    return app.inject({
      method: "POST",
      url: "/v1/invitations/redeem",
      headers: bearer,
      payload: { token },
    });
  }

  it("creates at least 128 bits of bearer entropy and persists only a keyed hash", async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    const body = response.json();
    const match = /^inv1\.([^.]+)\.([A-Za-z0-9_-]{43})$/.exec(body.token);
    expect(match?.[1]).toBe(body.invitationId);
    expect(Buffer.from(match?.[2] ?? "", "base64url").byteLength).toBeGreaterThanOrEqual(16);

    const record = deps.invitations.records.get(body.invitationId);
    expect(record).toMatchObject({
      workspaceId: "workspace-1",
      normalizedEmail: "invitee@example.com",
      role: "member",
      useLimit: 1,
      spaceIds: ["space-1", "space-2"],
      tokenHash: { keyId: "test-key" },
    });
    expect(record?.tokenHash.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(record)).not.toContain(body.token);
    expect(deps.authorization.requests).toContainEqual(
      expect.objectContaining({ action: "invitation:create" }),
    );
    expect(deps.rateLimits.workspaceCalls).toContainEqual(
      expect.objectContaining({ scope: "invitation-create", workspaceId: "workspace-1" }),
    );
  });

  it("requires live creation authorization before durable storage", async () => {
    deps.authorization.allowed = () => false;
    const response = await create();
    expect(response.statusCode).toBe(403);
    expect(deps.invitations.records.size).toBe(0);
  });

  it("redeems through one atomic acceptance and membership operation", async () => {
    const created = (await create()).json();
    const response = await redeem(created.token);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.json()).toMatchObject({
      status: "accepted",
      workspaceId: "workspace-1",
      role: "member",
      useCount: 1,
      useLimit: 1,
    });
    expect(response.body).not.toContain(created.token);
    expect(deps.invitations.memberships.size).toBe(1);
    expect(deps.invitations.audits.map((entry) => entry.action)).toEqual([
      "invitation.created",
      "invitation.redeemed",
    ]);
    expect(deps.rateLimits.ipCalls.map(({ scope }) => scope)).toContain("invitation-redeem");
    expect(deps.rateLimits.principalCalls.map(({ scope }) => scope)).toContain("invitation-redeem");
  });

  it("returns one non-enumerating error for malformed, unknown, expired, revoked, and email-bound failures", async () => {
    const baseline = (await create()).json();
    const cases: Array<
      () => Promise<ReturnType<typeof redeem> extends Promise<infer T> ? T : never>
    > = [];
    cases.push(() => redeem("malformed"));
    const tamperedParts = String(baseline.token).split(".");
    const tampered = `${tamperedParts[0]}.${tamperedParts[1]}.${randomBytes(32).toString("base64url")}`;
    cases.push(() => redeem(tampered));
    cases.push(() =>
      redeem(`inv1.00000000-0000-4000-8000-000000000000.${randomBytes(32).toString("base64url")}`),
    );

    const expired = (await create(invitation({ email: undefined }))).json();
    const expiredRecord = deps.invitations.records.get(expired.invitationId);
    if (!expiredRecord) throw new Error("expected expired invitation fixture");
    Object.assign(expiredRecord, { expiresAt: "2000-01-01T00:00:00.000Z" });
    cases.push(() => redeem(expired.token));

    const revoked = (await create(invitation({ email: undefined }))).json();
    deps.invitations.revoke(revoked.invitationId);
    cases.push(() => redeem(revoked.token));

    deps.principalResolver.principal = {
      ...deps.principalResolver.principal,
      email: "different@example.com",
    };
    cases.push(() => redeem(baseline.token));

    for (const run of cases) {
      const response = await run();
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toEqual({
        code: "invitation_unavailable",
        message: "Invitation is unavailable",
      });
    }
  });

  it("requires a verified human email and enforces use limits without disclosing which check failed", async () => {
    const created = (await create(invitation({ email: undefined }))).json();
    deps.principalResolver.principal = {
      ...deps.principalResolver.principal,
      emailVerified: false,
    };
    expect((await redeem(created.token)).statusCode).toBe(404);

    deps.principalResolver.principal = {
      ...deps.principalResolver.principal,
      id: "first-user",
      email: "first@example.com",
      emailVerified: true,
    };
    expect((await redeem(created.token)).statusCode).toBe(200);
    deps.principalResolver.principal = {
      ...deps.principalResolver.principal,
      id: "second-user",
      email: "second@example.com",
    };
    const exhausted = await redeem(created.token);
    expect(exhausted.statusCode).toBe(404);
    expect(exhausted.json().error.code).toBe("invitation_unavailable");
    expect(deps.invitations.memberships.size).toBe(1);
  });

  it("applies principal and invitation-specific IP limits before atomic redemption", async () => {
    const created = (await create(invitation({ email: undefined }))).json();
    deps.rateLimits.principalAllowed = false;
    const principalLimited = await redeem(created.token);
    expect(principalLimited.statusCode).toBe(429);
    expect(deps.invitations.memberships.size).toBe(0);

    deps.rateLimits.principalAllowed = true;
    deps.rateLimits.ipAllowedFor = ({ scope }) => scope !== "invitation-redeem";
    const ipLimited = await redeem(created.token);
    expect(ipLimited.statusCode).toBe(429);
    expect(deps.rateLimits.ipCalls.at(-1)?.scope).toBe("invitation-redeem");
    expect(deps.invitations.memberships.size).toBe(0);
  });

  it("fails production composition when the invitation authority is missing or test-only", async () => {
    const production = createTestDependencies();
    await expect(
      buildGateway({ ...TEST_CONFIG, nodeEnv: "production" }, {
        ...production,
        invitations: undefined,
      } as unknown as TestDependencies),
    ).rejects.toThrow(/missing/);
    await expect(
      buildGateway({ ...TEST_CONFIG, nodeEnv: "production" }, production),
    ).rejects.toThrow(/durable gateway adapters/);
    await expect(
      buildGateway({ ...TEST_CONFIG, nodeEnv: "production" }, {
        ...production,
        invitations: {
          adapterKind: "durable",
          adapterName: "broken-invitations",
          ready: async () => true,
        },
      } as unknown as TestDependencies),
    ).rejects.toThrow(/broken-invitations:missing_method:createAtomic/);
  });
});

describe("HMAC invitation token hashing", () => {
  it("uses keyed SHA-256 hashes and constant-time fixed-length comparison", async () => {
    const hasher = new HmacInvitationTokenHasher([
      { keyId: "current", key: Buffer.alloc(32, 1) },
      { keyId: "previous", key: Buffer.alloc(32, 2) },
    ]);
    const token = `inv1.00000000-0000-4000-8000-000000000000.${randomBytes(32).toString("base64url")}`;
    const stored = await hasher.hashForStorage(token);
    expect(stored).toEqual((await hasher.verificationHashes(token))[0]);
    expect(await hasher.verify(token, stored)).toBe(true);
    expect(await hasher.verify(`${token}x`, stored)).toBe(false);
    expect(await hasher.verify(token, { ...stored, digest: "short" })).toBe(false);
  });

  it("rejects absent, duplicate, weak, and malformed key material", () => {
    expect(() => new HmacInvitationTokenHasher([])).toThrow();
    expect(
      () => new HmacInvitationTokenHasher([{ keyId: "weak", key: Buffer.alloc(16) }]),
    ).toThrow();
    expect(
      () =>
        new HmacInvitationTokenHasher([
          { keyId: "same", key: Buffer.alloc(32) },
          { keyId: "same", key: Buffer.alloc(32) },
        ]),
    ).toThrow();
  });
});
