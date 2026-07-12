import { randomUUID } from "node:crypto";
import type { VerifiedBearerProvenance } from "../auth/oidc.js";
import type {
  AuthorizationClient,
  AuthorizationRequest,
  DbTokenBroker,
  FileMetadataStore,
  PendingUpload,
  Principal,
  PrincipalResolver,
  ResourceRef,
  SearchScope,
  StoredFile,
  VerifiedIdentity,
} from "../contracts.js";
import { resourceAuthorizationKey } from "../contracts.js";
import { unauthorized, unavailable } from "../errors.js";

const BINDINGS_PACKAGE = "@project-conversation/db-bindings";
const SUBSCRIBED_VIEWS = Object.freeze([
  "current_gateway_principal",
  "my_gateway_workspace_grants",
  "my_gateway_space_grants",
  "my_gateway_file_descriptors",
  "my_gateway_pending_uploads",
  "visible_direct_participants",
]);

type Row = Readonly<Record<string, unknown>>;

export interface GatewaySpacetimeTransport {
  readonly connectionIdentity: string;
  readonly connected: boolean;
  rows(accessor: string): readonly Row[];
  reduce(accessor: string, input: Readonly<Record<string, unknown>>): Promise<void>;
  close(): void;
}

export interface GatewaySpacetimeConnector {
  connect(input: {
    uri: string;
    databaseName: string;
    bearerToken: string;
    timeoutMs: number;
  }): Promise<GatewaySpacetimeTransport>;
}

interface GeneratedConnection {
  readonly db: Record<string, { iter(): IterableIterator<unknown> }>;
  readonly reducers: Record<string, (input: Readonly<Record<string, unknown>>) => Promise<void>>;
  subscriptionBuilder(): {
    onApplied(callback: () => void): GeneratedSubscriptionBuilder;
    onError(callback: () => void): GeneratedSubscriptionBuilder;
    subscribe(sql: readonly string[]): { unsubscribe(): void };
  };
  disconnect(): void;
}

interface GeneratedSubscriptionBuilder {
  onApplied(callback: () => void): GeneratedSubscriptionBuilder;
  onError(callback: () => void): GeneratedSubscriptionBuilder;
  subscribe(sql: readonly string[]): { unsubscribe(): void };
}

interface GeneratedBuilder {
  withUri(uri: string): GeneratedBuilder;
  withDatabaseName(databaseName: string): GeneratedBuilder;
  withToken(token: string): GeneratedBuilder;
  onConnect(
    callback: (connection: GeneratedConnection, identity: unknown) => void,
  ): GeneratedBuilder;
  onConnectError(callback: (_context: unknown, error: Error) => void): GeneratedBuilder;
  build(): GeneratedConnection;
}

interface GeneratedBindings {
  DbConnection: { builder(): GeneratedBuilder };
}

function identityString(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const toHex = (value as { toHexString?: unknown }).toHexString;
    if (typeof toHex === "function") return String(toHex.call(value));
  }
  return String(value ?? "");
}

function tableAccessor(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function valueString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const stringify = (value as { toString?: unknown }).toString;
    if (typeof stringify === "function") return String(stringify.call(value));
  }
  return "";
}

function safeNumber(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    throw unavailable("SpacetimeDB returned an invalid integer");
  return number;
}

function timestampIso(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "object" && value !== null) {
    const micros = (value as { microsSinceUnixEpoch?: unknown }).microsSinceUnixEpoch;
    if (typeof micros === "bigint") return new Date(Number(micros / 1_000n)).toISOString();
    const toDate = (value as { toDate?: unknown }).toDate;
    if (typeof toDate === "function") {
      const date = toDate.call(value);
      if (date instanceof Date && Number.isFinite(date.getTime())) return date.toISOString();
    }
  }
  throw unavailable("SpacetimeDB returned an invalid timestamp");
}

function enumTag(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const tag = (value as { tag?: unknown }).tag;
    if (typeof tag === "string") return tag;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0]) return keys[0];
  }
  return "";
}

