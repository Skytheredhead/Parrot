import type { Principal, SessionAdministration, UserSessionMetadata } from "../contracts.js";
import { GatewayError, forbidden, unavailable } from "../errors.js";

const SESSION_LIMIT = 50;
const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

const sessionUnavailable = () =>
  new GatewayError(404, "session_unavailable", "Session is unavailable");

const validTimestamp = (value: string): boolean => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

export class SessionAdministrationService {
  constructor(
    private readonly sessions: SessionAdministration,
    private readonly freshAuthMaxAgeSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !Number.isSafeInteger(freshAuthMaxAgeSeconds) ||
      freshAuthMaxAgeSeconds < 60 ||
      freshAuthMaxAgeSeconds > 900
    ) {
      throw new Error("Session fresh-auth window is invalid");
    }
  }

  async list(principal: Principal): Promise<{ sessions: readonly UserSessionMetadata[] }> {
    this.assertHuman(principal);
    const now = this.now().getTime();
    const result = await this.sessions.listOwned({
      principal,
      ...(principal.sessionId === undefined ? {} : { currentSessionId: principal.sessionId }),
      limit: SESSION_LIMIT,
    });
    if (result.length > SESSION_LIMIT) throw unavailable("Session authority exceeded its limit");
    const seen = new Set<string>();
    const safe = result.map((session) => {
      if (
        !sessionIdPattern.test(session.sessionId) ||
        seen.has(session.sessionId) ||
        typeof session.current !== "boolean" ||
        session.current !==
          (principal.sessionId !== undefined && session.sessionId === principal.sessionId) ||
        !validTimestamp(session.createdAt) ||
        !validTimestamp(session.lastSeenAt) ||
        !validTimestamp(session.expiresAt) ||
        Date.parse(session.createdAt) > Date.parse(session.lastSeenAt) ||
        Date.parse(session.lastSeenAt) > Date.parse(session.expiresAt) ||
        Date.parse(session.expiresAt) <= now ||
        (session.kind !== "browser" && session.kind !== "api")
      ) {
        throw unavailable("Session authority returned invalid metadata");
      }
      seen.add(session.sessionId);
      return Object.freeze({
        sessionId: session.sessionId,
        current: session.current,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        kind: session.kind,
      });
    });
    return { sessions: Object.freeze(safe) };
  }

  async revoke(principal: Principal, targetSessionId: string, requestId: string) {
    this.assertHuman(principal);
    if (!sessionIdPattern.test(targetSessionId)) throw sessionUnavailable();
    const result = await this.sessions.revokeOwnedAtomic({
      principal,
      targetSessionId,
      ...(principal.sessionId === undefined ? {} : { currentSessionId: principal.sessionId }),
      now: this.now().toISOString(),
      requestId,
      reason: "user_requested",
    });
    if (result !== "revoked") throw sessionUnavailable();
    return { revoked: true } as const;
  }

  async revokeOthers(principal: Principal, requestId: string) {
    this.assertHuman(principal);
    if (!principal.sessionId || !sessionIdPattern.test(principal.sessionId)) {
      throw new GatewayError(403, "reauthentication_required", "Recent authentication is required");
    }
    const authenticatedAt = principal.authenticatedAt;
    const now = this.now();
    const nowEpochSeconds = Math.floor(now.getTime() / 1_000);
    if (
      !Number.isSafeInteger(authenticatedAt) ||
      authenticatedAt === undefined ||
      authenticatedAt > nowEpochSeconds + 5 ||
      nowEpochSeconds - authenticatedAt > this.freshAuthMaxAgeSeconds
    ) {
      throw new GatewayError(403, "reauthentication_required", "Recent authentication is required");
    }
    const result = await this.sessions.revokeOthersAtomic({
      principal,
      currentSessionId: principal.sessionId,
      authenticatedAt,
      now: now.toISOString(),
      requestId,
      reason: "user_requested_revoke_others",
    });
    if (result.status !== "revoked") throw sessionUnavailable();
    if (
      !Number.isSafeInteger(result.revokedCount) ||
      result.revokedCount < 0 ||
      result.revokedCount > 10_000
    ) {
      throw unavailable("Session authority returned an invalid revocation result");
    }
    return { revoked: true, revokedCount: result.revokedCount } as const;
  }

  private assertHuman(principal: Principal): void {
    if (principal.kind !== "human") throw forbidden();
  }
}
