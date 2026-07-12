import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { LogController } from "fastify";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import { authenticateRequest } from "./auth/request-auth.js";
import type { GatewayConfig } from "./config.js";
import type {
  GatewayDependencies,
  ObjectCapabilityUploadGrant,
  Principal,
  RateLimitResult,
  ReadinessProbe,
  ReadyDependency,
} from "./contracts.js";
import { forbidden, GatewayError, invalidInput, notFound, unavailable } from "./errors.js";
import type { WorkspaceBudget } from "./files/service.js";
import { FileCapabilityService } from "./files/service.js";
import { InvitationService } from "./invitations/service.js";
import { safeErrorFields } from "./observability.js";
import { PermissionSafeSearchService } from "./search/service.js";
import {
  enforceBrowserBoundary,
  equalSecret,
  isAllowedOrigin,
} from "./security/browser-boundary.js";
import { SessionAdministrationService } from "./sessions/service.js";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const workspaceInput = z.object({ workspaceId: id }).strict();
const createUploadInput = z
  .object({
    workspaceId: id,
    spaceId: id,
    displayName: z.string().min(1).max(255),
    declaredContentType: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[^\s/]+\/[^\s/]+$/),
    sizeBytes: z.number().int().positive(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();
const searchInput = z
  .object({
    workspaceId: id,
    query: z.string(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();
const agentInput = z.object({ workspaceId: id }).strict();
const toolInput = z.object({ workspaceId: id, arguments: z.unknown() }).strict();
const createInvitationInput = z
  .object({
    workspaceId: id,
    role: z.enum(["admin", "member", "guest"]),
    spaceIds: z.array(id).max(50).default([]),
    email: z.string().min(3).max(254).optional(),
    expiresInSeconds: z.number().int().min(300).max(2_592_000).default(604_800),
    useLimit: z.number().int().min(1).max(100).default(1),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw invalidInput("Request validation failed", {
      issues: result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join("."),
      })),
    });
  }
  return result.data;
}

function canonicalJson(value: unknown): string {
  const state = { nodes: 0 };
  return canonicalJsonValue(value, 0, state);
}

function canonicalJsonValue(value: unknown, depth: number, state: { nodes: number }): string {
  state.nodes += 1;
  if (depth > 64 || state.nodes > 10_000)
    throw invalidInput("Tool arguments exceed the structural complexity limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidInput("Tool arguments must be finite JSON values");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJsonValue(item, depth + 1, state)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    if (entries.some(([key]) => ["__proto__", "constructor", "prototype"].includes(key)))
      throw invalidInput("Tool arguments contain a prohibited object key");
    return `{${entries
      .map(
        ([key, nested]) => `${JSON.stringify(key)}:${canonicalJsonValue(nested, depth + 1, state)}`,
      )
      .join(",")}}`;
  }
  throw invalidInput("Tool arguments must be JSON values");
}

function singleHeader(value: string | readonly string[] | undefined, name: string): string {
  const selected = Array.isArray(value) ? value[0] : value;
  if (!selected) throw invalidInput(`Missing ${name} header`);
  return selected;
}

function requestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : randomUUID();
}

function dependencyProbe(name: string, dependency: ReadyDependency): ReadinessProbe {
  const label = dependency.adapterName.startsWith("disabled-surface:") ? `${name}:disabled` : name;
  return { name: label, check: (signal) => dependency.ready(signal) };
}

function dependencyProbes(deps: GatewayDependencies): ReadinessProbe[] {
  return [
    dependencyProbe("token-verifier", deps.tokenVerifier),
    dependencyProbe("session-verifier", deps.sessionVerifier),
    dependencyProbe("principal-resolver", deps.principalResolver),
    dependencyProbe("csrf", deps.csrf),
    dependencyProbe("authorization", deps.authorization),
    dependencyProbe("db-token-broker", deps.dbTokenBroker),
    dependencyProbe("file-metadata", deps.files),
    dependencyProbe("object-storage", deps.objects),
    ...(deps.objectCapabilities
      ? [dependencyProbe("object-capability-ingress", deps.objectCapabilities)]
      : []),
    dependencyProbe("search", deps.search),
    dependencyProbe("search-cursors", deps.searchCursors),
    dependencyProbe("rate-limits", deps.rateLimits),
    dependencyProbe("webhooks", deps.webhooks),
    dependencyProbe("webhook-receipts", deps.webhookReceipts),
    dependencyProbe("agent-streams", deps.agentStreams),
    dependencyProbe("agent-tools", deps.agentTools),
    dependencyProbe("invitation-tokens", deps.invitationTokens),
    dependencyProbe("invitations", deps.invitations),
    dependencyProbe("sessions", deps.sessions),
    ...(deps.readiness ?? []),
  ];
}

function assertProductionAdapters(config: GatewayConfig, deps: GatewayDependencies): void {
  if (config.nodeEnv !== "production") return;
  const adapters = [
    deps.tokenVerifier,
    deps.sessionVerifier,
    deps.principalResolver,
    deps.csrf,
    deps.authorization,
    deps.dbTokenBroker,
    deps.files,
    deps.objects,
    deps.objectCapabilities,
    deps.search,
    deps.searchCursors,
    deps.rateLimits,
    deps.webhooks,
    deps.webhookReceipts,
    deps.agentStreams,
    deps.agentTools,
    deps.invitationTokens,
    deps.invitations,
    deps.sessions,
  ];
  const invalid = adapters
    .filter((adapter) => adapter?.adapterKind !== "durable")
    .map((adapter) => adapter?.adapterName ?? "missing");
  for (const [adapter, methods] of [
    [deps.invitationTokens, ["ready", "hashForStorage", "verificationHashes", "verify"]],
    [deps.invitations, ["ready", "createAtomic", "redeemAtomic"]],
    [deps.sessions, ["ready", "listOwned", "revokeOwnedAtomic", "revokeOthersAtomic"]],
  ] as const) {
    if (!adapter) continue;
    for (const method of methods) {
      if (typeof (adapter as unknown as Readonly<Record<string, unknown>>)[method] !== "function") {
        invalid.push(`${adapter.adapterName}:missing_method:${method}`);
      }
    }
  }
  if (invalid.length > 0) {
    throw new Error(`Production requires durable gateway adapters: ${invalid.join(", ")}`);
  }
}

async function boundedProbe(
  probe: ReadinessProbe,
  timeoutMs: number,
): Promise<{ name: string; ready: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const ready = await Promise.race([
      probe.check(controller.signal).catch(() => false),
      new Promise<boolean>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(false), { once: true }),
      ),
    ]);
    return { name: probe.name, ready };
  } finally {
    clearTimeout(timer);
  }
}

