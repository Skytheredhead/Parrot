import type { GatewayConfig } from "../src/config.js";

export const TEST_CONFIG: GatewayConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 8080,
  logLevel: "silent",
  allowedOrigins: ["https://app.test"],
  trustedProxyCidrs: [],
  oidc: {
    issuer: "https://issuer.test",
    audience: "gateway-test",
    jwksUri: "https://issuer.test/.well-known/jwks.json",
    allowedTokenTypes: ["at+jwt"],
    maxTokenAgeSeconds: 900,
    maxJwksBytes: 262_144,
  },
  dbToken: { audience: "spacetimedb-test", ttlSeconds: 120 },
  agentStream: {
    audience: "agent-stream-test",
    ttlSeconds: 60,
    allowedOrigins: ["wss://gateway.test"],
  },
  files: {
    uploadTtlSeconds: 300,
    downloadTtlSeconds: 60,
    maxUploadBytes: 10_000_000,
    capabilityOrigins: ["https://objects.test"],
  },
  search: {
    cursorTtlSeconds: 300,
    maxResponseBytes: 65_536,
    maxTitleBytes: 512,
    maxSnippetBytes: 4_096,
  },
  rateLimit: { max: 1_000, window: "1 minute" },
  webhookMaxSkewSeconds: 300,
  sessionCookieName: "__Host-session",
  csrfCookieName: "__Host-csrf",
  readiness: { token: "test-readiness-token-that-is-long-enough", timeoutMs: 200 },
  telemetry: { enabled: false, serviceName: "gateway-test" },
};
