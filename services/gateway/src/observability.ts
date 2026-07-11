import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { GatewayConfig } from "./config.js";

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

export function safeErrorFields(
  error: unknown,
): Readonly<Record<string, string | number | boolean>> {
  if (typeof error !== "object" || error === null) return { name: "UnknownError" };
  const name =
    "name" in error && typeof error.name === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(error.name)
      ? error.name
      : "Error";
  const result: Record<string, string | number | boolean> = { name };
  if ("code" in error && (typeof error.code === "string" || typeof error.code === "number")) {
    const code = String(error.code);
    if (/^[A-Za-z0-9_.-]{1,80}$/.test(code)) result.code = code;
  }
  if ("retryable" in error && typeof error.retryable === "boolean")
    result.retryable = error.retryable;
  return result;
}

export async function startTelemetry(config: GatewayConfig["telemetry"]): Promise<TelemetryHandle> {
  if (!config.enabled || !config.endpoint) return { shutdown: async () => undefined };
  if (process.env.OTEL_DIAGNOSTIC_LOGGING === "true") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": config.serviceName,
      "deployment.environment.name": process.env.NODE_ENV ?? "development",
    }),
    traceExporter: new OTLPTraceExporter({ url: config.endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-http": {
          headersToSpanAttributes: {
            client: { requestHeaders: [], responseHeaders: [] },
            server: { requestHeaders: [], responseHeaders: [] },
          },
          redactedQueryParams: [
            "access_token",
            "authorization",
            "code",
            "key",
            "sig",
            "signature",
            "token",
            "X-Amz-Credential",
            "X-Amz-Security-Token",
            "X-Amz-Signature",
            "X-Goog-Credential",
            "X-Goog-Signature",
          ],
        },
      }),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
