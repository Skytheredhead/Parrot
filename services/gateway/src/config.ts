import { isIP } from "node:net";
import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const rawConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: logLevelSchema.default("info"),
  ALLOWED_ORIGINS: z.string().min(1),
  TRUSTED_PROXY_CIDRS: z.string().default(""),
  OIDC_ISSUER: z.url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_JWKS_URI: z.url(),
  OIDC_ALLOWED_TOKEN_TYPES: z.string().min(1).default("at+jwt"),
  OIDC_ALLOW_MISSING_TYP: z.enum(["true", "false"]).default("false"),
  OIDC_ALLOW_CLIENT_ID_AUDIENCE: z.enum(["true", "false"]).default("false"),
  OIDC_MAX_TOKEN_AGE_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  OIDC_MAX_JWKS_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(262_144),
  DB_TOKEN_AUDIENCE: z.string().min(1),
  DB_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(120),
  AGENT_STREAM_AUDIENCE: z.string().min(1).default("agent-stream"),
  AGENT_STREAM_ORIGINS: z.string().min(1),
  AGENT_STREAM_TTL_SECONDS: z.coerce.number().int().min(15).max(120).default(60),
  UPLOAD_CAPABILITY_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  DOWNLOAD_CAPABILITY_TTL_SECONDS: z.coerce.number().int().min(15).max(120).default(60),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(5_000_000_000).default(100_000_000),
  FILE_CAPABILITY_ORIGINS: z.string().min(1),
  SEARCH_CURSOR_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  SEARCH_MAX_RESPONSE_BYTES: z.coerce.number().int().min(4_096).max(1_048_576).default(65_536),
  SEARCH_MAX_TITLE_BYTES: z.coerce.number().int().min(64).max(4_096).default(512),
  SEARCH_MAX_SNIPPET_BYTES: z.coerce.number().int().min(128).max(16_384).default(4_096),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().max(10_000).default(300),
  RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
  WEBHOOK_MAX_SKEW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  SESSION_COOKIE_NAME: z.string().min(1).default("__Host-session"),
  CSRF_COOKIE_NAME: z.string().min(1).default("__Host-csrf"),
  SESSION_FRESH_AUTH_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  READINESS_TOKEN: z.string().min(32).optional(),
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
  OTEL_ENABLED: z.enum(["true", "false"]).default("false"),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).default("project-conversation-gateway"),
  GATEWAY_ADAPTER_MODULE: z.string().min(1).optional(),
  FILE_CAPABILITY_PUBLIC_ORIGIN: z.url().optional(),
  LOCAL_OBJECT_ROOT: z.string().min(1).optional(),
  FILE_CAPABILITY_HMAC_SECRET_FILE: z.string().min(1).optional(),
  WORKOS_API_KEY_FILE: z.string().min(1).optional(),
  SPACETIMEDB_URI: z.url().optional(),
  SPACETIMEDB_DATABASE_NAME: z.string().min(1).max(64).optional(),
  SPACETIMEDB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  SPACETIMEDB_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(3_000),
  GATEWAY_SQLITE_PATH: z.string().min(1).optional(),
});

export interface GatewayConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: z.infer<typeof logLevelSchema>;
  allowedOrigins: readonly string[];
  trustedProxyCidrs: readonly string[];
  oidc: {
    issuer: string;
    audience: string;
    jwksUri: string;
    allowedTokenTypes: readonly string[];
    allowMissingTokenType: boolean;
    allowClientIdAudience: boolean;
    maxTokenAgeSeconds: number;
    maxJwksBytes: number;
  };
  dbToken: { audience: string; ttlSeconds: number };
  agentStream: { audience: string; ttlSeconds: number; allowedOrigins: readonly string[] };
  files: {
    uploadTtlSeconds: number;
    downloadTtlSeconds: number;
    maxUploadBytes: number;
    capabilityOrigins: readonly string[];
  };
  search: {
    cursorTtlSeconds: number;
    maxResponseBytes: number;
    maxTitleBytes: number;
    maxSnippetBytes: number;
  };
  rateLimit: { max: number; window: string };
  webhookMaxSkewSeconds: number;
  sessionCookieName: string;
  csrfCookieName: string;
  sessions: { freshAuthMaxAgeSeconds: number };
  readiness: { token?: string; timeoutMs: number };
  telemetry: { enabled: boolean; serviceName: string; endpoint?: string };
  adapterModule?: string;
  production?: {
    fileCapabilityPublicOrigin: string;
    localObjectRoot: string;
    fileCapabilityHmacSecretFile: string;
    /** A mounted staging secret reference. The bearer-only gateway never reads this value. */
    workosApiKeyFile?: string;
    spacetime?: {
      uri: string;
      databaseName: string;
      connectTimeoutMs: number;
      commandTimeoutMs: number;
    };
    gatewaySqlitePath?: string;
  };
}

