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
    !["human", "agent", "service"].includes(principal.kind) ||
    !Number.isSafeInteger(principal.authzEpoch) ||
    principal.authzEpoch < 0 ||
    (principal.email !== undefined &&
      (typeof principal.email !== "string" || principal.email.length > 254)) ||
    (principal.emailVerified !== undefined && typeof principal.emailVerified !== "boolean")
  ) {
    throw unauthorized("Authoritative identity resolution failed");
  }
  return Object.freeze({
    id: principal.id,
    issuer: principal.issuer,
    subject: principal.subject,
    kind: principal.kind,
    authzEpoch: principal.authzEpoch,
    ...(principal.email === undefined ? {} : { email: principal.email }),
    ...(principal.emailVerified === undefined ? {} : { emailVerified: principal.emailVerified }),
    ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
    ...(identity.authenticatedAt === undefined
      ? {}
      : { authenticatedAt: identity.authenticatedAt }),
  });
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
  const resolved = await principals.resolve(identity);
  const checked = assertResolvedIdentity(identity, resolved);
  principals.bindCheckedPrincipal?.({ identity, resolved, checked });
  request.principal = checked;
  return checked;
}
