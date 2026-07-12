import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OidcJwtVerifier } from "../src/auth/oidc.js";

describe("OidcJwtVerifier", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let jwk: Awaited<ReturnType<typeof exportJWK>>;
  const issuer = "https://issuer.test";

  beforeEach(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    jwk = await exportJWK(keys.publicKey);
    Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });
  });

  afterEach(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    servers.length = 0;
  });

  async function verifier(
    maxJwksBytes = 262_144,
    allowMissingTokenType = false,
    allowClientIdAudience = false,
  ) {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return new OidcJwtVerifier({
      jwksUri: `http://127.0.0.1:${port}/jwks`,
      issuer,
      audience: "gateway",
      allowedTokenTypes: ["at+jwt"],
      allowMissingTokenType,
      allowClientIdAudience,
      maxTokenAgeSeconds: 300,
      maxJwksBytes,
    });
  }

  async function token(
    input: {
      typ?: string;
      lifetime?: number;
      audience?: string;
      claims?: Record<string, unknown>;
      omitTyp?: boolean;
    } = {},
  ) {
    return new SignJWT(input.claims ?? {})
      .setProtectedHeader({
        alg: "RS256",
        kid: "test-key",
        ...(input.omitTyp ? {} : input.typ === undefined ? { typ: "at+jwt" } : { typ: input.typ }),
      })
      .setSubject("service-subject")
      .setIssuer(issuer)
      .setAudience(input.audience ?? "gateway")
      .setIssuedAt()
      .setExpirationTime(`${input.lifetime ?? 120}s`)
      .sign(privateKey);
  }

  it("returns only verified issuer/subject metadata and ignores privilege-shaped claims", async () => {
    const subjectVerifier = await verifier();
    const signed = await token({
      claims: { principal_kind: "service", user_id: "admin", authz_epoch: 999 },
    });
    await expect(subjectVerifier.verify(signed)).resolves.toEqual(
      expect.objectContaining({ issuer, subject: "service-subject", tokenType: "access" }),
    );
    const result = await subjectVerifier.verify(signed);
    expect(result).not.toHaveProperty("principal_kind");
    expect(result).not.toHaveProperty("user_id");
    expect(result).not.toHaveProperty("authz_epoch");
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(signed);
    expect(subjectVerifier.bearerFor(result)).toBe(signed);
    expect(subjectVerifier.bearerFor({ ...result })).toBeUndefined();
  });

  it("accepts only a numeric non-future OIDC auth_time fresh-auth marker", async () => {
    const subjectVerifier = await verifier();
    const now = Math.floor(Date.now() / 1_000);
    await expect(
      subjectVerifier.verify(await token({ claims: { auth_time: now - 30 } })),
    ).resolves.toMatchObject({ authenticatedAt: now - 30 });
    await expect(
      subjectVerifier.verify(await token({ claims: { auth_time: now + 60 } })),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      subjectVerifier.verify(await token({ claims: { auth_time: "recent" } })),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it.each([
    { typ: "JWT" },
    { lifetime: 600 },
    { audience: "other" },
  ])("rejects the wrong token profile or lifetime: %j", async (input) => {
    const subjectVerifier = await verifier();
    await expect(subjectVerifier.verify(await token(input))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("accepts a missing JOSE token type only under an explicit provider profile", async () => {
    const signed = await token({ omitTyp: true });
    await expect((await verifier()).verify(signed)).rejects.toMatchObject({ statusCode: 401 });
    await expect((await verifier(262_144, true)).verify(signed)).resolves.toMatchObject({
      issuer,
      subject: "service-subject",
      tokenType: "access",
    });
  });

  it("accepts WorkOS client_id audience binding only under an explicit provider profile", async () => {
    const signed = await token({ audience: "not-the-gateway", claims: { client_id: "gateway" } });
    await expect((await verifier()).verify(signed)).rejects.toMatchObject({ statusCode: 401 });
    await expect((await verifier(262_144, false, true)).verify(signed)).resolves.toMatchObject({
      subject: "service-subject",
    });
    await expect(
      (await verifier(262_144, false, true)).verify(
        await token({ audience: "not-the-gateway", claims: { client_id: "other" } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects an oversized JWKS response even without Content-Length", async () => {
    const subjectVerifier = await verifier(1_024);
    Object.assign(jwk, { padding: "x".repeat(2_000) });
    await expect(subjectVerifier.verify(await token())).rejects.toMatchObject({ statusCode: 401 });
  });
});
