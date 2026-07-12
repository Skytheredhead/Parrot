import type {
  AgentStreamTicket,
  AgentToolResult,
  CreateInvitationInput,
  CreateUploadInput,
  CreatedInvitation,
  DatabaseToken,
  FileDownload,
  GatewayErrorBody,
  PendingUpload,
  QuarantinedUpload,
  RedeemedInvitation,
  RequestOptions,
  SearchInput,
  SearchResult,
  SessionList,
  SessionRevocation,
} from "./types.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

export type CredentialProvider = () => string | undefined | Promise<string | undefined>;

export interface ClientOptions {
  baseUrl: string;
  accessToken?: CredentialProvider;
  csrfToken?: CredentialProvider;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
}

export class GatewayClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = "GatewayClientError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

function normalizedBaseUrl(value: string): URL {
  const url = new URL(value);
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "Gateway baseUrl must be HTTPS (or loopback HTTP) without credentials, query, or fragment",
    );
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

function pathSegment(value: string, name: string): string {
  if (!SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return encodeURIComponent(value);
}

function responseRequestId(response: Response): string | undefined {
  const value = response.headers.get("x-request-id") ?? undefined;
  return value && SAFE_ID.test(value) ? value : undefined;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function isErrorBody(value: unknown): value is GatewayErrorBody {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GatewayErrorBody>;
  return (
    typeof candidate.requestId === "string" &&
    Boolean(candidate.error) &&
    typeof candidate.error?.code === "string" &&
    typeof candidate.error?.message === "string"
  );
}

export class ProjectConversationClient {
  private readonly baseUrl: URL;
  private readonly accessToken: CredentialProvider | undefined;
  private readonly csrfToken: CredentialProvider | undefined;
  private readonly fetcher: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(options: ClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.accessToken = options.accessToken;
    this.csrfToken = options.csrfToken;
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== "function")
      throw new TypeError("A fetch implementation is required");
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1 ||
      this.maxResponseBytes > 8_388_608
    ) {
      throw new TypeError("maxResponseBytes must be between 1 and 8388608");
    }
  }

  databaseToken(workspaceId: string, options?: RequestOptions): Promise<DatabaseToken> {
    return this.post("v1/db-token", { workspaceId }, options);
  }

  createUpload(input: CreateUploadInput, options?: RequestOptions): Promise<PendingUpload> {
    return this.post("v1/files/uploads", input, options);
  }

  completeUpload(uploadId: string, options?: RequestOptions): Promise<QuarantinedUpload> {
    return this.post(
      `v1/files/uploads/${pathSegment(uploadId, "uploadId")}/complete`,
      undefined,
      options,
    );
  }

  fileDownload(fileId: string, options?: RequestOptions): Promise<FileDownload> {
    return this.request(
      "GET",
      `v1/files/${pathSegment(fileId, "fileId")}/download`,
      undefined,
      options,
    );
  }

  search(input: SearchInput, options?: RequestOptions): Promise<SearchResult> {
    return this.post("v1/search", input, options);
  }

  createInvitation(
    input: CreateInvitationInput,
    options?: RequestOptions,
  ): Promise<CreatedInvitation> {
    return this.post("v1/invitations", input, options);
  }

  redeemInvitation(token: string, options?: RequestOptions): Promise<RedeemedInvitation> {
    if (token.length === 0 || token.length > 512 || /[\r\n]/.test(token)) {
      throw new TypeError("Invitation token is invalid");
    }
    return this.post("v1/invitations/redeem", { token }, options);
  }

  listSessions(options?: RequestOptions): Promise<SessionList> {
    return this.request("GET", "v1/sessions", undefined, options);
  }

  revokeSession(sessionId: string, options?: RequestOptions): Promise<SessionRevocation> {
    return this.request(
      "DELETE",
      `v1/sessions/${pathSegment(sessionId, "sessionId")}`,
      undefined,
      options,
    );
  }

  revokeOtherSessions(options?: RequestOptions): Promise<SessionRevocation> {
    return this.post("v1/sessions/revoke-others", undefined, options);
  }

  agentStreamTicket(
    workspaceId: string,
    runId: string,
    options?: RequestOptions,
  ): Promise<AgentStreamTicket> {
    return this.post(
      `v1/agent/runs/${pathSegment(runId, "runId")}/stream-ticket`,
      { workspaceId },
      options,
    );
  }

  invokeAgentTool(
    input: {
      workspaceId: string;
      runId: string;
      toolName: string;
      idempotencyKey: string;
      arguments: unknown;
    },
    options?: RequestOptions,
  ): Promise<AgentToolResult> {
    if (!SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new TypeError("idempotencyKey is invalid");
    }
    return this.post(
      `v1/agent/runs/${pathSegment(input.runId, "runId")}/tools/${pathSegment(input.toolName, "toolName")}`,
      { workspaceId: input.workspaceId, arguments: input.arguments },
      options,
      { "idempotency-key": input.idempotencyKey },
    );
  }

  private post<T>(
    path: string,
    body: unknown,
    options?: RequestOptions,
    headers?: Readonly<Record<string, string>>,
  ): Promise<T> {
    return this.request("POST", path, body, options, headers);
  }

  private async request<T>(
    method: "DELETE" | "GET" | "POST",
    path: string,
    body: unknown,
    options?: RequestOptions,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    const headers = new Headers(extraHeaders);
    headers.set("accept", "application/json");
    if (body !== undefined) headers.set("content-type", "application/json");
    const accessToken = await this.accessToken?.();
    if (accessToken) {
      if (/[\r\n]/.test(accessToken) || accessToken.length > 8_192)
        throw new TypeError("Access token is invalid");
      headers.set("authorization", `Bearer ${accessToken}`);
    } else if (method !== "GET") {
      const csrfToken = await this.csrfToken?.();
      if (csrfToken) {
        if (/[\r\n]/.test(csrfToken) || csrfToken.length > 512)
          throw new TypeError("CSRF token is invalid");
        headers.set("x-csrf-token", csrfToken);
      }
    }
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method,
      headers,
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    const contentLength = Number(response.headers.get("content-length"));
    const headerRequestId = responseRequestId(response);
    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      throw new GatewayClientError({
        status: response.status,
        code: "response_too_large",
        message: "Gateway response exceeded the configured byte limit",
        ...(headerRequestId === undefined ? {} : { requestId: headerRequestId }),
      });
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > this.maxResponseBytes) {
      throw new GatewayClientError({
        status: response.status,
        code: "response_too_large",
        message: "Gateway response exceeded the configured byte limit",
        ...(headerRequestId === undefined ? {} : { requestId: headerRequestId }),
      });
    }
    if (text.length > 0 && contentType !== "application/json") {
      throw new GatewayClientError({
        status: response.status,
        code: "invalid_gateway_response",
        message: "Gateway returned an unexpected content type",
        ...(headerRequestId === undefined ? {} : { requestId: headerRequestId }),
      });
    }
    let decoded: unknown;
    try {
      decoded = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      throw new GatewayClientError({
        status: response.status,
        code: "invalid_gateway_response",
        message: "Gateway returned invalid JSON",
        ...(headerRequestId === undefined ? {} : { requestId: headerRequestId }),
      });
    }
    if (!response.ok) {
      const bodyRequestId =
        isErrorBody(decoded) && SAFE_ID.test(decoded.requestId) ? decoded.requestId : undefined;
      const requestId = headerRequestId ?? bodyRequestId;
      const retryAfter = retryAfterSeconds(response);
      throw new GatewayClientError({
        status: response.status,
        code: isErrorBody(decoded) ? decoded.error.code : "gateway_request_failed",
        message: isErrorBody(decoded) ? decoded.error.message : "Gateway request failed",
        ...(requestId === undefined ? {} : { requestId }),
        ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      });
    }
    return decoded as T;
  }
}