function enforceRateLimit(result: RateLimitResult): void {
  if (!result.allowed) {
    throw new GatewayError(429, "rate_limited", "Request rate limit exceeded", {
      ...(result.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.retryAfterSeconds }),
    });
  }
}

export async function buildGateway(config: GatewayConfig, deps: GatewayDependencies) {
  assertProductionAdapters(config, deps);
  const app = Fastify({
    bodyLimit: 1_048_576,
    routerOptions: { maxParamLength: 8_192 },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => requestId(request.headers["x-request-id"]),
    logger: {
      level: config.logLevel,
      redact: {
        censor: "[REDACTED]",
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.idempotency-key",
          "req.headers.x-csrf-token",
          "req.headers.x-readiness-token",
          "req.headers.x-webhook-signature",
          "res.headers.set-cookie",
          "body",
          "token",
          "invitationToken",
          "invitation.token",
          "req.body.token",
          "req.params.token",
          "params.token",
          "capability.url",
        ],
      },
    },
    trustProxy: config.trustedProxyCidrs.length === 0 ? false : [...config.trustedProxyCidrs],
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-origin" },
  });
  await app.register(cors, {
    credentials: true,
    strictPreflight: true,
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "idempotency-key",
      "x-csrf-token",
      "x-request-id",
      "x-checksum-sha256",
      "if-none-match",
    ],
    exposedHeaders: ["x-request-id"],
    origin: (origin, callback) =>
      callback(null, origin === undefined || isAllowedOrigin(origin, config.allowedOrigins)),
  });
  await app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });

  app.addHook("onRequest", async (request) => {
    if (request.url !== "/health/live" && request.url !== "/health/ready") {
      enforceRateLimit(
        await deps.rateLimits.consumeIp({ ip: request.ip, scope: "gateway", cost: 1 }),
      );
    }
    await enforceBrowserBoundary(request, {
      allowedOrigins: config.allowedOrigins,
      sessionCookieName: config.sessionCookieName,
      csrfCookieName: config.csrfCookieName,
      csrfExempt: request.routeOptions.config.csrfExempt === true,
      csrf: deps.csrf,
    });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-request-id", request.id);
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({
      event: "request_complete",
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      statusCode: reply.statusCode,
      principalId: request.principal?.id,
      principalKind: request.principal?.kind,
      responseTimeMs: reply.elapsedTime,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GatewayError) {
      const retryAfter = error.details?.retryAfterSeconds;
      if (error.statusCode === 429 && typeof retryAfter === "number")
        reply.header("retry-after", Math.ceil(retryAfter));
      request.log.info({
        event: "request_rejected",
        requestId: request.id,
        code: error.code,
        statusCode: error.statusCode,
      });
      void reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message }, requestId: request.id });
      return;
    }
    const statusCandidate =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const statusCode =
      typeof statusCandidate === "number" && statusCandidate < 500 ? statusCandidate : 500;
    const code =
      statusCode === 429
        ? "rate_limited"
        : statusCode < 500
          ? "request_rejected"
          : "internal_error";
    request.log.error({
      event: "request_failed",
      requestId: request.id,
      code,
      statusCode,
      failure: safeErrorFields(error),
    });
    void reply.status(statusCode).send({
      error: { code, message: statusCode === 500 ? "Internal server error" : "Request rejected" },
      requestId: request.id,
    });
  });

  const authenticate = (request: Parameters<typeof authenticateRequest>[0]): Promise<Principal> =>
    authenticateRequest(
      request,
      deps.tokenVerifier,
      deps.sessionVerifier,
      deps.principalResolver,
      config.sessionCookieName,
    );
  const consumePrincipal = async (principal: Principal, scope: string, cost = 1) =>
    enforceRateLimit(
      await deps.rateLimits.consumePrincipal({ principalId: principal.id, scope, cost }),
    );
  const workspaceBudget: WorkspaceBudget = {
    consume: async (principal, workspaceId, scope, cost = 1) =>
      enforceRateLimit(
        await deps.rateLimits.consumeWorkspace({
          principalId: principal.id,
          workspaceId,
          scope,
          cost,
        }),
      ),
  };
  const files = new FileCapabilityService(
    deps.authorization,
    deps.files,
    deps.objects,
    workspaceBudget,
    config.files,
  );
  const search = new PermissionSafeSearchService(
    deps.authorization,
    deps.search,
    deps.searchCursors,
    workspaceBudget,
    config.search,
  );
  const invitations = new InvitationService(deps.invitationTokens, deps.invitations);
  const sessions = new SessionAdministrationService(
    deps.sessions,
    config.sessions.freshAuthMaxAgeSeconds,
  );
  const probes = dependencyProbes(deps);
  let readinessInFlight: Promise<{ name: string; ready: boolean }[]> | undefined;
  const checkReadiness = () => {
    readinessInFlight ??= Promise.all(
      probes.map((probe) => boundedProbe(probe, config.readiness.timeoutMs)),
    ).finally(() => {
      readinessInFlight = undefined;
    });
    return readinessInFlight;
  };

  app.get("/health/live", { config: { rateLimit: false } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { config: { rateLimit: false } }, async (request, reply) => {
    if (config.readiness.token) {
      const supplied = request.headers["x-readiness-token"];
      const token = Array.isArray(supplied) ? supplied[0] : supplied;
      if (!token || !equalSecret(token, config.readiness.token)) throw notFound();
    }
    const results = await checkReadiness();
    const ready = results.every((result) => result.ready);
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? "ready" : "not_ready", checks: results });
  });

  const objectCapabilities = deps.objectCapabilities;
  if (objectCapabilities) {
    await app.register(async (capabilityApp) => {
      capabilityApp.addContentTypeParser(
        "application/x-parrot-capability-stream",
        (_request, payload, done) => done(null, payload),
      );
      const uploadGrants = new WeakMap<object, ObjectCapabilityUploadGrant>();
      capabilityApp.route<{ Params: { token: string } }>({
        method: "PUT",
        url: "/v1/object-capabilities/upload/:token",
        config: { csrfExempt: true },
        preParsing: async (request, _reply, payload) => {
          const grant = await objectCapabilities.authorizeUpload({
            token: parse(
              z
                .string()
                .min(43)
                .max(8_192)
                .regex(/^[A-Za-z0-9_-]+$/),
              request.params.token,
            ),
            method: request.method,
            headers: request.headers,
          });
          uploadGrants.set(request, grant);
          // Select the streaming parser only after the signed content type has been checked.
          request.headers["content-type"] = "application/x-parrot-capability-stream";
          return payload;
        },
        handler: async (request, reply) => {
          const grant = uploadGrants.get(request);
          const body = request.body;
          if (
            !grant ||
            !body ||
            typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function"
          )
            throw invalidInput("A streaming upload body is required");
          const stored = await objectCapabilities.consumeUpload({
            grant,
            body: body as AsyncIterable<Uint8Array>,
          });
          return reply.status(201).send(stored);
        },
      });

      capabilityApp.get<{ Params: { token: string } }>(
        "/v1/object-capabilities/download/:token",
        { config: { csrfExempt: true } },
        async (request, reply) => {
          const grant = await objectCapabilities.authorizeDownload({
            token: parse(
              z
                .string()
                .min(43)
                .max(8_192)
                .regex(/^[A-Za-z0-9_-]+$/),
              request.params.token,
            ),
            method: request.method,
          });
          const object = await objectCapabilities.openDownload({ grant });
          reply.header("content-type", object.contentType);
          reply.header("content-length", String(object.sizeBytes));
          reply.header(
            "digest",
            `sha-256=${Buffer.from(object.checksumSha256, "hex").toString("base64")}`,
          );
          reply.header("etag", `"${object.objectVersion}"`);
          reply.header(
            "content-disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(object.displayName)}`,
          );
          return reply.send(Readable.from(object.body));
        },
      );
    });
  }

  app.post("/v1/db-token", async (request) => {
    const principal = await authenticate(request);
    await consumePrincipal(principal, "database-token");
    const body = parse(workspaceInput, request.body);
    if (
      !(await deps.authorization.authorize({
        principal,
        action: "database:connect",
        resource: { workspaceId: body.workspaceId, kind: "workspace", id: body.workspaceId },
      }))
    )
      throw forbidden();
    await workspaceBudget.consume(principal, body.workspaceId, "database-token");
    return deps.dbTokenBroker.mint({
      principal,
      workspaceId: body.workspaceId,
      audience: config.dbToken.audience,
      authzEpoch: principal.authzEpoch,
      ttlSeconds: config.dbToken.ttlSeconds,
    });
  });

  app.post("/v1/files/uploads", async (request, reply) => {
    const principal = await authenticate(request);
    await consumePrincipal(principal, "file-upload");
    const result = await files.createUpload(principal, parse(createUploadInput, request.body));
    return reply.status(201).send(result);
  });
  app.post<{ Params: { uploadId: string } }>(
    "/v1/files/uploads/:uploadId/complete",
    async (request) => {
      const principal = await authenticate(request);
      await consumePrincipal(principal, "file-complete");
      return files.completeUpload(principal, parse(id, request.params.uploadId));
    },
  );
  app.get<{ Params: { fileId: string } }>("/v1/files/:fileId/download", async (request) => {
    const principal = await authenticate(request);
    await consumePrincipal(principal, "file-download");
    return files.createDownload(principal, parse(id, request.params.fileId));
  });

  app.post("/v1/search", async (request) => {
    const principal = await authenticate(request);
    await consumePrincipal(principal, "search");
    const body = parse(searchInput, request.body);
    return search.query(principal, {
      workspaceId: body.workspaceId,
      query: body.query,
      limit: body.limit,
      ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
    });
  });

  app.post("/v1/invitations", async (request, reply) => {
    const principal = await authenticate(request);
    await consumePrincipal(principal, "invitation-create");
    const body = parse(createInvitationInput, request.body);
    if (
      !(await deps.authorization.authorize({
        principal,
        action: "invitation:create",
        resource: { workspaceId: body.workspaceId, kind: "workspace", id: body.workspaceId },
      }))
    )
      throw forbidden();
    await workspaceBudget.consume(principal, body.workspaceId, "invitation-create");
    const result = await invitations.create(
      principal,
      {
        workspaceId: body.workspaceId,
        role: body.role,
        spaceIds: body.spaceIds,
        ...(body.email === undefined ? {} : { email: body.email }),
        expiresInSeconds: body.expiresInSeconds,
        useLimit: body.useLimit,
      },
      request.id,
    );
    reply.header("referrer-policy", "no-referrer");
    return reply.status(201).send(result);
  });

  app.post("/v1/invitations/redeem", async (request, reply) => {
    const principal = await authenticate(request);
    await consumePrincipal(principal, "invitation-redeem");
    enforceRateLimit(
      await deps.rateLimits.consumeIp({ ip: request.ip, scope: "invitation-redeem", cost: 1 }),
    );
    const body = request.body;
    const token =
      typeof body === "object" && body !== null && !Array.isArray(body) && "token" in body
        ? (body as { token?: unknown }).token
        : undefined;
    const result = await invitations.redeem(
      principal,
      typeof token === "string" && token.length <= 512 ? token : "",
      request.id,
    );
    reply.header("referrer-policy", "no-referrer");
    return result;
  });

  app.get("/v1/sessions", async (request) => {
    const principal = await authenticate(request);
    await consumePrincipal(principal, "session-list");
    return sessions.list(principal);
  });

  app.delete<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId", async (request) => {
    const principal = await authenticate(request);
    await consumePrincipal(principal, "session-revoke");
    enforceRateLimit(
      await deps.rateLimits.consumeIp({ ip: request.ip, scope: "session-revoke", cost: 1 }),
    );
    return sessions.revoke(principal, request.params.sessionId, request.id);
  });

  app.post("/v1/sessions/revoke-others", async (request) => {
    const principal = await authenticate(request);
    await consumePrincipal(principal, "session-revoke-others");
    enforceRateLimit(
      await deps.rateLimits.consumeIp({
        ip: request.ip,
        scope: "session-revoke-others",
        cost: 1,
      }),
    );
    return sessions.revokeOthers(principal, request.id);
  });

  app.post<{ Params: { provider: string } }>(
    "/v1/webhooks/:provider",
    {
      config: { csrfExempt: true, rawBody: true },
    },
    async (request, reply) => {
      const provider = parse(id, request.params.provider);
      enforceRateLimit(
        await deps.rateLimits.consumeIp({
          ip: request.ip,
          scope: `webhook:${provider}`,
          cost: 1,
        }),
      );
      const resolved = await deps.webhooks.resolve(provider);
      if (!resolved?.endpoint.enabled) throw forbidden("Webhook authentication failed");
      const rawBodyValue = request.rawBody;
      if (!rawBodyValue) throw invalidInput("Raw webhook body is unavailable");
      const body = Buffer.isBuffer(rawBodyValue) ? rawBodyValue : Buffer.from(rawBodyValue);
      const receivedAt = new Date();
      const verified = await resolved.verifier.verify({
        headers: request.headers,
        body,
        receivedAt,
        maxSkewSeconds: config.webhookMaxSkewSeconds,
      });
      const status = await deps.webhookReceipts.enqueueOnce({
        endpoint: resolved.endpoint,
        eventId: verified.eventId,
        body,
        receivedAt,
      });
      return reply.status(202).send({ accepted: true, duplicate: status === "duplicate" });
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/v1/agent/runs/:runId/stream-ticket",
    async (request) => {
      const principal = await authenticate(request);
      await consumePrincipal(principal, "agent-stream");
      const runId = parse(id, request.params.runId);
      const body = parse(agentInput, request.body);
      if (
        !(await deps.authorization.authorize({
          principal,
          action: "agent:stream",
          resource: { workspaceId: body.workspaceId, kind: "agent_run", id: runId },
        }))
      )
        throw forbidden();
      await workspaceBudget.consume(principal, body.workspaceId, "agent-stream");
      const ticket = await deps.agentStreams.issue({
        principal,
        workspaceId: body.workspaceId,
        runId,
        audience: config.agentStream.audience,
        purpose: "agent-stream",
        authzEpoch: principal.authzEpoch,
        singleUse: true,
        ttlSeconds: config.agentStream.ttlSeconds,
      });
      const streamUrl = new URL(ticket.streamUrl);
      const expiresAt = Date.parse(ticket.expiresAt);
      const now = Date.now();
      if (
        typeof ticket.token !== "string" ||
        Buffer.byteLength(ticket.token, "utf8") < 16 ||
        Buffer.byteLength(ticket.token, "utf8") > 8_192 ||
        streamUrl.protocol !== "wss:" ||
        !config.agentStream.allowedOrigins.includes(streamUrl.origin) ||
        streamUrl.username ||
        streamUrl.password ||
        streamUrl.search ||
        streamUrl.hash ||
        streamUrl.pathname !== `/v1/agent/runs/${encodeURIComponent(runId)}/stream` ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now ||
        expiresAt > now + config.agentStream.ttlSeconds * 1_000 + 1_000
      ) {
        throw unavailable("Agent stream broker returned an invalid capability");
      }
      return ticket;
    },
  );

  app.post<{ Params: { runId: string; toolName: string } }>(
    "/v1/agent/runs/:runId/tools/:toolName",
    async (request, reply) => {
      const principal = await authenticate(request);
      await consumePrincipal(principal, "agent-tool");
      const runId = parse(id, request.params.runId);
      const toolName = parse(id, request.params.toolName);
      const body = parse(toolInput, request.body);
      const idempotencyKey = singleHeader(request.headers["idempotency-key"], "idempotency-key");
      if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey))
        throw invalidInput("Invalid idempotency key");
      const decisions = await Promise.all([
        deps.authorization.authorize({
          principal,
          action: "agent:invoke_tool",
          resource: { workspaceId: body.workspaceId, kind: "agent_run", id: runId },
        }),
        deps.authorization.authorize({
          principal,
          action: "agent:use_tool",
          resource: { workspaceId: body.workspaceId, kind: "tool", id: toolName },
        }),
      ]);
      if (!decisions.every(Boolean)) throw forbidden();
      await workspaceBudget.consume(principal, body.workspaceId, "agent-tool");
      const idempotencyScope = createHash("sha256")
        .update(
          [
            principal.id,
            String(principal.authzEpoch),
            body.workspaceId,
            runId,
            toolName,
            idempotencyKey,
          ].join("\0"),
        )
        .digest("base64url");
      const argumentsHash = createHash("sha256")
        .update(canonicalJson(body.arguments))
        .digest("base64url");
      const result = await deps.agentTools.invoke({
        principal,
        workspaceId: body.workspaceId,
        runId,
        toolName,
        authzEpoch: principal.authzEpoch,
        idempotencyScope,
        argumentsHash,
        arguments: body.arguments,
      });
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1_048_576)
        throw unavailable("Agent tool result exceeded the response limit");
      return reply.status(result.status === "accepted" ? 202 : 200).send(result);
    },
  );

  return app;
}
