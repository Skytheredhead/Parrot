import { describe, expect, it } from "vitest";
import {
  type EgressDestinationRule,
  type EgressHostResolver,
  type PinnedHttpResponse,
  type PinnedHttpTransport,
  type SecretBroker,
  SecureAgentToolEgress,
  type SecureEgressRequest,
} from "../src/agent-tools/secure-egress.js";
import type { Principal } from "../src/contracts.js";

const principal: Principal = {
  id: "agent-1",
  issuer: "https://issuer.test",
  subject: "agent-1",
  kind: "agent",
  authzEpoch: 4,
};

const baseRequest: SecureEgressRequest = {
  principal,
  workspaceId: "workspace-1",
  runId: "run-1",
  toolName: "vendor.lookup",
  invocationId: "invocation-1",
  url: "https://api.vendor.test/v1/lookup",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: Buffer.from("{}"),
};

const limits = {
  timeoutMs: 1_000,
  maxRequestBytes: 1_024,
  maxResponseBytes: 32,
  maxRedirects: 2,
  maxSecretBindings: 2,
  maxHeaderBytes: 1_024,
};

abstract class ReadyFake {
  readonly adapterKind = "test" as const;
  readonly adapterName = "secure-egress-test";

  async ready(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted;
  }
}

class ResolverFake extends ReadyFake implements EgressHostResolver {
  readonly calls: string[] = [];
  readonly answers = new Map<string, Array<{ address: string; family: 4 | 6 }>>([
    ["api.vendor.test", [{ address: "8.8.8.8", family: 4 }]],
    ["redirect.vendor.test", [{ address: "1.1.1.1", family: 4 }]],
  ]);

  async resolve(hostname: string): Promise<readonly { address: string; family: 4 | 6 }[]> {
    this.calls.push(hostname);
    return this.answers.get(hostname) ?? [];
  }
}

class SecretBrokerFake extends ReadyFake implements SecretBroker {
  readonly calls: Parameters<SecretBroker["resolveForInvocation"]>[0][] = [];
  readonly issued: Uint8Array[] = [];
  expiresAt = "2030-01-01T00:00:00.000Z";
  error?: Error;
  hang = false;

  async resolveForInvocation(input: Parameters<SecretBroker["resolveForInvocation"]>[0]) {
    this.calls.push(input);
    if (this.error) throw this.error;
    if (this.hang) {
      await new Promise<never>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
    }
    const value = Buffer.from("super-secret");
    this.issued.push(value);
    return { value, expiresAt: this.expiresAt };
  }
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

class TransportFake extends ReadyFake implements PinnedHttpTransport {
  readonly calls: Array<{
    url: string;
    method: string;
    headers: Readonly<Record<string, string>>;
    connect: Parameters<PinnedHttpTransport["send"]>[0]["connect"];
    maxResponseBytes: number;
  }> = [];
  readonly responses: PinnedHttpResponse[] = [];
  error?: Error;

  async send(input: Parameters<PinnedHttpTransport["send"]>[0]): Promise<PinnedHttpResponse> {
    this.calls.push({
      url: input.url,
      method: input.method,
      headers: { ...input.headers },
      connect: input.connect,
      maxResponseBytes: input.maxResponseBytes,
    });
    if (this.error) throw this.error;
    const response = this.responses.shift();
    if (!response) {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "set-cookie": "private=true" },
        body: chunks('{"ok":true}'),
        remoteAddress: input.connect.allowedAddresses[0]?.address ?? "",
      };
    }
    return response;
  }
}

function fixture(
  rules: readonly EgressDestinationRule[] = [{ hostname: "api.vendor.test" }],
  limitOverrides: Partial<typeof limits> = {},
) {
  const resolver = new ResolverFake();
  const secrets = new SecretBrokerFake();
  const transport = new TransportFake();
  const egress = new SecureAgentToolEgress(
    rules,
    resolver,
    secrets,
    transport,
    { ...limits, ...limitOverrides },
    () => new Date("2026-07-12T12:00:00.000Z"),
  );
  return { egress, resolver, secrets, transport };
}

