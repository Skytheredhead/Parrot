export interface ReadyDependency {
  readonly adapterKind: "durable" | "test";
  readonly adapterName: string;
  ready(signal: AbortSignal): Promise<boolean>;
}

export type PrincipalKind = "human" | "agent" | "service";

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  issuedAt: number;
  expiresAt: number;
  tokenType: "access" | "session";
  sessionId?: string;
}

export interface Principal {
  id: string;
  issuer: string;
  subject: string;
  kind: PrincipalKind;
  authzEpoch: number;
  sessionId?: string;
}

export interface TokenVerifier extends ReadyDependency {
  verify(token: string): Promise<VerifiedIdentity>;
}

export interface SessionVerifier extends ReadyDependency {
  verify(sessionToken: string): Promise<VerifiedIdentity>;
}

export interface PrincipalResolver extends ReadyDependency {
  resolve(identity: VerifiedIdentity): Promise<Principal>;
}

export interface CsrfVerifier extends ReadyDependency {
  verify(input: { sessionToken: string; csrfToken: string }): Promise<boolean>;
}

export interface ResourceRef {
  workspaceId: string;
  kind: "workspace" | "space" | "file" | "message" | "post" | "task" | "dm" | "agent_run" | "tool";
  id: string;
  spaceId?: string;
}

export function resourceAuthorizationKey(resource: ResourceRef): string {
  return JSON.stringify([
    resource.workspaceId,
    resource.kind,
    resource.id,
    resource.spaceId ?? null,
  ]);
}

export interface AuthorizationRequest {
  principal: Principal;
  action: string;
  resource: ResourceRef;
}

export interface SearchScope {
  workspaceId: string;
  spaceIds: readonly string[];
  dmMembershipKeys: readonly string[];
  authzEpoch: number;
}

export interface AuthorizationClient extends ReadyDependency {
  authorize(request: AuthorizationRequest): Promise<boolean>;
  authorizeMany(
    principal: Principal,
    action: string,
    resources: readonly ResourceRef[],
  ): Promise<ReadonlySet<string>>;
  searchScope(principal: Principal, workspaceId: string): Promise<SearchScope>;
}

export interface DbTokenBroker extends ReadyDependency {
  mint(input: {
    principal: Principal;
    workspaceId: string;
    audience: string;
    authzEpoch: number;
    ttlSeconds: number;
  }): Promise<{ token: string; expiresAt: string }>;
}

export type FileLifecycle = "pending" | "quarantined" | "clean" | "rejected" | "deleted";

export interface PendingUpload {
  id: string;
  objectKey: string;
  workspaceId: string;
  spaceId: string;
  uploaderId: string;
  displayName: string;
  declaredContentType: string;
  expectedBytes: number;
  checksumSha256: string;
  expiresAt: string;
  lifecycle: "pending" | "quarantined";
}

export interface StoredFile {
  id: string;
  objectKey: string;
  objectVersion: string;
  checksumSha256: string;
  immutable: true;
  workspaceId: string;
  spaceId: string;
  displayName: string;
  detectedContentType: string;
  sizeBytes: number;
  lifecycle: FileLifecycle;
}

export interface FileMetadataStore extends ReadyDependency {
  createPending(upload: PendingUpload): Promise<void>;
  getPending(id: string): Promise<PendingUpload | null>;
  markQuarantined(
    id: string,
    observed: {
      sizeBytes: number;
      contentType: string;
      objectVersion: string;
      checksumSha256: string;
    },
  ): Promise<void>;
  getFile(id: string): Promise<StoredFile | null>;
}

export interface UploadConstraints {
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  singleWrite: true;
}

export interface ObjectStore extends ReadyDependency {
  signQuarantineUpload(input: {
    objectKey: string;
    constraints: UploadConstraints;
    ttlSeconds: number;
  }): Promise<{
    url: string;
    method: "PUT";
    expiresAt: string;
    requiredHeaders: Readonly<Record<string, string>>;
    constraints: UploadConstraints;
  }>;
  headQuarantine(objectKey: string): Promise<{
    sizeBytes: number;
    contentType: string;
    objectVersion: string;
    checksumSha256: string;
  } | null>;
  signCleanDownload(input: {
    objectKey: string;
    objectVersion: string;
    checksumSha256: string;
    displayName: string;
    contentType: string;
    ttlSeconds: number;
  }): Promise<{ url: string; expiresAt: string; objectVersion: string }>;
}

