import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { SearchRebuildSource } from "../adapters.js";
import {
  createFileProcessingHandler,
  createNotificationDeliveryHandler,
  createSearchIndexHandler,
} from "../adapters.js";
import { AgentRunLoop, AgentToolRegistry, createAgentRunJobHandler } from "../agent.js";
import { createReviewedAgentToolExecutionBoundary } from "../agent-tool-boundary.js";
import type { WorkerProductionPorts } from "../composition.js";
import type { WorkerConfig } from "../config.js";
import { HandlerRegistry } from "../outbox.js";
import { createParrotLocalProviders } from "../parrot-local-providers.js";
import { OpenTelemetry, StructuredLogger } from "../telemetry.js";
import {
  createWorkspaceExportCleanupHandler,
  createWorkspaceExportHandler,
} from "../workspace-export.js";
import {
  connectWorkosSpacetimeWorker,
  type WorkosSpacetimeConnectionOptions,
} from "./spacetime-connection.js";
import {
  type AuthenticatedSpacetimeWorkerTransport,
  SpacetimeAgentContextSource,
  SpacetimeAgentRunRepository,
  SpacetimeApprovalStore,
  SpacetimeAuthorizationGate,
  SpacetimeEffectLedger,
  SpacetimeFileAuthority,
  SpacetimeWorkerAuthority,
} from "./spacetime-worker.js";

const MAX_SECRET_BYTES = 16_384;
const TOKEN_REFRESH_SKEW_MS = 120_000;
const SAFE_CLIENT_ID = /^[A-Za-z0-9._:-]{8,256}$/;
const HEX_IDENTITY = /^[a-f0-9]{64}$/;

export class ParrotProductionBlockerError extends Error {
  constructor(readonly blockers: readonly string[]) {
    super(`parrot_production_blocked:${blockers.join(",")}`);
    this.name = "ParrotProductionBlockerError";
  }
}

export interface ParrotProductionEnvironment {
  readonly tokenEndpoint: URL;
  readonly clientId: string;
  readonly clientSecretFile: string;
  readonly issuer: string;
  readonly audience: string;
  readonly bearerSubject: string;
  readonly spacetimeUri: string;
  readonly spacetimeDatabase: string;
  readonly serviceIdentity: string;
}

const exactHttpsUrl = (value: string | undefined, field: string): URL => {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new ParrotProductionBlockerError([`${field}_invalid`]);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  ) {
    throw new ParrotProductionBlockerError([`${field}_invalid`]);
  }
  return url;
};

export const loadParrotProductionEnvironment = (
  env: NodeJS.ProcessEnv,
): ParrotProductionEnvironment => {
  const blockers: string[] = [];
  const clientId = env.WORKOS_M2M_CLIENT_ID?.trim() ?? "";
  const clientSecretFile = env.WORKOS_M2M_CLIENT_SECRET_FILE?.trim() ?? "";
  const issuer = env.WORKOS_M2M_ISSUER?.trim() ?? "";
  const audience = env.WORKOS_M2M_AUDIENCE?.trim() ?? "";
  const bearerSubject = env.WORKOS_M2M_EXPECTED_SUBJECT?.trim() ?? "";
  const spacetimeUri = env.SPACETIMEDB_WORKER_URI?.trim() ?? "";
  const spacetimeDatabase = env.SPACETIMEDB_DATABASE_NAME?.trim() ?? "";
  const serviceIdentity = env.SPACETIMEDB_WORKER_SERVICE_IDENTITY?.trim() ?? "";
  if (!SAFE_CLIENT_ID.test(clientId)) blockers.push("workos_m2m_client_id_invalid");
  if (!clientSecretFile.startsWith("/") || clientSecretFile.length > 1_024)
    blockers.push("workos_m2m_client_secret_file_invalid");
  if (!issuer.startsWith("https://") || issuer.length > 1_024)
    blockers.push("workos_m2m_issuer_invalid");
  if (!SAFE_CLIENT_ID.test(audience)) blockers.push("workos_m2m_audience_invalid");
  if (!SAFE_CLIENT_ID.test(bearerSubject)) blockers.push("workos_m2m_subject_invalid");
  if (!spacetimeUri.startsWith("ws://") && !spacetimeUri.startsWith("wss://"))
    blockers.push("spacetime_worker_uri_invalid");
  if (!SAFE_CLIENT_ID.test(spacetimeDatabase)) blockers.push("spacetime_database_invalid");
  if (!HEX_IDENTITY.test(serviceIdentity)) blockers.push("spacetime_service_identity_invalid");
  let tokenEndpoint: URL | undefined;
  try {
    tokenEndpoint = exactHttpsUrl(env.WORKOS_M2M_TOKEN_ENDPOINT, "workos_m2m_token_endpoint");
  } catch (error) {
    if (error instanceof ParrotProductionBlockerError) blockers.push(...error.blockers);
    else throw error;
  }
  if (blockers.length > 0 || !tokenEndpoint) throw new ParrotProductionBlockerError(blockers);
  return Object.freeze({
    tokenEndpoint,
    clientId,
    clientSecretFile,
    issuer,
    audience,
    bearerSubject,
    spacetimeUri,
    spacetimeDatabase,
    serviceIdentity,
  });
};

