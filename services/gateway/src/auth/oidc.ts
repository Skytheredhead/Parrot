import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { TokenVerifier, VerifiedIdentity } from "../contracts.js";
import { unauthorized } from "../errors.js";

export interface OidcVerifierOptions {
  jwksUri: string;
  issuer: string;
  audience: string;
  allowedTokenTypes: readonly string[];
  /** Explicit provider profile for issuers, such as WorkOS, that omit JOSE `typ`. */
  allowMissingTokenType?: boolean;
  /** Explicit WorkOS profile: accept the signed `client_id` claim when `aud` is absent. */
  allowClientIdAudience?: boolean;
  maxTokenAgeSeconds: number;
  maxJwksBytes: number;
}

/** Exact-object provenance boundary for a verified bearer; the token is never an object property. */
export interface VerifiedBearerProvenance {
  bearerFor(identity: VerifiedIdentity): string | undefined;
}

async function boundedFetch(
  url: string,
  options: Parameters<typeof fetch>[1],
  maxBytes: number,
): Promise<Response> {
  const response = await fetch(url, { ...options, redirect: "manual" });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error("JWKS response is too large");
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel("JWKS response is too large").catch(() => undefined);
        throw new Error("JWKS response is too large");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class OidcJwtVerifier implements TokenVerifier, VerifiedBearerProvenance {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "oidc-jwks";
  private readonly jwks;
  private readonly allowedTokenTypes: ReadonlySet<string>;
  readonly #verifiedBearers = new WeakMap<VerifiedIdentity, string>();

  constructor(private readonly options: OidcVerifierOptions) {
    this.allowedTokenTypes = new Set(options.allowedTokenTypes.map((value) => value.toLowerCase()));
    this.jwks = createRemoteJWKSet(new URL(options.jwksUri), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
      [customFetch]: (url, request) => boundedFetch(url, request, options.maxJwksBytes),
    });
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        ...(this.options.allowClientIdAudience === true ? {} : { audience: this.options.audience }),
        algorithms: ["RS256", "ES256", "EdDSA"],
        clockTolerance: 5,
        maxTokenAge: this.options.maxTokenAgeSeconds,
        requiredClaims: ["sub", "iat", "exp"],
      });
      if (this.options.allowClientIdAudience === true) {
        const audiences =
          typeof payload.aud === "string"
            ? [payload.aud]
            : Array.isArray(payload.aud) && payload.aud.every((value) => typeof value === "string")
              ? payload.aud
              : [];
        if (
          !audiences.includes(this.options.audience) &&
          payload.client_id !== this.options.audience
        ) {
          throw unauthorized("The token audience is not accepted");
        }
      }
      const tokenType = protectedHeader.typ?.toLowerCase();
      if (
        (tokenType === undefined && this.options.allowMissingTokenType !== true) ||
        (tokenType !== undefined && !this.allowedTokenTypes.has(tokenType))
      )
        throw unauthorized("The token profile is not accepted");
      if (
        !payload.sub ||
        !payload.iss ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number"
      )
        throw unauthorized();
      if (payload.exp - payload.iat > this.options.maxTokenAgeSeconds)
        throw unauthorized("The access token lifetime is too long");
      const sid = payload.sid;
      const authenticatedAt = payload.auth_time;
      if (
        authenticatedAt !== undefined &&
        (typeof authenticatedAt !== "number" ||
          !Number.isSafeInteger(authenticatedAt) ||
          authenticatedAt < 0 ||
          authenticatedAt > payload.iat + 5)
      ) {
        throw unauthorized("The authentication-time claim is invalid");
      }
      const identity: VerifiedIdentity = Object.freeze({
        issuer: payload.iss,
        subject: payload.sub,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
        tokenType: "access",
        ...(typeof sid === "string" ? { sessionId: sid } : {}),
        ...(typeof authenticatedAt === "number" ? { authenticatedAt } : {}),
      });
      this.#verifiedBearers.set(identity, token);
      return identity;
    } catch (error) {
      if (error instanceof Error && error.name === "GatewayError") throw error;
      throw unauthorized("The access token is invalid or expired");
    }
  }

  bearerFor(identity: VerifiedIdentity): string | undefined {
    return this.#verifiedBearers.get(identity);
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    if (this.jwks.fresh) return true;
    return new Promise<boolean>((resolve) => {
      const abort = () => resolve(false);
      signal.addEventListener("abort", abort, { once: true });
      void this.jwks
        .reload()
        .then(
          () => resolve(true),
          () => resolve(false),
        )
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
