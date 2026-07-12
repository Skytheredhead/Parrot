import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway } from "../src/app.js";
import { TEST_IDENTITY, createTestDependencies } from "../src/testing/fakes.js";
import type { TestDependencies } from "../src/testing/fakes.js";
import { TEST_CONFIG } from "./helpers.js";

const bearer = { authorization: "Bearer valid-token", origin: "https://app.test" };
const cookie = {
  origin: "https://app.test",
  cookie: "__Host-session=valid-session; __Host-csrf=csrf%3Avalid-session",
  "x-csrf-token": "csrf:valid-session",
};

describe("user session administration", () => {
  let app: FastifyInstance;
  let deps: TestDependencies;

  beforeEach(async () => {
    deps = createTestDependencies();
    app = await buildGateway(TEST_CONFIG, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists bounded allowlisted metadata for only the current human principal", async () => {
    deps.sessions.add("other-user", {
      sessionId: "foreign-session",
      current: false,
      createdAt: "2026-07-01T12:00:00.000Z",
      lastSeenAt: "2026-07-02T12:00:00.000Z",
      expiresAt: "2026-07-20T12:00:00.000Z",
      kind: "api",
    });
    const originalList = deps.sessions.listOwned.bind(deps.sessions);
    deps.sessions.listOwned = async (input) =>
      (await originalList(input)).map((session) => ({
        ...session,
        refreshToken: "must-not-leak",
        remoteAddress: "192.0.2.1",
      }));

    const response = await app.inject({ method: "GET", url: "/v1/sessions", headers: bearer });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().sessions).toHaveLength(2);
    expect(response.json().sessions).toContainEqual(
      expect.objectContaining({ sessionId: "session-1", current: true, kind: "browser" }),
    );
    expect(response.body).not.toContain("foreign-session");
    expect(response.body).not.toContain("must-not-leak");
    expect(response.body).not.toContain("192.0.2.1");
    expect(deps.rateLimits.principalCalls.at(-1)?.scope).toBe("session-list");
  });

  it("fails closed when the session authority exceeds the response bound", async () => {
    deps.sessions.listOwned = async () =>
      Array.from({ length: 51 }, (_, index) => ({
        sessionId: `session-${index + 10}`,
        current: false,
        createdAt: "2026-07-01T12:00:00.000Z",
        lastSeenAt: "2026-07-02T12:00:00.000Z",
        expiresAt: "2026-07-20T12:00:00.000Z",
        kind: "browser" as const,
      }));
    const response = await app.inject({ method: "GET", url: "/v1/sessions", headers: bearer });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("session-10");
  });

  it("atomically revokes an owned session and records bounded audit metadata", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/sessions/session-2",
      headers: bearer,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: true });
    expect(deps.sessions.sessions.get("session-2")?.revoked).toBe(true);
    expect(deps.sessions.audits.at(-1)).toMatchObject({
      action: "session.revoked",
      actorId: "user-1",
      targetSessionId: "session-2",
      reason: "user_requested",
    });
    expect(deps.rateLimits.ipCalls.at(-1)?.scope).toBe("session-revoke");
  });

  it("uses one non-enumerating response for malformed, unknown, foreign, and already-revoked IDs", async () => {
    deps.sessions.add("other-user", {
      sessionId: "foreign-session",
      current: false,
      createdAt: "2026-07-01T12:00:00.000Z",
      lastSeenAt: "2026-07-02T12:00:00.000Z",
      expiresAt: "2026-07-20T12:00:00.000Z",
      kind: "browser",
    });
    expect(
      (await app.inject({ method: "DELETE", url: "/v1/sessions/session-2", headers: bearer }))
        .statusCode,
    ).toBe(200);

    for (const target of ["bad%20id", "missing-session", "foreign-session", "session-2"]) {
      const response = await app.inject({
        method: "DELETE",
        url: `/v1/sessions/${target}`,
        headers: bearer,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toEqual({
        code: "session_unavailable",
        message: "Session is unavailable",
      });
    }
  });

  it("requires normal CSRF protection for cookie-authenticated destructive operations", async () => {
    const denied = await app.inject({
      method: "DELETE",
      url: "/v1/sessions/session-2",
      headers: { cookie: cookie.cookie, origin: cookie.origin },
    });
    expect(denied.statusCode).toBe(403);
    expect(deps.sessions.sessions.get("session-2")?.revoked).toBe(false);

    const deniedBulk = await app.inject({
      method: "POST",
      url: "/v1/sessions/revoke-others",
      headers: { cookie: cookie.cookie, origin: cookie.origin },
    });
    expect(deniedBulk.statusCode).toBe(403);
    expect(deps.sessions.sessions.get("session-2")?.revoked).toBe(false);

    const allowed = await app.inject({
      method: "DELETE",
      url: "/v1/sessions/session-2",
      headers: cookie,
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("requires recent provider-authenticated auth_time before revoking every other session", async () => {
    deps.tokenVerifier.tokens.set("valid-token", {
      ...TEST_IDENTITY,
      authenticatedAt:
        Math.floor(Date.now() / 1_000) - TEST_CONFIG.sessions.freshAuthMaxAgeSeconds - 1,
    });
    const stale = await app.inject({
      method: "POST",
      url: "/v1/sessions/revoke-others",
      headers: bearer,
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe("reauthentication_required");
    expect(deps.sessions.sessions.get("session-2")?.revoked).toBe(false);

    const { authenticatedAt: _verifiedAuthTime, ...identityWithoutAuthTime } = TEST_IDENTITY;
    deps.tokenVerifier.tokens.set("valid-token", identityWithoutAuthTime);
    deps.principalResolver.principal = {
      ...deps.principalResolver.principal,
      authenticatedAt: Math.floor(Date.now() / 1_000),
    };
    const resolverCannotForgeFreshAuth = await app.inject({
      method: "POST",
      url: "/v1/sessions/revoke-others",
      headers: bearer,
    });
    expect(resolverCannotForgeFreshAuth.statusCode).toBe(403);
    expect(deps.sessions.sessions.get("session-2")?.revoked).toBe(false);

    deps.tokenVerifier.tokens.set("valid-token", {
      ...TEST_IDENTITY,
      authenticatedAt: Math.floor(Date.now() / 1_000),
    });
    const fresh = await app.inject({
      method: "POST",
      url: "/v1/sessions/revoke-others",
      headers: bearer,
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({ revoked: true, revokedCount: 1 });
    expect(deps.sessions.sessions.get("session-1")?.revoked).toBe(false);
    expect(deps.sessions.sessions.get("session-2")?.revoked).toBe(true);
    expect(deps.sessions.audits.at(-1)).toMatchObject({
      action: "session.others_revoked",
      currentSessionId: "session-1",
      revokedCount: 1,
    });
  });

  it("requires human principals, a current session binding, and route-specific abuse budgets", async () => {
    deps.principalResolver.principal = { ...deps.principalResolver.principal, kind: "service" };
    expect(
      (await app.inject({ method: "GET", url: "/v1/sessions", headers: bearer })).statusCode,
    ).toBe(403);

    const { sessionId: _principalSession, ...principalWithoutSession } =
      deps.principalResolver.principal;
    deps.principalResolver.principal = { ...principalWithoutSession, kind: "human" };
    const { sessionId: _identitySession, ...identityWithoutSession } = TEST_IDENTITY;
    deps.tokenVerifier.tokens.set("valid-token", identityWithoutSession);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sessions/revoke-others",
          headers: bearer,
        })
      ).statusCode,
    ).toBe(403);

    deps.rateLimits.principalAllowed = false;
    const limited = await app.inject({
      method: "DELETE",
      url: "/v1/sessions/session-2",
      headers: bearer,
    });
    expect(limited.statusCode).toBe(429);
    expect(deps.sessions.sessions.get("session-2")?.revoked).toBe(false);
  });

  it("fails production composition without a complete durable session authority", async () => {
    const production = createTestDependencies();
    await expect(
      buildGateway({ ...TEST_CONFIG, nodeEnv: "production" }, {
        ...production,
        sessions: undefined,
      } as unknown as TestDependencies),
    ).rejects.toThrow(/missing/);
    await expect(
      buildGateway({ ...TEST_CONFIG, nodeEnv: "production" }, {
        ...production,
        sessions: {
          adapterKind: "durable",
          adapterName: "broken-sessions",
          ready: async () => true,
        },
      } as unknown as TestDependencies),
    ).rejects.toThrow(/broken-sessions:missing_method:listOwned/);
  });
});