function csv(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizedOrigins(value: string, production: boolean): string[] {
  const origins = csv(value);
  if (origins.length === 0 || origins.includes("*")) {
    throw new Error("ALLOWED_ORIGINS must contain exact origins and cannot contain '*'");
  }
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      (production && parsed.protocol !== "https:")
    ) {
      throw new Error(`Invalid allowed origin: ${origin}`);
    }
  }
  return origins;
}

function normalizedServiceOrigins(
  name: string,
  value: string,
  protocol: "https:" | "wss:",
): string[] {
  const origins = csv(value);
  if (origins.length === 0 || origins.includes("*"))
    throw new Error(`${name} must be exact origins`);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      parsed.protocol !== protocol ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(`Invalid ${name} origin: ${origin}`);
    }
  }
  return origins;
}

function trustedProxyCidrs(value: string): string[] {
  const entries = csv(value);
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const version = address ? isIP(address) : 0;
    const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : -1;
    const parsedPrefix = prefix === undefined ? maxPrefix : Number(prefix);
    if (
      extra !== undefined ||
      maxPrefix < 0 ||
      !Number.isInteger(parsedPrefix) ||
      parsedPrefix < 0 ||
      parsedPrefix > maxPrefix
    ) {
      throw new Error(`Invalid trusted proxy CIDR: ${entry}`);
    }
  }
  return entries;
}

