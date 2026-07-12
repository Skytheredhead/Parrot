import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const required = {
  ALLOWED_ORIGINS: "https://app.test",
  OIDC_ISSUER: "https://issuer.test",
  OIDC_AUDIENCE: "gateway",
  OIDC_JWKS_URI: "https://issuer.test/jwks",
  DB_TOKEN_AUDIENCE: "database",
  AGENT_STREAM_ORIGINS: "wss://gateway.test",
  FILE_CAPABILITY_ORIGINS: "https://objects.test",
};

describe("loadConfig", () => {
  it("normalizes exact origins, token profile, and trusted proxy CIDRs", () => {
    const config = loadConfig({
      ...required,
      NODE_ENV: "production",
      READINESS_TOKEN: "a".repeat(32),
      ALLOWED_ORIGINS: "https://app.test,https://preview.test",
      TRUSTED_PROXY_CIDRS: "127.0.0.1,10.0.0.0/8,::1/128",
      OIDC_ALLOWED_TOKEN_TYPES: "at+jwt,application/at+jwt",
      OIDC_ALLOW_MISSING_TYP: "true",
      OIDC_ALLOW_CLIENT_ID_AUDIENCE: "true",
    });
    expect(config.allowedOrigins).toEqual(["https://app.test", "https://preview.test"]);
    expect(config.trustedProxyCidrs).toEqual(["127.0.0.1", "10.0.0.0/8", "::1/128"]);
    expect(config.oidc.allowedTokenTypes).toEqual(["at+jwt", "application/at+jwt"]);
    expect(config.oidc.allowMissingTokenType).toBe(true);
    expect(config.oidc.allowClientIdAudience).toBe(true);
  });

  it.each([
    "*",
    "https://app.test/path",
    "http://app.test",
  ])("rejects unsafe production origin %s", (origin) => {
    expect(() =>
      loadConfig({
        ...required,
        NODE_ENV: "production",
        READINESS_TOKEN: "a".repeat(32),
        ALLOWED_ORIGINS: origin,
      }),
    ).toThrow();
  });

  it("requires production __Host- cookies and an internal readiness token", () => {
    expect(() => loadConfig({ ...required, NODE_ENV: "production" })).toThrow(/READINESS_TOKEN/);
    expect(() =>
      loadConfig({
        ...required,
        NODE_ENV: "production",
        READINESS_TOKEN: "a".repeat(32),
        SESSION_COOKIE_NAME: "session",
      }),
    ).toThrow(/__Host-/);
  });

  it("bounds the destructive session fresh-auth window", () => {
    expect(() => loadConfig({ ...required, SESSION_FRESH_AUTH_MAX_AGE_SECONDS: "59" })).toThrow();
    expect(() => loadConfig({ ...required, SESSION_FRESH_AUTH_MAX_AGE_SECONDS: "901" })).toThrow();
    expect(loadConfig({ ...required, SESSION_FRESH_AUTH_MAX_AGE_SECONDS: "300" }).sessions).toEqual(
      {
        freshAuthMaxAgeSeconds: 300,
      },
    );
  });

  it.each([
    { OIDC_JWKS_URI: "https://other.test/jwks" },
    { OIDC_JWKS_URI: "https://user:password@issuer.test/jwks" },
    { OIDC_JWKS_URI: "https://issuer.test/jwks?token=secret" },
    { TRUSTED_PROXY_CIDRS: "10.0.0.0/99" },
  ])("rejects unbound identity URLs and invalid proxy trust: %j", (override) => {
    expect(() => loadConfig({ ...required, ...override })).toThrow();
  });

  it("requires a safe telemetry endpoint", () => {
    expect(() => loadConfig({ ...required, OTEL_ENABLED: "true" })).toThrow(/OTEL_EXPORTER/);
    expect(() =>
      loadConfig({
        ...required,
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://user:secret@otel.test/v1/traces",
      }),
    ).toThrow(/credentials/);
  });

  it("binds host-local object capabilities to an approved HTTPS origin and secret files", () => {
    const production = {
      ...required,
      NODE_ENV: "production",
      READINESS_TOKEN: "a".repeat(32),
      FILE_CAPABILITY_ORIGINS: "https://parrotapi.skylarenns.com",
      FILE_CAPABILITY_PUBLIC_ORIGIN: "https://parrotapi.skylarenns.com",
      LOCAL_OBJECT_ROOT: "/var/lib/parrot/objects",
      FILE_CAPABILITY_HMAC_SECRET_FILE: "/run/secrets/parrot_object_capability_hmac",
      WORKOS_API_KEY_FILE: "/run/secrets/parrot_workos_api_key",
    };
    expect(loadConfig(production).production).toEqual({
      fileCapabilityPublicOrigin: "https://parrotapi.skylarenns.com",
      localObjectRoot: "/var/lib/parrot/objects",
      fileCapabilityHmacSecretFile: "/run/secrets/parrot_object_capability_hmac",
      workosApiKeyFile: "/run/secrets/parrot_workos_api_key",
    });
    expect(() =>
      loadConfig({ ...production, FILE_CAPABILITY_PUBLIC_ORIGIN: "https://objects.example" }),
    ).toThrow(/listed/);
    expect(() => loadConfig({ ...production, LOCAL_OBJECT_ROOT: "relative/path" })).toThrow(
      /absolute/,
    );
    expect(() =>
      loadConfig({ ...production, FILE_CAPABILITY_HMAC_SECRET_FILE: undefined }),
    ).toThrow(/configured together/);
  });

  it("accepts only exact secure or loopback SpacetimeDB gateway origins", () => {
    expect(
      loadConfig({
        ...required,
        SPACETIMEDB_URI: "ws://127.0.0.1:3001",
        SPACETIMEDB_DATABASE_NAME: "parrot-staging",
      }).production,
    ).toBeUndefined();
    expect(() =>
      loadConfig({
        ...required,
        SPACETIMEDB_URI: "ws://remote.example:3001",
        SPACETIMEDB_DATABASE_NAME: "parrot-staging",
      }),
    ).toThrow(/WSS/);
    expect(() => loadConfig({ ...required, SPACETIMEDB_URI: "wss://database.example" })).toThrow(
      /configured together/,
    );
    expect(() => loadConfig({ ...required, GATEWAY_SQLITE_PATH: "relative.sqlite" })).toThrow(
      /absolute/,
    );
    const privateProduction = loadConfig({
      ...required,
      NODE_ENV: "production",
      READINESS_TOKEN: "a".repeat(32),
      SPACETIMEDB_URI: "ws://spacetimedb:3000",
      SPACETIMEDB_DATABASE_NAME: "project-conversation-staging",
      OTEL_ENABLED: "false",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://otel-collector:4318/v1/traces",
    });
    expect(privateProduction.nodeEnv).toBe("production");
    expect(privateProduction.telemetry.endpoint).toBeUndefined();
  });
});
