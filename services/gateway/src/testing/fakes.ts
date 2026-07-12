import { createHash, timingSafeEqual } from "node:crypto";
import { resourceAuthorizationKey } from "../contracts.js";
import type {
  AgentStreamBroker,
  AgentToolGateway,
  AuthorizationClient,
  AuthorizationRequest,
  CsrfVerifier,
  DbTokenBroker,
  FileMetadataStore,
  GatewayDependencies,
  IpRateLimitInput,
  InvitationCreateRecord,
  InvitationRedemptionResult,
  InvitationStore,
  ObjectStore,
  PendingUpload,
  Principal,
  PrincipalRateLimitInput,
  PrincipalResolver,
  RateLimitClient,
  ResourceRef,
  SearchAdapter,
  SearchCandidate,
  SearchScope,
  SessionAdministration,
  SessionVerifier,
  StoredFile,
  TokenVerifier,
  UserSessionMetadata,
  VerifiedIdentity,
  WebhookReceiptStore,
  WebhookRegistry,
  WorkspaceRateLimitInput,
} from "../contracts.js";
import { GatewayError } from "../errors.js";
import { unauthorized } from "../errors.js";
import { HmacSearchCursorCodec } from "../search/cursor.js";
import { HmacInvitationTokenHasher } from "../invitations/token.js";

export const TEST_IDENTITY: VerifiedIdentity = {
  issuer: "https://issuer.test",
  subject: "subject-1",
  issuedAt: 1_700_000_000,
  expiresAt: 4_000_000_000,
  tokenType: "access",
  sessionId: "session-1",
  authenticatedAt: Math.floor(Date.now() / 1_000),
};

export const TEST_PRINCIPAL: Principal = {
  id: "user-1",
  issuer: TEST_IDENTITY.issuer,
  subject: TEST_IDENTITY.subject,
  kind: "human",
  sessionId: "session-1",
  authzEpoch: 1,
};

abstract class ReadyFake {
  readonly adapterKind = "test" as const;
  readonly adapterName = "in-memory-test-adapter";
  readyValue = true;

  async ready(signal: AbortSignal): Promise<boolean> {
    return this.readyValue && !signal.aborted;
  }
}

export class FakeTokenVerifier extends ReadyFake implements TokenVerifier, SessionVerifier {
  readonly tokens = new Map<string, VerifiedIdentity>([
    ["valid-token", TEST_IDENTITY],
    ["valid-session", { ...TEST_IDENTITY, tokenType: "session" }],
  ]);

  async verify(token: string): Promise<VerifiedIdentity> {
    const identity = this.tokens.get(token);
    if (!identity) throw unauthorized("Test credential rejected");
    return identity;
  }
}

export class InMemoryPrincipalResolver extends ReadyFake implements PrincipalResolver {
  principal: Principal = TEST_PRINCIPAL;
  readonly calls: VerifiedIdentity[] = [];

  async resolve(identity: VerifiedIdentity): Promise<Principal> {
    this.calls.push(identity);
    return this.principal;
  }
}

export class InMemoryCsrfVerifier extends ReadyFake implements CsrfVerifier {
  async verify(input: { sessionToken: string; csrfToken: string }): Promise<boolean> {
    return input.csrfToken === `csrf:${input.sessionToken}`;
  }
}

export class InMemoryAuthorization extends ReadyFake implements AuthorizationClient {
  readonly requests: AuthorizationRequest[] = [];
  allowed: (request: AuthorizationRequest) => boolean = () => true;
  scope: SearchScope = {
    workspaceId: "workspace-1",
    spaceIds: ["space-1"],
    dmMembershipKeys: [],
    authzEpoch: 1,
  };

  async authorize(request: AuthorizationRequest): Promise<boolean> {
    this.requests.push(request);
    return this.allowed(request);
  }

  async authorizeMany(
    principal: Principal,
    action: string,
    resources: readonly ResourceRef[],
  ): Promise<ReadonlySet<string>> {
    const keys = new Set<string>();
    for (const resource of resources) {
      const request = { principal, action, resource };
      this.requests.push(request);
      if (this.allowed(request)) keys.add(resourceAuthorizationKey(resource));
    }
    return keys;
  }