function validateSecurityUrl(name: string, value: string, production: boolean): URL {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error(`${name} cannot contain credentials, query parameters, or fragments`);
  }
  if (production && parsed.protocol !== "https:")
    throw new Error(`${name} must use HTTPS in production`);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error(`${name} must use HTTP(S)`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const input = Object.fromEntries(
    Object.keys(rawConfigSchema.shape)
      .map((key) => [key, env[key]])
      .filter(([, value]) => value !== undefined),
  );
  const parsed = rawConfigSchema.parse(input);
  const production = parsed.NODE_ENV === "production";
  const issuer = validateSecurityUrl("OIDC_ISSUER", parsed.OIDC_ISSUER, production);
  const jwks = validateSecurityUrl("OIDC_JWKS_URI", parsed.OIDC_JWKS_URI, production);
  if (issuer.origin !== jwks.origin)
    throw new Error("OIDC_JWKS_URI must share the approved OIDC_ISSUER origin");
  const telemetryEnabled = parsed.OTEL_ENABLED === "true";
  const configuredEndpoint = parsed.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (telemetryEnabled && configuredEndpoint !== undefined)
    validateSecurityUrl("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", configuredEndpoint, production);
  if (telemetryEnabled && configuredEndpoint === undefined) {
    throw new Error("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is required when OTEL_ENABLED=true");
  }
  const endpoint = telemetryEnabled ? configuredEndpoint : undefined;
  if (parsed.SESSION_COOKIE_NAME === parsed.CSRF_COOKIE_NAME)
    throw new Error("Session and CSRF cookie names must differ");
  if (
    production &&
    (!parsed.SESSION_COOKIE_NAME.startsWith("__Host-") ||
      !parsed.CSRF_COOKIE_NAME.startsWith("__Host-"))
  ) {
    throw new Error("Production session and CSRF cookies must use the __Host- prefix");
  }
  if (production && parsed.READINESS_TOKEN === undefined)
    throw new Error("READINESS_TOKEN is required in production");
  const productionObjectValues = [
    parsed.FILE_CAPABILITY_PUBLIC_ORIGIN,
    parsed.LOCAL_OBJECT_ROOT,
    parsed.FILE_CAPABILITY_HMAC_SECRET_FILE,
  ];
  if (parsed.WORKOS_API_KEY_FILE !== undefined && !parsed.WORKOS_API_KEY_FILE.startsWith("/"))
    throw new Error("WORKOS_API_KEY_FILE must be an absolute path");
  if ((parsed.SPACETIMEDB_URI === undefined) !== (parsed.SPACETIMEDB_DATABASE_NAME === undefined))
    throw new Error("SPACETIMEDB_URI and SPACETIMEDB_DATABASE_NAME must be configured together");
  if (parsed.SPACETIMEDB_URI !== undefined) {
    const spacetime = new URL(parsed.SPACETIMEDB_URI);
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(spacetime.hostname);
    const privateComposeOrigin = spacetime.hostname === "spacetimedb" && spacetime.port === "3000";
    if (
      spacetime.username ||
      spacetime.password ||
      spacetime.search ||
      spacetime.hash ||
      spacetime.pathname !== "/" ||
      (spacetime.protocol !== "wss:" &&
        !(spacetime.protocol === "ws:" && (loopback || privateComposeOrigin)))
    )
      throw new Error("SPACETIMEDB_URI must be an exact WSS origin or loopback WS origin");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(parsed.SPACETIMEDB_DATABASE_NAME ?? ""))
      throw new Error("SPACETIMEDB_DATABASE_NAME is invalid");
  }
  if (parsed.GATEWAY_SQLITE_PATH !== undefined && !parsed.GATEWAY_SQLITE_PATH.startsWith("/"))
    throw new Error("GATEWAY_SQLITE_PATH must be an absolute path");
  if (productionObjectValues.some((value) => value !== undefined)) {
    if (productionObjectValues.some((value) => value === undefined)) {
      throw new Error(
        "FILE_CAPABILITY_PUBLIC_ORIGIN, LOCAL_OBJECT_ROOT, and FILE_CAPABILITY_HMAC_SECRET_FILE must be configured together",
      );
    }
    const capabilityOrigin = normalizedServiceOrigins(
      "FILE_CAPABILITY_PUBLIC_ORIGIN",
      parsed.FILE_CAPABILITY_PUBLIC_ORIGIN ?? "",
      "https:",
    )[0];
    if (
      !capabilityOrigin ||
      !normalizedServiceOrigins(
        "FILE_CAPABILITY_ORIGINS",
        parsed.FILE_CAPABILITY_ORIGINS,
        "https:",
      ).includes(capabilityOrigin)
    ) {
      throw new Error("FILE_CAPABILITY_PUBLIC_ORIGIN must be listed in FILE_CAPABILITY_ORIGINS");
    }
    if (!parsed.LOCAL_OBJECT_ROOT?.startsWith("/"))
      throw new Error("LOCAL_OBJECT_ROOT must be an absolute path");
    if (!parsed.FILE_CAPABILITY_HMAC_SECRET_FILE?.startsWith("/"))
      throw new Error("FILE_CAPABILITY_HMAC_SECRET_FILE must be an absolute path");
  }
  const allowedTokenTypes = csv(parsed.OIDC_ALLOWED_TOKEN_TYPES).map((value) =>
    value.toLowerCase(),
  );
  if (allowedTokenTypes.length === 0) throw new Error("OIDC_ALLOWED_TOKEN_TYPES cannot be empty");

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    allowedOrigins: normalizedOrigins(parsed.ALLOWED_ORIGINS, production),
    trustedProxyCidrs: trustedProxyCidrs(parsed.TRUSTED_PROXY_CIDRS),
    oidc: {
      issuer: parsed.OIDC_ISSUER,
      audience: parsed.OIDC_AUDIENCE,
      jwksUri: parsed.OIDC_JWKS_URI,
      allowedTokenTypes,
      allowMissingTokenType: parsed.OIDC_ALLOW_MISSING_TYP === "true",
      allowClientIdAudience: parsed.OIDC_ALLOW_CLIENT_ID_AUDIENCE === "true",
      maxTokenAgeSeconds: parsed.OIDC_MAX_TOKEN_AGE_SECONDS,
      maxJwksBytes: parsed.OIDC_MAX_JWKS_BYTES,
    },
    dbToken: { audience: parsed.DB_TOKEN_AUDIENCE, ttlSeconds: parsed.DB_TOKEN_TTL_SECONDS },
    agentStream: {
      audience: parsed.AGENT_STREAM_AUDIENCE,
      ttlSeconds: parsed.AGENT_STREAM_TTL_SECONDS,
      allowedOrigins: normalizedServiceOrigins(
        "AGENT_STREAM_ORIGINS",
        parsed.AGENT_STREAM_ORIGINS,
        "wss:",
      ),
    },
    files: {
      uploadTtlSeconds: parsed.UPLOAD_CAPABILITY_TTL_SECONDS,
      downloadTtlSeconds: parsed.DOWNLOAD_CAPABILITY_TTL_SECONDS,
      maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
      capabilityOrigins: normalizedServiceOrigins(
        "FILE_CAPABILITY_ORIGINS",
        parsed.FILE_CAPABILITY_ORIGINS,
        "https:",
      ),
    },
    search: {
      cursorTtlSeconds: parsed.SEARCH_CURSOR_TTL_SECONDS,
      maxResponseBytes: parsed.SEARCH_MAX_RESPONSE_BYTES,
      maxTitleBytes: parsed.SEARCH_MAX_TITLE_BYTES,
      maxSnippetBytes: parsed.SEARCH_MAX_SNIPPET_BYTES,
    },
    rateLimit: { max: parsed.RATE_LIMIT_MAX, window: parsed.RATE_LIMIT_WINDOW },
    webhookMaxSkewSeconds: parsed.WEBHOOK_MAX_SKEW_SECONDS,
    sessionCookieName: parsed.SESSION_COOKIE_NAME,
    csrfCookieName: parsed.CSRF_COOKIE_NAME,
    sessions: { freshAuthMaxAgeSeconds: parsed.SESSION_FRESH_AUTH_MAX_AGE_SECONDS },
    readiness: {
      ...(parsed.READINESS_TOKEN === undefined ? {} : { token: parsed.READINESS_TOKEN }),
      timeoutMs: parsed.READINESS_TIMEOUT_MS,
    },
    telemetry: {
      enabled: telemetryEnabled,
      serviceName: parsed.OTEL_SERVICE_NAME,
      ...(endpoint === undefined ? {} : { endpoint }),
    },
    ...(parsed.GATEWAY_ADAPTER_MODULE === undefined
      ? {}
      : { adapterModule: parsed.GATEWAY_ADAPTER_MODULE }),
    ...(productionObjectValues.every((value) => value !== undefined)
      ? {
          production: {
            fileCapabilityPublicOrigin: parsed.FILE_CAPABILITY_PUBLIC_ORIGIN as string,
            localObjectRoot: parsed.LOCAL_OBJECT_ROOT as string,
            fileCapabilityHmacSecretFile: parsed.FILE_CAPABILITY_HMAC_SECRET_FILE as string,
            ...(parsed.WORKOS_API_KEY_FILE === undefined
              ? {}
              : { workosApiKeyFile: parsed.WORKOS_API_KEY_FILE }),
            ...(parsed.SPACETIMEDB_URI === undefined
              ? {}
              : {
                  spacetime: {
                    uri: parsed.SPACETIMEDB_URI,
                    databaseName: parsed.SPACETIMEDB_DATABASE_NAME as string,
                    connectTimeoutMs: parsed.SPACETIMEDB_CONNECT_TIMEOUT_MS,
                    commandTimeoutMs: parsed.SPACETIMEDB_COMMAND_TIMEOUT_MS,
                  },
                }),
            ...(parsed.GATEWAY_SQLITE_PATH === undefined
              ? {}
              : { gatewaySqlitePath: parsed.GATEWAY_SQLITE_PATH }),
          },
        }
      : {}),
  };
}