describe("secure agent tool egress", () => {
  it("denies unknown destinations before DNS, credential resolution, or transport", async () => {
    const { egress, resolver, secrets, transport } = fixture([]);
    await expect(egress.execute(baseRequest)).rejects.toMatchObject({
      statusCode: 403,
      message: "Outbound destination is not permitted",
    });
    expect(resolver.calls).toEqual([]);
    expect(secrets.calls).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  it("blocks metadata, private, special, and excessive DNS answers", async () => {
    const { egress, resolver, secrets, transport } = fixture();
    for (const addresses of [
      [{ address: "169.254.169.254", family: 4 as const }],
      [{ address: "10.0.0.1", family: 4 as const }],
      [{ address: "0:0:0:0:0:0:0:1", family: 6 as const }],
      [{ address: "::ffff:8.8.8.8", family: 6 as const }],
      [{ address: "2001:db8::1", family: 6 as const }],
      [{ address: "2002:0808:0808::1", family: 6 as const }],
      Array.from({ length: 17 }, (_, index) => ({
        address: `8.8.8.${index + 1}`,
        family: 4 as const,
      })),
    ]) {
      resolver.answers.set("api.vendor.test", addresses);
      await expect(egress.execute(baseRequest)).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(secrets.calls).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  it("pins public DNS answers and resolves secret references with exact least-privilege scope", async () => {
    const { egress, resolver, secrets, transport } = fixture();
    const response = await egress.execute({
      ...baseRequest,
      secretHeaders: [
        {
          reference: { provider: "vault", secretId: "vendor/api", version: "7" },
          headerName: "authorization",
          format: "bearer",
        },
      ],
    });
    expect(Buffer.from(response.body).toString("utf8")).toBe('{"ok":true}');
    expect(response.headers).toEqual({ "content-type": "application/json" });
    expect(resolver.calls).toEqual(["api.vendor.test"]);
    expect(secrets.calls).toEqual([
      expect.objectContaining({
        reference: { provider: "vault", secretId: "vendor/api", version: "7" },
        principal,
        workspaceId: "workspace-1",
        runId: "run-1",
        toolName: "vendor.lookup",
        invocationId: "invocation-1",
        destinationOrigin: "https://api.vendor.test",
        usage: { kind: "http-header", headerName: "authorization" },
      }),
    ]);
    expect(transport.calls[0]).toMatchObject({
      headers: { authorization: "Bearer super-secret" },
      connect: {
        hostname: "api.vendor.test",
        port: 443,
        tlsServerName: "api.vendor.test",
        allowedAddresses: [{ address: "8.8.8.8", family: 4 }],
      },
      maxResponseBytes: 32,
    });
    expect([...((secrets.issued[0] as Uint8Array) ?? [])]).toEqual(Array(12).fill(0));
  });

  it("revalidates DNS and secret authorization for every redirect", async () => {
    const { egress, resolver, secrets, transport } = fixture([
      { hostname: "api.vendor.test" },
      { hostname: "redirect.vendor.test" },
    ]);
    transport.responses.push(
      {
        statusCode: 302,
        headers: { location: "https://redirect.vendor.test/final" },
        body: chunks(),
        remoteAddress: "8.8.8.8",
      },
      {
        statusCode: 200,
        headers: {},
        body: chunks("done"),
        remoteAddress: "1.1.1.1",
      },
    );
    await egress.execute({
      ...baseRequest,
      secretHeaders: [
        {
          reference: { provider: "vault", secretId: "vendor/api" },
          headerName: "x-api-key",
          format: "raw",
        },
      ],
    });
    expect(resolver.calls).toEqual(["api.vendor.test", "redirect.vendor.test"]);
    expect(secrets.calls.map((call) => call.destinationOrigin)).toEqual([
      "https://api.vendor.test",
      "https://redirect.vendor.test",
    ]);
    expect(transport.calls[1]?.connect.allowedAddresses).toEqual([
      { address: "1.1.1.1", family: 4 },
    ]);
  });

  it("rejects redirect pivots and transport connections outside the pinned set", async () => {
    const deniedRedirect = fixture();
    deniedRedirect.transport.responses.push({
      statusCode: 302,
      headers: { location: "https://169.254.169.254/latest/meta-data" },
      body: chunks(),
      remoteAddress: "8.8.8.8",
    });
    await expect(deniedRedirect.egress.execute(baseRequest)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(deniedRedirect.transport.calls).toHaveLength(1);

    const rebound = fixture();
    rebound.transport.responses.push({
      statusCode: 200,
      headers: {},
      body: chunks("never returned"),
      remoteAddress: "1.1.1.1",
    });
    await expect(rebound.egress.execute(baseRequest)).rejects.toMatchObject({
      statusCode: 503,
      message: "Outbound transport violated the pinned-address contract",
    });
  });

  it("enforces header, response, expiry, and sanitized failure boundaries", async () => {
    const rawHeader = fixture();
    await expect(
      rawHeader.egress.execute({
        ...baseRequest,
        headers: { authorization: "Bearer raw-secret" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      rawHeader.egress.execute({
        ...baseRequest,
        headers: { accept: "a".repeat(1_100) },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Outbound request headers exceeded the size limit",
    });

    expect(() =>
      fixture([{ hostname: "api.vendor.test", allowedRequestHeaders: ["x-forwarded-host"] }]),
    ).toThrow(/prohibited request header/);
    await expect(
      rawHeader.egress.execute({
        ...baseRequest,
        headers: { "x-forwarded-host": "metadata.internal" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const badExpiry = fixture();
    badExpiry.secrets.expiresAt = "not-a-date";
    await expect(
      badExpiry.egress.execute({
        ...baseRequest,
        secretHeaders: [
          {
            reference: { provider: "vault", secretId: "vendor/api" },
            headerName: "authorization",
            format: "bearer",
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 503, message: "Outbound credential is unavailable" });

    const oversized = fixture();
    oversized.transport.responses.push({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: chunks("a".repeat(20), "b".repeat(20)),
      remoteAddress: "8.8.8.8",
    });
    await expect(oversized.egress.execute(baseRequest)).rejects.toMatchObject({
      statusCode: 503,
      message: "Outbound response exceeded the size limit",
    });

    const invalidResponseHeader = fixture();
    invalidResponseHeader.transport.responses.push({
      statusCode: 200,
      headers: { "content-type": "text/plain\r\nx-leak: secret" },
      body: chunks("ok"),
      remoteAddress: "8.8.8.8",
    });
    await expect(invalidResponseHeader.egress.execute(baseRequest)).rejects.toMatchObject({
      statusCode: 503,
      message: "Outbound response contained an invalid header",
    });

    const ambiguousRedirect = fixture();
    ambiguousRedirect.transport.responses.push({
      statusCode: 302,
      headers: { location: ["https://api.vendor.test/a", "https://api.vendor.test/b"] },
      body: chunks(),
      remoteAddress: "8.8.8.8",
    });
    await expect(ambiguousRedirect.egress.execute(baseRequest)).rejects.toMatchObject({
      statusCode: 503,
      message: "Outbound response contained an invalid header",
    });

    const timedOut = fixture([{ hostname: "api.vendor.test" }], { timeoutMs: 10 });
    timedOut.secrets.hang = true;
    await expect(
      timedOut.egress.execute({
        ...baseRequest,
        secretHeaders: [
          {
            reference: { provider: "vault", secretId: "vendor/api" },
            headerName: "authorization",
            format: "bearer",
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 503, message: "Outbound tool request timed out" });

    const transportFailure = fixture();
    transportFailure.transport.error = new Error("transport leaked super-secret");
    const transportError = await transportFailure.egress
      .execute(baseRequest)
      .catch((error: unknown) => error);
    expect(JSON.stringify(transportError)).not.toContain("super-secret");
    expect(transportError).toMatchObject({
      statusCode: 503,
      message: "Outbound tool request failed",
    });

    const leakedProviderFailure = fixture();
    leakedProviderFailure.secrets.error = new Error("vault leaked super-secret");
    const failure = await leakedProviderFailure.egress
      .execute({
        ...baseRequest,
        secretHeaders: [
          {
            reference: { provider: "vault", secretId: "vendor/api" },
            headerName: "authorization",
            format: "bearer",
          },
        ],
      })
      .catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain("super-secret");
    expect(failure).toMatchObject({
      statusCode: 503,
      message: "Outbound credential is unavailable",
    });
  });
});
