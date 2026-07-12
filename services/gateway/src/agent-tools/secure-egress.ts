import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { Principal, ReadyDependency } from "../contracts.js";
import { forbidden, invalidInput, unavailable } from "../errors.js";

const DEFAULT_PORT = 443;
const MAX_URL_BYTES = 4_096;
const SAFE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SAFE_RESPONSE_HEADERS = new Set([
  "content-language",
  "content-type",
  "etag",
  "last-modified",
]);
const ALWAYS_FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);
const SECRET_ONLY_HEADERS = new Set(["authorization", "x-api-key"]);
const SENSITIVE_QUERY_NAME = /(auth|credential|key|password|secret|signature|token)/i;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface SecretReference {
  provider: string;
  secretId: string;
  version?: string;
}

export interface SecretHeaderBinding {
  reference: SecretReference;
  headerName: string;
  format: "raw" | "bearer";
}

export interface SecretBroker extends ReadyDependency {
  /**
   * Resolve one secret for one exact invocation, destination, and header use. The returned bytes
   * must be a fresh buffer: ownership transfers to the executor, which destroys it after the hop.
   */
  resolveForInvocation(input: {
    reference: SecretReference;
    principal: Principal;
    workspaceId: string;
    runId: string;
    toolName: string;
    invocationId: string;
    destinationOrigin: string;
    usage: { kind: "http-header"; headerName: string };
    /** The broker MUST stop provider work when this signal aborts. */
    signal: AbortSignal;
  }): Promise<{ value: Uint8Array; expiresAt: string }>;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface EgressHostResolver extends ReadyDependency {
  /** The resolver MUST honor signal and return every address considered for this lookup. */
  resolve(hostname: string, signal: AbortSignal): Promise<readonly ResolvedAddress[]>;
}

export interface PinnedHttpResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  remoteAddress: string;
}

export interface PinnedHttpTransport extends ReadyDependency {
  /**
   * The adapter MUST connect only to one of connect.allowedAddresses, MUST disable ambient proxy
   * settings, MUST use connect.tlsServerName for TLS verification, and MUST honor both signal and
   * maxResponseBytes while streaming. It must never resolve connect.hostname independently.
   */
  send(input: {
    url: string;
    method: string;
    headers: Readonly<Record<string, string>>;
    body?: Uint8Array;
    connect: {
      hostname: string;
      port: number;
      tlsServerName: string;
      allowedAddresses: readonly ResolvedAddress[];
    };
    maxResponseBytes: number;
    signal: AbortSignal;
  }): Promise<PinnedHttpResponse>;
}

export interface EgressDestinationRule {
  /** Exact normalized DNS hostname or public IP literal. Wildcards are intentionally unsupported. */
  hostname: string;
  ports?: readonly number[];
  allowedRequestHeaders?: readonly string[];
}

export interface SecureEgressLimits {
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxRedirects: number;
  maxSecretBindings: number;
  maxHeaderBytes: number;
}

export interface SecureEgressRequest {
  principal: Principal;
  workspaceId: string;
  runId: string;
  toolName: string;
  invocationId: string;
  url: string;
  method: string;
  headers?: Readonly<Record<string, string>>;
  secretHeaders?: readonly SecretHeaderBinding[];
  body?: Uint8Array;
}

export interface SecureEgressResponse {
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

interface NormalizedRule {
  hostname: string;
  ports: ReadonlySet<number>;
  allowedRequestHeaders: ReadonlySet<string>;
}

interface ValidatedDestination {
  url: URL;
  hostname: string;
  port: number;
  rule: NormalizedRule;
}

function denyDestination(): never {
  throw forbidden("Outbound destination is not permitted");
}

function normalizeHostname(input: string): string {
  const withoutDot = input.toLowerCase().replace(/\.$/, "");
  const ascii = domainToASCII(withoutDot);
  if (!ascii || ascii.length > 253) denyDestination();
  if (isIP(ascii) !== 0) return ascii;
  const labels = ascii.split(".");
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) denyDestination();
  if (
    ascii === "metadata.google.internal" ||
    ascii === "metadata.goog" ||
    ascii.endsWith(".localhost") ||
    ascii.endsWith(".local") ||
    ascii.endsWith(".internal") ||
    ascii.endsWith(".home.arpa")
  ) {
    denyDestination();
  }
  return ascii;
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map(Number);
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (
    (((bytes[0] ?? 0) << 24) >>> 0) +
    ((bytes[1] ?? 0) << 16) +
    ((bytes[2] ?? 0) << 8) +
    (bytes[3] ?? 0)
  );
}