const readSecret = async (path: string): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SECRET_BYTES) {
      throw new Error("workos_m2m_client_secret_file_invalid");
    }
    const value = (await handle.readFile("utf8")).trim();
    if (value.length < 16 || value.length > MAX_SECRET_BYTES || /[\r\n\0]/.test(value)) {
      throw new Error("workos_m2m_client_secret_invalid");
    }
    return value;
  } finally {
    await handle.close();
  }
};

interface WorkosAccessToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

const jwtExpiration = (token: string): number => {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("workos_m2m_access_token_invalid");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("workos_m2m_access_token_invalid");
  }
  const exp = (value as { readonly exp?: unknown } | null)?.exp;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) {
    throw new Error("workos_m2m_access_token_invalid");
  }
  return exp * 1_000;
};

export const acquireWorkosM2mToken = async (
  environment: ParrotProductionEnvironment,
  fetchImplementation: typeof fetch = fetch,
): Promise<WorkosAccessToken> => {
  const secret = await readSecret(environment.clientSecretFile);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: environment.clientId,
    client_secret: secret,
  });
  const response = await fetchImplementation(environment.tokenEndpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`workos_m2m_token_request_failed:${response.status}`);
  if (Buffer.byteLength(text, "utf8") > MAX_SECRET_BYTES) {
    throw new Error("workos_m2m_token_response_too_large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("workos_m2m_token_response_invalid");
  }
  const accessToken = (parsed as { readonly access_token?: unknown } | null)?.access_token;
  if (typeof accessToken !== "string" || accessToken.length > MAX_SECRET_BYTES) {
    throw new Error("workos_m2m_token_response_invalid");
  }
  const expiresAt = jwtExpiration(accessToken);
  if (expiresAt <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    throw new Error("workos_m2m_token_lifetime_too_short");
  }
  return { accessToken, expiresAt };
};