export interface SearchCandidate {
  resource: ResourceRef;
  title: string;
  snippet: string;
  occurredAt: string;
  source: "human" | "agent" | "service";
}

export interface SearchAdapter extends ReadyDependency {
  candidates(input: {
    query: string;
    scope: SearchScope;
    cursor?: string;
    limit: number;
  }): Promise<{ candidates: readonly SearchCandidate[]; nextCursor?: string }>;
}

export interface SearchCursorBinding {
  principalId: string;
  workspaceId: string;
  queryHash: string;
  authzEpoch: number;
}

export interface SearchCursorCodec extends ReadyDependency {
  encode(input: SearchCursorBinding & { engineCursor: string; expiresAt: number }): Promise<string>;
  decode(cursor: string, binding: SearchCursorBinding, nowEpochSeconds: number): Promise<string>;
}

export interface PrincipalRateLimitInput {
  principalId: string;
  scope: string;
  cost: number;
}

export interface IpRateLimitInput {
  ip: string;
  scope: string;
  cost: number;
}

export interface WorkspaceRateLimitInput extends PrincipalRateLimitInput {
  workspaceId: string;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface RateLimitClient extends ReadyDependency {
  consumeIp(input: IpRateLimitInput): Promise<RateLimitResult>;
  consumePrincipal(input: PrincipalRateLimitInput): Promise<RateLimitResult>;
  consumeWorkspace(input: WorkspaceRateLimitInput): Promise<RateLimitResult>;
}

export interface WebhookEndpoint {
  id: string;
  provider: string;
  enabled: boolean;
}

export interface WebhookVerificationRequest {
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Uint8Array;
  receivedAt: Date;
  maxSkewSeconds: number;
}

export interface WebhookSignatureVerifier {
  verify(input: WebhookVerificationRequest): Promise<{ eventId: string }>;
}

export interface ResolvedWebhookEndpoint {
  endpoint: WebhookEndpoint;
  verifier: WebhookSignatureVerifier;
}

export interface WebhookRegistry extends ReadyDependency {
  resolve(provider: string): Promise<ResolvedWebhookEndpoint | null>;
}

export interface WebhookReceiptStore extends ReadyDependency {
  enqueueOnce(input: {
    endpoint: WebhookEndpoint;
    eventId: string;
    body: Uint8Array;
    receivedAt: Date;
  }): Promise<"accepted" | "duplicate">;
}

export interface AgentStreamBroker extends ReadyDependency {
  issue(input: {
    principal: Principal;
    workspaceId: string;
    runId: string;
    audience: string;
    purpose: "agent-stream";
    authzEpoch: number;
    singleUse: true;
    ttlSeconds: number;
  }): Promise<{ token: string; expiresAt: string; streamUrl: string }>;
}

export interface AgentToolGateway extends ReadyDependency {
  invoke(input: {
    principal: Principal;
    workspaceId: string;
    runId: string;
    toolName: string;
    authzEpoch: number;
    idempotencyScope: string;
    argumentsHash: string;
    arguments: unknown;
  }): Promise<{ invocationId: string; status: "accepted" | "completed"; output?: unknown }>;
}

export interface ReadinessProbe {
  name: string;
  check(signal: AbortSignal): Promise<boolean>;
}

export interface GatewayDependencies {
  tokenVerifier: TokenVerifier;
  sessionVerifier: SessionVerifier;
  principalResolver: PrincipalResolver;
  csrf: CsrfVerifier;
  authorization: AuthorizationClient;
  dbTokenBroker: DbTokenBroker;
  files: FileMetadataStore;
  objects: ObjectStore;
  search: SearchAdapter;
  searchCursors: SearchCursorCodec;
  rateLimits: RateLimitClient;
  webhooks: WebhookRegistry;
  webhookReceipts: WebhookReceiptStore;
  agentStreams: AgentStreamBroker;
  agentTools: AgentToolGateway;
  readiness?: readonly ReadinessProbe[];
}