  async searchScope(_principal: Principal, workspaceId: string): Promise<SearchScope> {
    return { ...this.scope, workspaceId };
  }
}

export class FakeDbTokenBroker extends ReadyFake implements DbTokenBroker {
  readonly calls: Parameters<DbTokenBroker["mint"]>[0][] = [];

  async mint(input: Parameters<DbTokenBroker["mint"]>[0]) {
    this.calls.push(input);
    return {
      token: "short-lived-db-token",
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000).toISOString(),
    };
  }
}

export class InMemoryFiles extends ReadyFake implements FileMetadataStore {
  readonly pending = new Map<string, PendingUpload>();
  readonly stored = new Map<string, StoredFile>();
  readonly observed = new Map<string, Parameters<FileMetadataStore["markQuarantined"]>[1]>();

  async createPending(upload: PendingUpload): Promise<void> {
    if (this.pending.has(upload.id)) throw new Error("duplicate upload");
    this.pending.set(upload.id, upload);
  }

  async getPending(id: string): Promise<PendingUpload | null> {
    return this.pending.get(id) ?? null;
  }

  async markQuarantined(
    id: string,
    observed: Parameters<FileMetadataStore["markQuarantined"]>[1],
  ): Promise<void> {
    const value = this.pending.get(id);
    if (!value) throw new Error("missing upload");
    this.pending.set(id, { ...value, lifecycle: "quarantined" });
    this.observed.set(id, observed);
  }

  async getFile(id: string): Promise<StoredFile | null> {
    return this.stored.get(id) ?? null;
  }
}

export class InMemoryObjectStore extends ReadyFake implements ObjectStore {
  readonly quarantine = new Map<
    string,
    Awaited<ReturnType<ObjectStore["headQuarantine"]>> extends infer T ? Exclude<T, null> : never
  >();
  readonly uploadCalls: Parameters<ObjectStore["signQuarantineUpload"]>[0][] = [];
  readonly downloadCalls: Parameters<ObjectStore["signCleanDownload"]>[0][] = [];
  mutateUploadCapability?: (
    value: Awaited<ReturnType<ObjectStore["signQuarantineUpload"]>>,
  ) => Awaited<ReturnType<ObjectStore["signQuarantineUpload"]>>;
  mutateDownloadCapability?: (
    value: Awaited<ReturnType<ObjectStore["signCleanDownload"]>>,
  ) => Awaited<ReturnType<ObjectStore["signCleanDownload"]>>;

  async signQuarantineUpload(input: Parameters<ObjectStore["signQuarantineUpload"]>[0]) {
    this.uploadCalls.push(input);
    const value = {
      url: `https://objects.test/upload/${encodeURIComponent(input.objectKey)}?signature=test`,
      method: "PUT" as const,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000).toISOString(),
      requiredHeaders: {
        "content-type": input.constraints.contentType,
        "content-length": String(input.constraints.sizeBytes),
        "x-checksum-sha256": input.constraints.checksumSha256,
        "if-none-match": "*",
      },
      constraints: input.constraints,
    };
    return this.mutateUploadCapability ? this.mutateUploadCapability(value) : value;
  }

  async headQuarantine(objectKey: string) {
    return this.quarantine.get(objectKey) ?? null;
  }

  async signCleanDownload(input: Parameters<ObjectStore["signCleanDownload"]>[0]) {
    this.downloadCalls.push(input);
    const value = {
      url: `https://objects.test/download/${encodeURIComponent(input.objectKey)}?signature=test&version=${input.objectVersion}`,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000).toISOString(),
      objectVersion: input.objectVersion,
    };
    return this.mutateDownloadCapability ? this.mutateDownloadCapability(value) : value;
  }
}

export class InMemorySearch extends ReadyFake implements SearchAdapter {
  candidatesList: SearchCandidate[] = [];
  readonly calls: Parameters<SearchAdapter["candidates"]>[0][] = [];
  repeatCursor = false;

  async candidates(input: Parameters<SearchAdapter["candidates"]>[0]) {
    this.calls.push(input);
    const offset = input.cursor
      ? Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10)
      : 0;
    const candidates = this.candidatesList.slice(offset, offset + input.limit);
    const nextOffset = offset + candidates.length;
    return {
      candidates,
      ...(nextOffset < this.candidatesList.length
        ? {
            nextCursor:
              this.repeatCursor && input.cursor
                ? input.cursor
                : Buffer.from(String(nextOffset)).toString("base64url"),
          }
        : {}),
    };
  }
}

