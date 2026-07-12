import { OidcJwtVerifier } from "../auth/oidc.js";
import type { GatewayConfig } from "../config.js";
import type { GatewayDependencies, ReadyDependency } from "../contracts.js";
import { unavailable } from "../errors.js";
import { HmacSearchCursorCodec } from "../search/cursor.js";
import { LocalCapabilityObjectStore } from "./local-object-store.js";
import { SqliteRateLimits } from "./local-rate-limits.js";
import { SpacetimeGatewayAuthority } from "./spacetime-authority.js";

/**
 * A non-stateful production placeholder. It never authorizes or fabricates data, and its red
 * readiness check keeps traffic disabled until the named durable authority is composed.
 */
function disabledSurface<T extends ReadyDependency>(name: string): T {
  const target: ReadyDependency = Object.freeze({
    adapterKind: "durable" as const,
    adapterName: `disabled-surface:${name}`,
    ready: async (signal: AbortSignal) => !signal.aborted,
  });
  return new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      if (typeof property !== "string") return undefined;
      return async () => {
        throw unavailable(`The ${name} production authority is not configured`);
      };
    },
  }) as T;
}

/**
 * Reviewed partial Parrot production composition.
 *
 * WorkOS access tokens are verified locally against the configured issuer/JWKS. The API key is
 * deliberately not loaded: this bearer-only graph has no callback or user-management operation.
 * When those operations are added, they must read WORKOS_API_KEY_FILE at call time rather than
 * accepting a literal environment secret.
 */
export async function createGatewayDependencies(
  config: GatewayConfig,
): Promise<GatewayDependencies> {
  if (config.nodeEnv !== "production")
    throw new Error("The Parrot production adapter can only run with NODE_ENV=production");
  if (!config.production)
    throw new Error("The host-local object capability configuration is required");
  if (!config.production.spacetime)
    throw new Error("The caller-scoped SpacetimeDB gateway configuration is required");
  if (!config.production.gatewaySqlitePath)
    throw new Error("GATEWAY_SQLITE_PATH is required for durable rate limiting");

  const objects = await LocalCapabilityObjectStore.create({
    publicOrigin: config.production.fileCapabilityPublicOrigin,
    rootDirectory: config.production.localObjectRoot,
    hmacSecretFile: config.production.fileCapabilityHmacSecretFile,
    maxUploadBytes: config.files.maxUploadBytes,
  });
  const tokenVerifier = new OidcJwtVerifier(config.oidc);
  const authority = new SpacetimeGatewayAuthority(config.production.spacetime, tokenVerifier);
  const rootSecret = Buffer.from(
    (await readFile(config.production.fileCapabilityHmacSecretFile, "utf8")).trim(),
    "utf8",
  );
  if (rootSecret.byteLength < 32) throw new Error("The gateway secret is too short");
  const cursorKey = createHmac("sha256", rootSecret).update("parrot-search-cursor-v1").digest();
  const rateLimitKey = createHmac("sha256", rootSecret).update("parrot-rate-limit-v1").digest();
  rootSecret.fill(0);
  const searchCursors = new HmacSearchCursorCodec([cursorKey]);
  const rateLimits = await SqliteRateLimits.create({
    path: config.production.gatewaySqlitePath,
    maximum: config.rateLimit.max,
    window: config.rateLimit.window,
    hashKey: rateLimitKey,
  });

  return Object.freeze({
    tokenVerifier,
    sessionVerifier: disabledSurface<GatewayDependencies["sessionVerifier"]>("cookie-sessions"),
    principalResolver: authority,
    csrf: disabledSurface<GatewayDependencies["csrf"]>("cookie-csrf"),
    authorization: authority,
    dbTokenBroker: authority,
    files: authority,
    objects,
    objectCapabilities: objects,
    search: disabledSurface<GatewayDependencies["search"]>("search-provider"),
    searchCursors,
    rateLimits,
    webhooks: disabledSurface<GatewayDependencies["webhooks"]>("webhooks"),
    webhookReceipts: disabledSurface<GatewayDependencies["webhookReceipts"]>("webhooks"),
    agentStreams: disabledSurface<GatewayDependencies["agentStreams"]>("agent-streams"),
    agentTools: disabledSurface<GatewayDependencies["agentTools"]>("agent-tools"),
    invitationTokens: disabledSurface<GatewayDependencies["invitationTokens"]>("invitations"),
    invitations: disabledSurface<GatewayDependencies["invitations"]>("invitations"),
    sessions: disabledSurface<GatewayDependencies["sessions"]>("session-administration"),
  });
}

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