function inIpv4Cidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (isIP(address) !== family) return false;
  if (family === 4) {
    const value = ipv4Number(address);
    return value !== null && !BLOCKED_V4.some(([base, prefix]) => inIpv4Cidr(value, base, prefix));
  }
  if (address.includes("%") || !/^[23]/.test(address)) return false;
  return !BLOCKED_V6.check(address, "ipv6");
}

const BLOCKED_V6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  BLOCKED_V6.addSubnet(address, prefix, "ipv6");
}

function parseDestination(raw: string, rules: readonly NormalizedRule[]): ValidatedDestination {
  if (Buffer.byteLength(raw, "utf8") > MAX_URL_BYTES) denyDestination();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    denyDestination();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) denyDestination();
  if ([...url.searchParams.keys()].some((name) => SENSITIVE_QUERY_NAME.test(name))) {
    denyDestination();
  }
  const hostname = normalizeHostname(url.hostname);
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) denyDestination();
  if (isIP(hostname) !== 0 && !isPublicAddress(hostname, isIP(hostname) as 4 | 6)) {
    denyDestination();
  }
  const rule = rules.find(
    (candidate) => candidate.hostname === hostname && candidate.ports.has(port),
  );
  if (!rule) denyDestination();
  url.hostname = hostname;
  return { url, hostname, port, rule };
}

function normalizeHeaderName(value: string): string {
  const name = value.toLowerCase();
  if (!HEADER_NAME.test(name)) throw invalidInput("Outbound request contains an invalid header");
  return name;
}

function isForbiddenHeader(name: string): boolean {
  return ALWAYS_FORBIDDEN_HEADERS.has(name) || name.startsWith("x-forwarded-");
}

function assertSafeHeaderValue(value: string): void {
  if (Buffer.byteLength(value, "utf8") > 8_192 || /[\0\r\n]/.test(value)) {
    throw invalidInput("Outbound request contains an invalid header");
  }
}