export class InMemoryRateLimits extends ReadyFake implements RateLimitClient {
  ipAllowed = true;
  ipAllowedFor?: (input: IpRateLimitInput) => boolean;
  principalAllowed = true;
  workspaceAllowed = true;
  retryAfterSeconds = 1;
  readonly ipCalls: IpRateLimitInput[] = [];
  readonly principalCalls: PrincipalRateLimitInput[] = [];
  readonly workspaceCalls: WorkspaceRateLimitInput[] = [];

  async consumeIp(input: IpRateLimitInput) {
    this.ipCalls.push(input);
    const allowed = this.ipAllowedFor?.(input) ?? this.ipAllowed;
    return {
      allowed,
      ...(allowed ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }

  async consumePrincipal(input: PrincipalRateLimitInput) {
    this.principalCalls.push(input);
    return {
      allowed: this.principalAllowed,
      ...(this.principalAllowed ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }

  async consumeWorkspace(input: WorkspaceRateLimitInput) {
    this.workspaceCalls.push(input);
    return {
      allowed: this.workspaceAllowed,
      ...(this.workspaceAllowed ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }
}

export class InMemoryWebhooks extends ReadyFake implements WebhookRegistry {
  readonly endpoints = new Map<
    string,
    Awaited<ReturnType<WebhookRegistry["resolve"]>> extends infer T ? Exclude<T, null> : never
  >();

  async resolve(provider: string) {
    return this.endpoints.get(provider) ?? null;
  }
}

export class InMemoryWebhookReceipts extends ReadyFake implements WebhookReceiptStore {
  private readonly accepted = new Set<string>();
  readonly queue: Parameters<WebhookReceiptStore["enqueueOnce"]>[0][] = [];

  async enqueueOnce(
    input: Parameters<WebhookReceiptStore["enqueueOnce"]>[0],
  ): Promise<"accepted" | "duplicate"> {
    const key = JSON.stringify([input.endpoint.id, input.eventId]);
    if (this.accepted.has(key)) return "duplicate";
    this.accepted.add(key);
    this.queue.push(input);
    return "accepted";
  }
}

export class FakeAgentStreamBroker extends ReadyFake implements AgentStreamBroker {
  readonly calls: Parameters<AgentStreamBroker["issue"]>[0][] = [];
  mutateTicket?: (
    value: Awaited<ReturnType<AgentStreamBroker["issue"]>>,
  ) => Awaited<ReturnType<AgentStreamBroker["issue"]>>;

  async issue(input: Parameters<AgentStreamBroker["issue"]>[0]) {
    this.calls.push(input);
    const value = {
      token: "agent-stream-token",
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000).toISOString(),
      streamUrl: `wss://gateway.test/v1/agent/runs/${input.runId}/stream`,
    };
    return this.mutateTicket ? this.mutateTicket(value) : value;
  }
}

export class FakeAgentToolGateway extends ReadyFake implements AgentToolGateway {
  readonly calls: Parameters<AgentToolGateway["invoke"]>[0][] = [];
  private readonly bindings = new Map<string, string>();

  async invoke(input: Parameters<AgentToolGateway["invoke"]>[0]) {
    const existing = this.bindings.get(input.idempotencyScope);
    if (existing !== undefined && existing !== input.argumentsHash) {
      throw new GatewayError(
        409,
        "idempotency_conflict",
        "Idempotency key was already used with different arguments",
      );
    }
    this.bindings.set(input.idempotencyScope, input.argumentsHash);
    this.calls.push(input);
    return {
      invocationId: createHash("sha256").update(input.idempotencyScope).digest("hex").slice(0, 16),
      status: "accepted" as const,
    };
  }
}

interface StoredInvitation extends InvitationCreateRecord {
  revoked: boolean;
  useCount: number;
}

export class InMemoryInvitations extends ReadyFake implements InvitationStore {
  readonly records = new Map<string, StoredInvitation>();
  readonly memberships = new Map<string, string>();
  readonly audits: Array<Readonly<Record<string, unknown>>> = [];

  async createAtomic(input: InvitationCreateRecord): Promise<void> {
    if (this.records.has(input.invitationId)) throw new Error("invitation_id_conflict");
    this.records.set(input.invitationId, {
      ...structuredClone(input),
      revoked: false,
      useCount: 0,
    });
    this.audits.push({
      action: "invitation.created",
      invitationId: input.invitationId,
      actorId: input.creator.id,
      requestId: input.requestId,
    });
  }

  async redeemAtomic(input: {
    invitationId: string;
    verificationHashes: readonly { keyId: string; digest: string }[];
    principal: Principal;
    normalizedVerifiedEmail: string;
    now: string;
    requestId: string;
  }): Promise<InvitationRedemptionResult> {
    const record = this.records.get(input.invitationId);
    const expected = record ? Buffer.from(record.tokenHash.digest, "base64url") : Buffer.alloc(32);
    let hashMatches = false;
    for (const candidate of input.verificationHashes) {
      const decoded = Buffer.from(candidate.digest, "base64url");
      const fixed = Buffer.alloc(32);
      decoded.copy(fixed, 0, 0, Math.min(decoded.length, fixed.length));
      const digestMatches = timingSafeEqual(expected, fixed);
      hashMatches ||=
        record !== undefined &&
        decoded.length === 32 &&
        candidate.keyId === record.tokenHash.keyId &&
        digestMatches;
    }
    if (
      !record ||
      !hashMatches ||
      record.revoked ||
      Date.parse(record.expiresAt) <= Date.parse(input.now) ||
      record.useCount >= record.useLimit ||
      (record.normalizedEmail !== undefined &&
        record.normalizedEmail !== input.normalizedVerifiedEmail)
    ) {
      return { status: "unavailable" };
    }
    const membershipKey = `${input.principal.id}\0${record.workspaceId}`;
    const existingMembership = this.memberships.get(membershipKey);
    if (existingMembership) {
      return {
        status: "accepted",
        workspaceId: record.workspaceId,
        membershipId: existingMembership,
        role: record.role,
        useCount: record.useCount,
        useLimit: record.useLimit,
      };
    }
    record.useCount += 1;
    const membershipId = createHash("sha256").update(membershipKey).digest("hex").slice(0, 24);
    this.memberships.set(membershipKey, membershipId);
    this.audits.push({
      action: "invitation.redeemed",
      invitationId: record.invitationId,
      actorId: input.principal.id,
      membershipId,
      requestId: input.requestId,
    });
    return {
      status: "accepted",
      workspaceId: record.workspaceId,
      membershipId,
      role: record.role,
      useCount: record.useCount,
      useLimit: record.useLimit,
    };
  }

  revoke(invitationId: string): void {
    const record = this.records.get(invitationId);
    if (record) record.revoked = true;
  }
}

interface StoredUserSession extends UserSessionMetadata {
  ownerPrincipalId: string;
  revoked: boolean;
}

export class InMemorySessions extends ReadyFake implements SessionAdministration {
  readonly sessions = new Map<string, StoredUserSession>();
  readonly audits: Array<Readonly<Record<string, unknown>>> = [];

  add(ownerPrincipalId: string, session: UserSessionMetadata): void {
    this.sessions.set(session.sessionId, {
      ...structuredClone(session),
      ownerPrincipalId,
      revoked: false,
    });
  }

  async listOwned(input: {
    principal: Principal;
    currentSessionId?: string;
    limit: number;
  }): Promise<readonly UserSessionMetadata[]> {
    return [...this.sessions.values()]
      .filter((session) => session.ownerPrincipalId === input.principal.id && !session.revoked)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, input.limit)
      .map(({ ownerPrincipalId: _owner, revoked: _revoked, ...session }) => ({
        ...structuredClone(session),
        current: session.sessionId === input.currentSessionId,
      }));
  }

  async revokeOwnedAtomic(input: {
    principal: Principal;
    targetSessionId: string;
    currentSessionId?: string;
    now: string;
    requestId: string;
    reason: "user_requested";
  }): Promise<"revoked" | "unavailable"> {
    const session = this.sessions.get(input.targetSessionId);
    if (!session || session.revoked || session.ownerPrincipalId !== input.principal.id) {
      return "unavailable";
    }
    session.revoked = true;
    this.audits.push({
      action: "session.revoked",
      actorId: input.principal.id,
      targetSessionId: input.targetSessionId,
      currentSessionId: input.currentSessionId,
      requestId: input.requestId,
      occurredAt: input.now,
      reason: input.reason,
    });
    return "revoked";
  }

  async revokeOthersAtomic(input: {
    principal: Principal;
    currentSessionId: string;
    authenticatedAt: number;
    now: string;
    requestId: string;
    reason: "user_requested_revoke_others";
  }): Promise<{ status: "revoked"; revokedCount: number } | { status: "unavailable" }> {
    const current = this.sessions.get(input.currentSessionId);
    if (!current || current.revoked || current.ownerPrincipalId !== input.principal.id) {
      return { status: "unavailable" };
    }
    let revokedCount = 0;
    for (const session of this.sessions.values()) {
      if (
        session.ownerPrincipalId === input.principal.id &&
        session.sessionId !== input.currentSessionId &&
        !session.revoked
      ) {
        session.revoked = true;
        revokedCount += 1;
      }
    }
    this.audits.push({
      action: "session.others_revoked",
      actorId: input.principal.id,
      currentSessionId: input.currentSessionId,
      authenticatedAt: input.authenticatedAt,
      revokedCount,
      requestId: input.requestId,
      occurredAt: input.now,
      reason: input.reason,
    });
    return { status: "revoked", revokedCount };
  }
}

export interface TestDependencies extends GatewayDependencies {
  tokenVerifier: FakeTokenVerifier;
  sessionVerifier: FakeTokenVerifier;
  principalResolver: InMemoryPrincipalResolver;
  csrf: InMemoryCsrfVerifier;
  authorization: InMemoryAuthorization;
  dbTokenBroker: FakeDbTokenBroker;
  files: InMemoryFiles;
  objects: InMemoryObjectStore;
  search: InMemorySearch;
  searchCursors: HmacSearchCursorCodec;
  rateLimits: InMemoryRateLimits;
  webhooks: InMemoryWebhooks;
  webhookReceipts: InMemoryWebhookReceipts;
  agentStreams: FakeAgentStreamBroker;
  agentTools: FakeAgentToolGateway;
  invitationTokens: HmacInvitationTokenHasher;
  invitations: InMemoryInvitations;
  sessions: InMemorySessions;
}

export function createTestDependencies(): TestDependencies {
  const credentials = new FakeTokenVerifier();
  const sessions = new InMemorySessions();
  sessions.add(TEST_PRINCIPAL.id, {
    sessionId: "session-1",
    current: true,
    createdAt: "2026-07-10T12:00:00.000Z",
    lastSeenAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-18T12:00:00.000Z",
    kind: "browser",
  });
  sessions.add(TEST_PRINCIPAL.id, {
    sessionId: "session-2",
    current: false,
    createdAt: "2026-07-09T12:00:00.000Z",
    lastSeenAt: "2026-07-10T12:00:00.000Z",
    expiresAt: "2026-07-17T12:00:00.000Z",
    kind: "browser",
  });
  return {
    tokenVerifier: credentials,
    sessionVerifier: credentials,
    principalResolver: new InMemoryPrincipalResolver(),
    csrf: new InMemoryCsrfVerifier(),
    authorization: new InMemoryAuthorization(),
    dbTokenBroker: new FakeDbTokenBroker(),
    files: new InMemoryFiles(),
    objects: new InMemoryObjectStore(),
    search: new InMemorySearch(),
    searchCursors: new HmacSearchCursorCodec([Buffer.alloc(32, 7)]),
    rateLimits: new InMemoryRateLimits(),
    webhooks: new InMemoryWebhooks(),
    webhookReceipts: new InMemoryWebhookReceipts(),
    agentStreams: new FakeAgentStreamBroker(),
    agentTools: new FakeAgentToolGateway(),
    invitationTokens: new HmacInvitationTokenHasher([
      { keyId: "test-key", key: Buffer.alloc(32, 11) },
    ]),
    invitations: new InMemoryInvitations(),
    sessions,
  };
}
