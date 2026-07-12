import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireWorkosM2mToken,
  loadParrotProductionEnvironment,
  ParrotProductionBlockerError,
} from "../src/production/parrot.js";

const baseEnvironment = (secretFile: string): NodeJS.ProcessEnv => ({
  WORKOS_M2M_TOKEN_ENDPOINT: "https://example.authkit.app/oauth2/token",
  WORKOS_M2M_CLIENT_ID: "client_01KNAKHWDENJZH10KDPEYAMZMN",
  WORKOS_M2M_CLIENT_SECRET_FILE: secretFile,
  WORKOS_M2M_ISSUER: "https://example.authkit.app",
  WORKOS_M2M_AUDIENCE: "client_01KNAKHWDENJZH10KDPEYAMZMN",
  WORKOS_M2M_EXPECTED_SUBJECT: "m2m_01KNAKHWDENJZH10KDPEYAMZMN",
  SPACETIMEDB_WORKER_URI: "ws://spacetimedb:3000",
  SPACETIMEDB_DATABASE_NAME: "parrot-production",
  SPACETIMEDB_WORKER_SERVICE_IDENTITY: "a".repeat(64),
});

const jwt = (expiresAt: number): string => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp: Math.floor(expiresAt / 1_000) })}.signature`;
};

test("production environment rejects non-HTTPS token endpoints", () => {
  assert.throws(
    () =>
      loadParrotProductionEnvironment({
        ...baseEnvironment("/run/secrets/workos"),
        WORKOS_M2M_TOKEN_ENDPOINT: "http://example.authkit.app/oauth2/token",
      }),
    (error: unknown) =>
      error instanceof ParrotProductionBlockerError &&
      error.blockers.includes("workos_m2m_token_endpoint_invalid"),
  );
});

test("M2M exchange reads the mounted secret and sends exact client credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parrot-workos-"));
  const secretFile = join(directory, "client-secret");
  await writeFile(secretFile, "super-secret-client-credential", { mode: 0o600 });
  try {
    const environment = loadParrotProductionEnvironment(baseEnvironment(secretFile));
    let requestBody = "";
    const result = await acquireWorkosM2mToken(environment, async (input, init) => {
      assert.equal(String(input), "https://example.authkit.app/oauth2/token");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      requestBody = String(init?.body);
      return new Response(
        JSON.stringify({ access_token: jwt(Date.now() + 10 * 60 * 1_000), token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const params = new URLSearchParams(requestBody);
    assert.equal(params.get("grant_type"), "client_credentials");
    assert.equal(params.get("client_id"), environment.clientId);
    assert.equal(params.get("client_secret"), "super-secret-client-credential");
    assert.match(result.accessToken, /^[^.]+\.[^.]+\.[^.]+$/);
    assert.ok(result.expiresAt > Date.now() + 5 * 60 * 1_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("token exchange rejects provider errors without reflecting the mounted secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parrot-workos-"));
  const secretFile = join(directory, "client-secret");
  await writeFile(secretFile, "credential-that-must-not-leak", { mode: 0o600 });
  try {
    const environment = loadParrotProductionEnvironment(baseEnvironment(secretFile));
    await assert.rejects(
      acquireWorkosM2mToken(
        environment,
        async () => new Response("credential-that-must-not-leak", { status: 401 }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "workos_m2m_token_request_failed:401" &&
        !error.message.includes("credential-that-must-not-leak"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
