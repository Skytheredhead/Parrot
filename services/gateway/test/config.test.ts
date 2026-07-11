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
    });
    expect(config.allowedOrigins).toEqual(["https://app.test", "https://preview.test"]);
    expect(config.trustedProxyCidrs).toEqual(["127.0.0.1", "10.0.0.0/8", "::1/128"]);
    expect(config.oidc.allowedTokenTypes).toEqual(["at+jwt", "application/at+jwt"]);
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
});