function uuid(value: string): Readonly<{ __uuid__: bigint }> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))
    throw unavailable("A canonical UUID is required by SpacetimeDB");
  return Object.freeze({ __uuid__: BigInt(`0x${value.replaceAll("-", "")}`) });
}

export const generatedGatewaySpacetimeConnector: GatewaySpacetimeConnector = {
  async connect(input): Promise<GatewaySpacetimeTransport> {
    const bindings = (await import(BINDINGS_PACKAGE)) as GeneratedBindings;
    let connection: GeneratedConnection | undefined;
    let subscription: { unsubscribe(): void } | undefined;
    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<{ connection: GeneratedConnection; identity: string }>(
      (resolve, reject) => {
        const builder = bindings.DbConnection.builder()
          .withUri(input.uri)
          .withDatabaseName(input.databaseName)
          .withToken(input.bearerToken)
          .onConnect((candidate, identity) => {
            connection = candidate;
            subscription = candidate
              .subscriptionBuilder()
              .onApplied(() =>
                resolve({ connection: candidate, identity: identityString(identity) }),
              )
              .onError(() => reject(new Error("spacetime_gateway_subscription_failed")))
              .subscribe(SUBSCRIBED_VIEWS.map((view) => `SELECT * FROM ${view}`));
          })
          .onConnectError((_context, error) => reject(error));
        builder.build();
        timer = setTimeout(
          () => reject(new Error("spacetime_gateway_connect_timeout")),
          input.timeoutMs,
        );
        timer.unref?.();
      },
    );
    try {
      const connected = await ready;
      const db = connected.connection.db;
      const reducers = connected.connection.reducers;
      let active = true;
      return {
        connectionIdentity: connected.identity,
        get connected() {
          return active;
        },
        rows(accessor) {
          if (!active) throw new Error("spacetime_gateway_connection_closed");
          const table = db[tableAccessor(accessor)];
          if (!table) throw new Error(`spacetime_gateway_view_missing:${accessor}`);
          return [...table.iter()] as Row[];
        },
        async reduce(accessor, reducerInput) {
          if (!active) throw new Error("spacetime_gateway_connection_closed");
          const reducer = reducers[accessor];
          if (!reducer) throw new Error(`spacetime_gateway_reducer_missing:${accessor}`);
          await reducer(reducerInput);
        },
        close() {
          if (!active) return;
          active = false;
          subscription?.unsubscribe();
          connected.connection.disconnect();
        },
      };
    } catch (error) {
      subscription?.unsubscribe();
      connection?.disconnect();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};

interface AuthoritySession {
  transport: GatewaySpacetimeTransport;
  identity: VerifiedIdentity;
  connectionIdentity: string;
  idleTimer?: NodeJS.Timeout;
}

export interface SpacetimeGatewayAuthorityOptions {
  readonly uri: string;
  readonly databaseName: string;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly idleTimeoutMs?: number;
}

export class SpacetimeGatewayAuthority
  implements PrincipalResolver, AuthorizationClient, FileMetadataStore, DbTokenBroker
{
  readonly adapterKind = "durable" as const;
  readonly adapterName = "caller-attested-spacetimedb-authority";
  readonly #resolvedSessions = new WeakMap<Principal, AuthoritySession>();
  readonly #checkedSessions = new WeakMap<Principal, AuthoritySession>();

  constructor(
    private readonly options: SpacetimeGatewayAuthorityOptions,
    private readonly bearers: VerifiedBearerProvenance,
    private readonly connector: GatewaySpacetimeConnector = generatedGatewaySpacetimeConnector,
  ) {}

  async ready(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted;
  }

  async resolve(identity: VerifiedIdentity): Promise<Principal> {
    const bearer = this.bearers.bearerFor(identity);
    if (!bearer) throw unauthorized("Verified bearer provenance is unavailable");
    let transport: GatewaySpacetimeTransport;
    try {
      transport = await this.connector.connect({
        uri: this.options.uri,
        databaseName: this.options.databaseName,
        bearerToken: bearer,
        timeoutMs: this.options.connectTimeoutMs,
      });
    } catch {
      throw unavailable("SpacetimeDB identity authority is unavailable");
    }
    const rows = transport.rows("currentGatewayPrincipal");
    if (rows.length !== 1) {
      transport.close();
      throw unauthorized("The authenticated principal is not registered");
    }
    const row = rows[0] as Row;
    const connectionIdentity = identityString(row.identity);
    if (
      !connectionIdentity ||
      connectionIdentity !== transport.connectionIdentity ||
      row.disabled !== false
    ) {
      transport.close();
      throw unauthorized("The authenticated principal is disabled or mismatched");
    }
    const principal = Object.freeze({
      id: connectionIdentity,
      issuer: identity.issuer,
      subject: identity.subject,
      kind: "human" as const,
      authzEpoch: safeNumber(row.authzEpoch),
    });
    const session = { transport, identity, connectionIdentity } satisfies AuthoritySession;
    this.#resolvedSessions.set(principal, session);
    this.touch(session);
    return principal;
  }

  bindCheckedPrincipal(input: {
    identity: VerifiedIdentity;
    resolved: Principal;
    checked: Principal;
  }): void {
    const session = this.#resolvedSessions.get(input.resolved);
    if (
      !session ||
      session.identity !== input.identity ||
      input.checked.id !== input.resolved.id ||
      input.checked.authzEpoch !== input.resolved.authzEpoch
    )
      throw unauthorized("Principal provenance binding failed");
    this.#resolvedSessions.delete(input.resolved);
    this.#checkedSessions.set(input.checked, session);
    this.touch(session);
  }

  async authorize(request: AuthorizationRequest): Promise<boolean> {
    const session = this.session(request.principal);
    return this.authorized(session, request.action, request.resource, request.principal.authzEpoch);
  }

  async authorizeMany(
    principal: Principal,
    action: string,
    resources: readonly ResourceRef[],
  ): Promise<ReadonlySet<string>> {
    if (resources.length > 100) throw unavailable("Authorization batch exceeds its bound");
    const session = this.session(principal);
    const authorized = new Set<string>();
    for (const resource of resources) {
      if (this.authorized(session, action, resource, principal.authzEpoch))
        authorized.add(resourceAuthorizationKey(resource));
    }
    return authorized;
  }

  async searchScope(principal: Principal, workspaceId: string): Promise<SearchScope> {
    const session = this.session(principal);
    const workspace = this.workspaceGrant(session, workspaceId, principal.authzEpoch);
    if (workspace?.canRead !== true) throw unauthorized("Search scope is unavailable");
    const spaceIds = session.transport
      .rows("myGatewaySpaceGrants")
      .filter((row) => valueString(row.workspaceId) === workspaceId && row.canRead === true)
      .map((row) => valueString(row.spaceId));
    const dmMembershipKeys = session.transport
      .rows("visibleDirectParticipants")
      .filter(
        (row) =>
          valueString(row.workspaceId) === workspaceId &&
          (row.leftAt === undefined || row.leftAt === null),
      )
      .map((row) => valueString(row.key));
    return {
      workspaceId,
      spaceIds: [...new Set(spaceIds)],
      dmMembershipKeys: [...new Set(dmMembershipKeys)],
      authzEpoch: principal.authzEpoch,
    };
  }

  async mint(input: Parameters<DbTokenBroker["mint"]>[0]) {
    const session = this.session(input.principal);
    const workspace = this.workspaceGrant(session, input.workspaceId, input.authzEpoch);
    if (workspace?.canRead !== true) throw unauthorized("Database access is unavailable");
    const bearer = this.bearers.bearerFor(session.identity);
    if (!bearer) throw unauthorized("Verified bearer provenance expired");
    const part = bearer.split(".")[1];
    if (!part) throw unauthorized("Verified bearer is not a JWT");
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    } catch {
      throw unauthorized("Verified bearer claims are unavailable");
    }
    if (typeof claims !== "object" || claims === null) throw unauthorized();
    const audience = (claims as { aud?: unknown }).aud;
    const audiences = typeof audience === "string" ? [audience] : audience;
    const expiresAt = (claims as { exp?: unknown }).exp;
    if (
      !Array.isArray(audiences) ||
      audiences.some((value) => typeof value !== "string") ||
      !audiences.includes(input.audience) ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt !== session.identity.expiresAt ||
      expiresAt * 1_000 <= Date.now()
    )
      throw unauthorized("Verified bearer is not valid for SpacetimeDB");
    return { token: bearer, expiresAt: new Date(expiresAt * 1_000).toISOString() };
  }

  async createPending(
    input: Parameters<FileMetadataStore["createPending"]>[0],
  ): Promise<PendingUpload> {
    const session = this.session(input.principal);
    const ttlSeconds = Math.max(
      1,
      Math.min(900, Math.floor((Date.parse(input.maximumExpiresAt) - Date.now()) / 1_000)),
    );
    await this.reduceAndObserve(
      session,
      "createFileUpload",
      {
        input: {
          reservationId: uuid(input.reservationId),
          spaceId: uuid(input.spaceId),
          fileName: input.displayName,
          declaredType: input.declaredContentType,
          declaredSizeBytes: BigInt(input.expectedBytes),
          checksum: input.checksumSha256,
          ttlSeconds,
          clientRequestId: uuid(randomUUID()),
        },
      },
      "myGatewayPendingUploads",
      (row) => valueString(row.uploadId) === input.reservationId,
    );
    const pending = this.pendingRow(session, input.reservationId);
    if (!pending) throw unavailable("SpacetimeDB did not publish the upload reservation");
    return pending;
  }

  async getPending(principal: Principal, id: string): Promise<PendingUpload | null> {
    return this.pendingRow(this.session(principal), id);
  }

  async markQuarantined(
    principal: Principal,
    id: string,
    observed: Parameters<FileMetadataStore["markQuarantined"]>[2],
  ): Promise<void> {
    const session = this.session(principal);
    const row = session.transport
      .rows("myGatewayPendingUploads")
      .find((candidate) => valueString(candidate.uploadId) === id);
    if (!row) throw unavailable("Upload reservation is unavailable");
    await this.reduceAndObserve(
      session,
      "completeFileUpload",
      {
        input: {
          uploadId: uuid(id),
          fileId: uuid(valueString(row.fileId)),
          expectedRevision: BigInt(safeNumber(row.fileRevision)),
          observedSizeBytes: BigInt(observed.sizeBytes),
          observedType: observed.contentType,
          objectVersion: observed.objectVersion,
          checksumSha256: observed.checksumSha256,
          clientRequestId: uuid(randomUUID()),
        },
      },
      "myGatewayPendingUploads",
      (candidate) => valueString(candidate.uploadId) === id && candidate.completed === true,
    );
  }

  async getFile(principal: Principal, id: string): Promise<StoredFile | null> {
    const session = this.session(principal);
    const row = session.transport
      .rows("myGatewayFileDescriptors")
      .find((candidate) => valueString(candidate.fileId) === id);
    if (!row) return null;
    const state = enumTag(row.state).toLowerCase();
    const lifecycle: StoredFile["lifecycle"] = ["clean", "extracted"].includes(state)
      ? "clean"
      : state === "rejected"
        ? "rejected"
        : state === "deleted"
          ? "deleted"
          : state === "uploadpending"
            ? "pending"
            : "quarantined";
    return {
      id,
      objectKey: valueString(row.objectKey),
      objectVersion: valueString(row.objectVersion),
      checksumSha256: valueString(row.checksumSha256),
      immutable: true,
      workspaceId: valueString(row.workspaceId),
      spaceId: valueString(row.spaceId),
      displayName: String(row.fileName ?? ""),
      detectedContentType: String(row.detectedType ?? "application/octet-stream"),
      sizeBytes: safeNumber(row.sizeBytes),
      lifecycle,
    };
  }

  private session(principal: Principal): AuthoritySession {
    const session = this.#checkedSessions.get(principal);
    if (!session?.transport.connected) throw unauthorized("Principal attestation expired");
    const row = session.transport.rows("currentGatewayPrincipal");
    if (
      row.length !== 1 ||
      row[0]?.disabled !== false ||
      safeNumber(row[0]?.authzEpoch) !== principal.authzEpoch ||
      identityString(row[0]?.identity) !== principal.id
    )
      throw unauthorized("Principal authorization epoch is stale");
    this.touch(session);
    return session;
  }

  private workspaceGrant(
    session: AuthoritySession,
    workspaceId: string,
    authzEpoch: number,
  ): Row | undefined {
    return session.transport
      .rows("myGatewayWorkspaceGrants")
      .find(
        (row) =>
          valueString(row.workspaceId) === workspaceId &&
          safeNumber(row.userAuthzEpoch) === authzEpoch,
      );
  }

  private authorized(
    session: AuthoritySession,
    action: string,
    resource: ResourceRef,
    authzEpoch: number,
  ): boolean {
    const workspace = this.workspaceGrant(session, resource.workspaceId, authzEpoch);
    if (!workspace) return false;
    if (action === "database:connect" || action === "search:query")
      return workspace.canRead === true;
    if (action === "invitation:create") return workspace.canManageMembers === true;
    if (["agent:stream", "agent:invoke_tool", "agent:use_tool"].includes(action))
      return workspace.canRunAgents === true;
    if (action === "file:upload" && resource.kind === "space") {
      const space = session.transport
        .rows("myGatewaySpaceGrants")
        .find(
          (row) =>
            valueString(row.workspaceId) === resource.workspaceId &&
            valueString(row.spaceId) === resource.id &&
            safeNumber(row.membershipEpoch) === safeNumber(workspace.membershipEpoch),
        );
      return workspace.canWrite === true && space?.canWrite === true;
    }
    if (action === "file:download" && resource.kind === "file") {
      return session.transport
        .rows("myGatewayFileDescriptors")
        .some(
          (row) =>
            valueString(row.fileId) === resource.id &&
            valueString(row.workspaceId) === resource.workspaceId &&
            valueString(row.spaceId) === resource.spaceId,
        );
    }
    if (action === "search:read_result") {
      if (resource.kind === "file")
        return this.authorized(session, "file:download", resource, authzEpoch);
      if (resource.kind === "dm") {
        return session.transport
          .rows("visibleDirectParticipants")
          .some(
            (row) =>
              valueString(row.workspaceId) === resource.workspaceId &&
              valueString(row.conversationId) === resource.id &&
              (row.leftAt === undefined || row.leftAt === null),
          );
      }
      if (!resource.spaceId) return false;
      return session.transport
        .rows("myGatewaySpaceGrants")
        .some(
          (row) =>
            valueString(row.workspaceId) === resource.workspaceId &&
            valueString(row.spaceId) === resource.spaceId &&
            row.canRead === true,
        );
    }
    return false;
  }

  private pendingRow(session: AuthoritySession, id: string): PendingUpload | null {
    const row = session.transport
      .rows("myGatewayPendingUploads")
      .find((candidate) => valueString(candidate.uploadId) === id);
    if (!row) return null;
    return {
      id,
      objectKey: valueString(row.sourceKey),
      workspaceId: valueString(row.workspaceId),
      spaceId: valueString(row.spaceId),
      uploaderId: identityString(row.uploaderIdentity),
      displayName: String(row.fileName ?? ""),
      declaredContentType: String(row.declaredType ?? ""),
      expectedBytes: safeNumber(row.declaredSizeBytes),
      checksumSha256: String(row.checksumSha256 ?? ""),
      expiresAt: timestampIso(row.expiresAt),
      lifecycle: row.completed === true ? "quarantined" : "pending",
    };
  }

  private async reduceAndObserve(
    session: AuthoritySession,
    reducer: string,
    input: Readonly<Record<string, unknown>>,
    view: string,
    predicate: (row: Row) => boolean,
  ): Promise<void> {
    await this.bounded(session.transport.reduce(reducer, input));
    const deadline = Date.now() + this.options.commandTimeoutMs;
    while (!session.transport.rows(view).some(predicate)) {
      if (Date.now() >= deadline) throw unavailable("SpacetimeDB commit observation timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.touch(session);
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(unavailable("SpacetimeDB command timed out")),
            this.options.commandTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private touch(session: AuthoritySession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => session.transport.close(),
      this.options.idleTimeoutMs ?? 30_000,
    );
    session.idleTimer.unref?.();
  }
}
