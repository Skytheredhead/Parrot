import type { FastifyRequest } from "fastify";
import type {
  Principal,
  PrincipalResolver,
  SessionVerifier,
  TokenVerifier,
  VerifiedIdentity,
} from "../contracts.js";
import { unauthorized } from "../errors.js";
import { parseCookies } from "../security/browser-boundary.js";

function assertResolvedIdentity(identity: VerifiedIdentity, principal: Principal): Principal {
  if (
    principal.issuer !== identity.issuer ||
    principal.subject !== identity.subject ||
    !principal.id ||
    !Number.isSafeInteger(principal.authzEpoch) ||
    principal.authzEpoch < 0
  ) {
    throw unauthorized("Authoritative identity resolution failed");
  }
  const {
    sessionId: _untrustedResolvedSession,
    authenticatedAt: _untrustedResolvedAuthenticationTime,
    ...authoritativePrincipal
  } = principal;
  return {
    ...authoritativePrincipal,
    ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
    ...(identity.authenticatedAt === undefined
      ? {}
      : { authenticatedAt: identity.authenticatedAt }),
  };
}

export async function authenticateRequest(
  request: FastifyRequest,
  verifier: TokenVerifier,
  sessions: SessionVerifier,
  principals: PrincipalResolver,
  sessionCookieName: string,
): Promise<Principal> {
  if (request.principal) return request.principal;
  const authorization = request.headers.authorization;
  const sessionToken = parseCookies(request.headers.cookie).get(sessionCookieName);
  if (authorization && sessionToken) throw unauthorized("Ambiguous authentication boundary");
  let identity: VerifiedIdentity;
  if (authorization) {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(authorization);
    if (!match?.[1]) throw unauthorized("Malformed bearer authorization");
    identity = await verifier.verify(match[1]);
  } else if (sessionToken) {
    identity = await sessions.verify(sessionToken);
  } else {
    throw unauthorized();
  }
  const principal = assertResolvedIdentity(identity, await principals.resolve(identity));
  request.principal = principal;
  return principal;
}