function checkedLimit(value: number, maximum: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) {
    throw new Error(`Invalid secure egress ${name}`);
  }
  return value;
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const iterator = body[Symbol.asyncIterator]();
  while (true) {
    const result = await raceWithSignal(iterator.next(), signal);
    if (result.done) break;
    const chunk = result.value;
    size += chunk.byteLength;
    if (size > maximumBytes) throw unavailable("Outbound response exceeded the size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function singleResponseHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  wanted: string,
): string | undefined {
  let found: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted || value === undefined) continue;
    if (found !== undefined || (typeof value !== "string" && value.length !== 1)) {
      throw unavailable("Outbound response contained an invalid header");
    }
    found = typeof value === "string" ? value : value[0];
  }
  return found;
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function raceWithSignal<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(unavailable("Outbound tool request timed out"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(unavailable("Outbound tool request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function validatedRedirectUrl(location: string, base: URL): string {
  if (Buffer.byteLength(location, "utf8") > MAX_URL_BYTES || /[\0\r\n]/.test(location)) {
    throw unavailable("Outbound redirect was not permitted");
  }
  try {
    return new URL(location, base).toString();
  } catch {
    throw unavailable("Outbound redirect was not permitted");
  }
}

export class SecureAgentToolEgress {
  private readonly rules: readonly NormalizedRule[];
  private readonly limits: SecureEgressLimits;

  constructor(
    rules: readonly EgressDestinationRule[],
    private readonly resolver: EgressHostResolver,
    private readonly secrets: SecretBroker,
    private readonly transport: PinnedHttpTransport,
    limits: SecureEgressLimits,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.limits = {
      timeoutMs: checkedLimit(limits.timeoutMs, 120_000, "timeout"),
      maxRequestBytes: checkedLimit(limits.maxRequestBytes, 10_000_000, "request size"),
      maxResponseBytes: checkedLimit(limits.maxResponseBytes, 10_000_000, "response size"),
      maxRedirects: checkedLimit(limits.maxRedirects, 5, "redirect count", true),
      maxSecretBindings: checkedLimit(limits.maxSecretBindings, 16, "secret count", true),
      maxHeaderBytes: checkedLimit(limits.maxHeaderBytes, 65_536, "header size"),
    };
    this.rules = rules.map((rule) => {
      const hostname = normalizeHostname(rule.hostname);
      if (isIP(hostname) !== 0 && !isPublicAddress(hostname, isIP(hostname) as 4 | 6)) {
        throw new Error("Secure egress rules may include only public destinations");
      }
      const ports = rule.ports ?? [DEFAULT_PORT];
      for (const port of ports) checkedLimit(port, 65_535, "destination port");
      const allowedRequestHeaders = new Set(
        (rule.allowedRequestHeaders ?? ["accept", "content-type", "idempotency-key"]).map((name) =>
          normalizeHeaderName(name),
        ),
      );
      for (const name of allowedRequestHeaders) {
        if (isForbiddenHeader(name) || SECRET_ONLY_HEADERS.has(name)) {
          throw new Error("Secure egress rule contains a prohibited request header");
        }
      }
      return { hostname, ports: new Set(ports), allowedRequestHeaders };
    });
  }

  async execute(
    input: SecureEgressRequest,
    parentSignal?: AbortSignal,
  ): Promise<SecureEgressResponse> {
    const method = input.method.toUpperCase();
    if (!SAFE_METHODS.has(method)) throw invalidInput("Outbound HTTP method is not permitted");
    if ((input.body?.byteLength ?? 0) > this.limits.maxRequestBytes) {
      throw invalidInput("Outbound request exceeded the size limit");
    }
    if ((input.secretHeaders?.length ?? 0) > this.limits.maxSecretBindings) {
      throw invalidInput("Outbound request has too many secret bindings");
    }
    const timeoutSignal = AbortSignal.timeout(this.limits.timeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
    let nextUrl = input.url;
    let currentMethod = method;
    let currentBody = input.body;

    for (let redirectCount = 0; ; redirectCount += 1) {
      if (signal.aborted) throw unavailable("Outbound tool request timed out");
      const destination = parseDestination(nextUrl, this.rules);
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = isIP(destination.hostname)
          ? [
              {
                address: destination.hostname,
                family: isIP(destination.hostname) as 4 | 6,
              },
            ]
          : await raceWithSignal(this.resolver.resolve(destination.hostname, signal), signal);
      } catch {
        if (signal.aborted) throw unavailable("Outbound tool request timed out");
        throw unavailable("Outbound destination resolution failed");
      }
      const uniqueAddresses = [
        ...new Map(addresses.map((entry) => [entry.address, entry])).values(),
      ];
      if (
        uniqueAddresses.length === 0 ||
        uniqueAddresses.length > 16 ||
        uniqueAddresses.some((entry) => !isPublicAddress(entry.address, entry.family))
      ) {
        denyDestination();
      }

      const headers: Record<string, string> = {};
      let headerBytes = 0;
      for (const [rawName, value] of Object.entries(input.headers ?? {})) {
        const name = normalizeHeaderName(rawName);
        assertSafeHeaderValue(value);
        if (
          isForbiddenHeader(name) ||
          SECRET_ONLY_HEADERS.has(name) ||
          !destination.rule.allowedRequestHeaders.has(name)
        ) {
          throw invalidInput("Outbound request contains a prohibited header");
        }
        headerBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
        headers[name] = value;
      }
      if (headerBytes > this.limits.maxHeaderBytes) {
        throw invalidInput("Outbound request headers exceeded the size limit");
      }

      const ownedSecrets: Uint8Array[] = [];
      try {
        for (const binding of input.secretHeaders ?? []) {
          const headerName = normalizeHeaderName(binding.headerName);
          if (isForbiddenHeader(headerName) || headers[headerName] !== undefined) {
            throw invalidInput("Outbound request contains a prohibited secret binding");
          }
          if (
            !/^[A-Za-z0-9._:/-]{1,255}$/.test(binding.reference.provider) ||
            !/^[A-Za-z0-9._:/-]{1,255}$/.test(binding.reference.secretId) ||
            (binding.reference.version !== undefined &&
              !/^[A-Za-z0-9._:/-]{1,255}$/.test(binding.reference.version))
          ) {
            throw invalidInput("Outbound request contains an invalid secret reference");
          }
          let material: Awaited<ReturnType<SecretBroker["resolveForInvocation"]>>;
          try {
            material = await raceWithSignal(
              this.secrets.resolveForInvocation({
                reference: binding.reference,
                principal: input.principal,
                workspaceId: input.workspaceId,
                runId: input.runId,
                toolName: input.toolName,
                invocationId: input.invocationId,
                destinationOrigin: destination.url.origin,
                usage: { kind: "http-header", headerName },
                signal,
              }),
              signal,
            );
          } catch {
            if (signal.aborted) throw unavailable("Outbound tool request timed out");
            throw unavailable("Outbound credential is unavailable");
          }
          ownedSecrets.push(material.value);
          const secretExpiry = Date.parse(material.expiresAt);
          if (!Number.isFinite(secretExpiry) || secretExpiry <= this.now().getTime()) {
            throw unavailable("Outbound credential is unavailable");
          }
          if (material.value.byteLength === 0 || material.value.byteLength > 8_192) {
            throw unavailable("Outbound credential is unavailable");
          }
          const value = Buffer.from(material.value).toString("utf8");
          assertSafeHeaderValue(value);
          const formatted = binding.format === "bearer" ? `Bearer ${value}` : value;
          headerBytes +=
            Buffer.byteLength(headerName, "utf8") + Buffer.byteLength(formatted, "utf8");
          if (headerBytes > this.limits.maxHeaderBytes) {
            throw invalidInput("Outbound request headers exceeded the size limit");
          }
          headers[headerName] = formatted;
        }

        let response: PinnedHttpResponse;
        try {
          response = await raceWithSignal(
            this.transport.send({
              url: destination.url.toString(),
              method: currentMethod,
              headers,
              ...(currentBody === undefined ? {} : { body: currentBody }),
              connect: {
                hostname: destination.hostname,
                port: destination.port,
                tlsServerName: destination.hostname,
                allowedAddresses: uniqueAddresses,
              },
              maxResponseBytes: this.limits.maxResponseBytes,
              signal,
            }),
            signal,
          );
        } catch {
          if (signal.aborted) throw unavailable("Outbound tool request timed out");
          throw unavailable("Outbound tool request failed");
        }
        if (
          !Number.isInteger(response.statusCode) ||
          response.statusCode < 100 ||
          response.statusCode > 599
        ) {
          throw unavailable("Outbound transport returned an invalid response");
        }
        if (!uniqueAddresses.some((entry) => entry.address === response.remoteAddress)) {
          throw unavailable("Outbound transport violated the pinned-address contract");
        }
        if (isRedirect(response.statusCode)) {
          await readBoundedBody(response.body, this.limits.maxResponseBytes, signal);
          const location = singleResponseHeader(response.headers, "location");
          if (!location || redirectCount >= this.limits.maxRedirects) {
            throw unavailable("Outbound redirect was not permitted");
          }
          nextUrl = validatedRedirectUrl(location, destination.url);
          if (response.statusCode === 303) {
            currentMethod = "GET";
            currentBody = undefined;
          }
          continue;
        }
        const responseHeaders: Record<string, string> = {};
        for (const name of SAFE_RESPONSE_HEADERS) {
          const value = singleResponseHeader(response.headers, name);
          if (value !== undefined) {
            if (Buffer.byteLength(value, "utf8") > 8_192 || /[\0\r\n]/.test(value)) {
              throw unavailable("Outbound response contained an invalid header");
            }
            responseHeaders[name] = value;
          }
        }
        return {
          statusCode: response.statusCode,
          headers: responseHeaders,
          body: await readBoundedBody(response.body, this.limits.maxResponseBytes, signal),
        };
      } finally {
        for (const value of ownedSecrets) value.fill(0);
        for (const binding of input.secretHeaders ?? []) {
          delete headers[binding.headerName.toLowerCase()];
        }
      }
    }
  }
}