class RefreshingWorkosSpacetimeTransport implements AuthenticatedSpacetimeWorkerTransport {
  readonly authentication = "workos_m2m_bearer" as const;
  readonly serviceIdentity: string;
  readonly bearerSubject: string;
  #current: AuthenticatedSpacetimeWorkerTransport | undefined;
  #expiresAt = 0;
  #refreshing: Promise<void> | undefined;
  #closed = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly environment: ParrotProductionEnvironment,
    private readonly fetchImplementation: typeof fetch,
  ) {
    this.serviceIdentity = environment.serviceIdentity;
    this.bearerSubject = environment.bearerSubject;
  }

  get connected(): boolean {
    return !this.#closed && this.#current?.connected === true && this.#expiresAt > Date.now();
  }

  get views(): ReadonlySet<string> {
    return this.#current?.views ?? new Set();
  }

  get reducers(): ReadonlySet<string> {
    return this.#current?.reducers ?? new Set();
  }

  async start(): Promise<this> {
    await this.#refresh();
    return this;
  }

  #schedule(delay: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => {
        void this.#refresh().catch(() => {
          if (!this.#closed) this.#schedule(10_000);
        });
      },
      Math.max(1_000, delay),
    );
    this.#timer.unref?.();
  }

  async #refresh(): Promise<void> {
    if (this.#closed) throw new Error("spacetime_worker_transport_closed");
    if (this.#refreshing) return this.#refreshing;
    const pending = (async () => {
      const token = await acquireWorkosM2mToken(this.environment, this.fetchImplementation);
      const options: WorkosSpacetimeConnectionOptions = {
        uri: this.environment.spacetimeUri,
        databaseName: this.environment.spacetimeDatabase,
        bearerToken: token.accessToken,
        expectedIssuer: this.environment.issuer,
        expectedAudience: this.environment.audience,
        expectedBearerSubject: this.environment.bearerSubject,
        expectedServiceIdentity: this.environment.serviceIdentity,
      };
      const next = await connectWorkosSpacetimeWorker(options);
      const previous = this.#current;
      this.#current = next;
      this.#expiresAt = token.expiresAt;
      if (previous) await previous.close(AbortSignal.timeout(5_000)).catch(() => undefined);
      const delay = Math.max(1_000, token.expiresAt - Date.now() - TOKEN_REFRESH_SKEW_MS);
      this.#schedule(delay);
    })().finally(() => {
      this.#refreshing = undefined;
    });
    this.#refreshing = pending;
    return pending;
  }

  async #active(): Promise<AuthenticatedSpacetimeWorkerTransport> {
    if (!this.#current?.connected || this.#expiresAt <= Date.now() + 30_000) await this.#refresh();
    if (!this.#current) throw new Error("spacetime_worker_transport_unavailable");
    return this.#current;
  }

  async select(...args: Parameters<AuthenticatedSpacetimeWorkerTransport["select"]>) {
    return (await this.#active()).select(...args);
  }

  async reduce(...args: Parameters<AuthenticatedSpacetimeWorkerTransport["reduce"]>) {
    return (await this.#active()).reduce(...args);
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.#closed) return false;
    try {
      return (await this.#active()).ready(signal);
    } catch {
      return false;
    }
  }

  async close(signal: AbortSignal): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#current) await this.#current.close(signal);
  }
}

const providerEnvironment = async (env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> => {
  const gmailClientSecretFile = env.GMAIL_CLIENT_SECRET_FILE?.trim();
  const gmailRefreshTokenFile = env.GMAIL_REFRESH_TOKEN_FILE?.trim();
  if (!gmailClientSecretFile && !gmailRefreshTokenFile) return env;
  if (!gmailClientSecretFile?.startsWith("/") || !gmailRefreshTokenFile?.startsWith("/")) {
    throw new ParrotProductionBlockerError(["gmail_mounted_secrets_missing"]);
  }
  const [clientSecret, refreshToken] = await Promise.all([
    readSecret(gmailClientSecretFile),
    readSecret(gmailRefreshTokenFile),
  ]);
  return {
    ...env,
    GMAIL_CLIENT_SECRET: clientSecret,
    GMAIL_REFRESH_TOKEN: refreshToken,
  };
};

class DisabledSearchRebuildSource implements SearchRebuildSource {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "search-rebuild-disabled-until-corpus-authority";
  assertProductionReady(): boolean {
    return true;
  }
  async ready(): Promise<boolean> {
    return true;
  }
  async *documents(): AsyncIterable<never> {
    yield* [];
    throw new ParrotProductionBlockerError(["search_rebuild_source_unavailable"]);
  }
}

const disabledToolGraph = () => {
  const boundary = createReviewedAgentToolExecutionBoundary({
    adapterKind: "durable",
    adapterName: "text-only-agent-tool-boundary",
    assertProductionReady: () => true,
    ready: async () => true,
    async normalize() {
      throw new ParrotProductionBlockerError(["agent_tools_disabled"]);
    },
    async execute() {
      return { type: "permanent_failure" as const, code: "agent_tools_disabled" };
    },
    async reconcile() {
      return { type: "not_found" as const };
    },
  });
  return { boundary, tools: new AgentToolRegistry(boundary) };
};

export const createWorkerPortsWithEnvironment = async (
  config: WorkerConfig,
  env: NodeJS.ProcessEnv,
  fetchImplementation: typeof fetch = fetch,
): Promise<WorkerProductionPorts> => {
  const environment = loadParrotProductionEnvironment(env);
  const transport = await new RefreshingWorkosSpacetimeTransport(
    environment,
    fetchImplementation,
  ).start();
  try {
    const authorization = new SpacetimeAuthorizationGate(transport);
    const filesAuthority = new SpacetimeFileAuthority(transport);
    const rebuildSource = new DisabledSearchRebuildSource();
    const toolGraph = disabledToolGraph();
    const local = createParrotLocalProviders(await providerEnvironment(env), {});
    const authority = new SpacetimeWorkerAuthority(transport, {
      expectedServiceIdentity: environment.serviceIdentity,
      expectedBearerSubject: environment.bearerSubject,
    });
    const effects = new SpacetimeEffectLedger(transport);
    const agentRuns = new SpacetimeAgentRunRepository(transport);
    const approvals = new SpacetimeApprovalStore(transport);
    const contextSource = new SpacetimeAgentContextSource(transport);
    const clock = { now: Date.now };
    const logger = new StructuredLogger(config.otelServiceName, config.logLevel, local.logSink);
    const telemetry = new OpenTelemetry(clock, local.spanExporter);
    const handlers = new HandlerRegistry();
    const notification = createNotificationDeliveryHandler(
      authorization,
      authority,
      local.notificationProvider,
    );
    const search = createSearchIndexHandler(local.search, rebuildSource);
    const files = createFileProcessingHandler(
      local.objects,
      local.scanner,
      local.extractor,
      filesAuthority,
    );
    const loop = new AgentRunLoop(
      {
        providerTimeoutMs: config.handlerTimeoutMs,
        toolTimeoutMs: config.handlerTimeoutMs,
        controlPollMs: config.checkpointMs,
        runLeaseMs: config.leaseMs,
        defaultMaxOutputBytes: config.maxContextBytes,
        defaultMaxToolResultBytes: Math.min(config.maxContextBytes, 262_144),
        defaultMaxTotalToolResultBytes: config.maxContextBytes,
        defaultMaxProviderInputBytes: config.maxContextBytes,
        defaultMaxTotalProviderInputBytes: config.maxContextBytes * 4,
      },
      clock,
      agentRuns,
      contextSource,
      local.agentProvider,
      toolGraph.tools,
      approvals,
      authorization,
      effects,
      logger,
      telemetry,
    );
    const agent = createAgentRunJobHandler(loop, agentRuns);
    const exportGenerate = createWorkspaceExportHandler(
      authority,
      local.workspaceExportMaterializer,
    );
    const exportCleanup = createWorkspaceExportCleanupHandler(
      authority,
      local.workspaceExportMaterializer,
    );
    handlers.register("notification.deliver", notification);
    for (const kind of ["search.upsert", "search.tombstone", "search.rebuild"] as const)
      handlers.register(kind, search);
    for (const kind of ["file.scan", "file.extract", "file.cleanup"] as const)
      handlers.register(kind, files);
    handlers.register("agent.run", agent);
    handlers.register("workspace.export.generate", exportGenerate);
    handlers.register("workspace.export.cleanup", exportCleanup);
    return {
      outbox: authority,
      effects,
      agentRuns,
      approvals,
      search: local.search,
      rebuildSource,
      files: filesAuthority,
      objects: local.objects,
      scanner: local.scanner,
      extractor: local.extractor,
      authorization,
      contextSource,
      notificationAuthority: authority,
      digestAuthority: authority,
      notificationProvider: local.notificationProvider,
      agentProvider: local.agentProvider,
      agentToolExecutionBoundary: toolGraph.boundary,
      workspaceExportAuthority: authority,
      workspaceExportMaterializer: local.workspaceExportMaterializer,
      logSink: local.logSink,
      logger,
      spanExporter: local.spanExporter,
      telemetry,
      handlers,
      tools: toolGraph.tools,
    };
  } catch (error) {
    await transport.close(AbortSignal.timeout(5_000)).catch(() => undefined);
    throw error;
  }
};

export const createWorkerPorts = (config: WorkerConfig): Promise<WorkerProductionPorts> =>
  createWorkerPortsWithEnvironment(config, process.env);
