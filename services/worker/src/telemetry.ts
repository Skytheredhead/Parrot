import { randomBytes } from "node:crypto";
import type { Clock, JsonValue } from "./domain.js";
import type { RuntimeAdapter } from "./outbox.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly event: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly workspaceId?: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly outcome?: string;
  readonly attributes?: Readonly<Record<string, JsonValue>>;
}

export interface LogSink extends RuntimeAdapter {
  write(record: LogRecord): void | Promise<void>;
}

export class JsonConsoleSink implements LogSink {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "json-console-log-sink";

  assertProductionReady(): boolean {
    return typeof process.stdout.write === "function";
  }

  async ready(): Promise<boolean> {
    return typeof process.stdout.write === "function";
  }

  write(record: LogRecord): void {
    try {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Observability must not change business outcomes.
    }
  }
}

const ranks: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

const allowedAttributeKeys = new Set([
  "kind",
  "generation",
  "attempt",
  "outputTokens",
  "toolCalls",
  "costMicros",
  "code",
  "count",
  "durationMs",
]);

const allowedSpanAttributeKeys = new Set([
  "job.id",
  "job.kind",
  "job.attempt",
  "run.id",
  "workspace.id",
  "lease.generation",
  "count",
  "duration.ms",
]);

const redactString = (value: string): string =>
  value
    .replace(/\b(?:bearer|token|secret|password|api[_-]?key)\s*[:=]?\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){1,2}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s,;]+/gi, "[REDACTED_URL]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .slice(0, 256);

const safeIdentifier = (value: string | undefined): string | undefined =>
  value === undefined
    ? undefined
    : redactString(value)
        .replace(/[^a-zA-Z0-9._:-]/g, "_")
        .slice(0, 128);

const sanitizeAttributes = (
  attributes: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (!attributes) return undefined;
  const safe: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!allowedAttributeKeys.has(key)) continue;
    if (typeof value === "string") safe[key] = redactString(value);
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean" || value === null) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
};

const sanitizeSpanAttributes = (
  attributes: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> => {
  const safe: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!allowedSpanAttributeKeys.has(key)) continue;
    if (typeof value === "string") safe[key] = safeIdentifier(value) ?? "redacted";
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean" || value === null) safe[key] = value;
  }
  return safe;
};

export class StructuredLogger {
  constructor(
    private readonly service: string,
    private readonly minimumLevel: LogLevel,
    private readonly sink: LogSink,
  ) {}

  sinkAdapter(): LogSink {
    return this.sink;
  }

  log(
    level: LogLevel,
    event: string,
    fields: Omit<LogRecord, "timestamp" | "level" | "service" | "event"> = {},
  ): void {
    if (ranks[level] < ranks[this.minimumLevel]) return;
    const attributes = sanitizeAttributes(fields.attributes);
    const traceId = safeIdentifier(fields.traceId);
    const spanId = safeIdentifier(fields.spanId);
    const workspaceId = safeIdentifier(fields.workspaceId);
    const jobId = safeIdentifier(fields.jobId);
    const runId = safeIdentifier(fields.runId);
    const outcome = safeIdentifier(fields.outcome);
    try {
      const result = this.sink.write({
        timestamp: new Date().toISOString(),
        level,
        service: redactString(this.service),
        event: safeIdentifier(event) ?? "invalid_event",
        ...(traceId ? { traceId } : {}),
        ...(spanId ? { spanId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(jobId ? { jobId } : {}),
        ...(runId ? { runId } : {}),
        ...(outcome ? { outcome } : {}),
        ...(attributes ? { attributes } : {}),
      });
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Logging failures are isolated from durable state transitions.
    }
  }
}

export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly status: "ok" | "error";
  readonly attributes: Readonly<Record<string, JsonValue>>;
  readonly errorCode?: string;
}

export interface SpanExporter extends RuntimeAdapter {
  export(record: SpanRecord): void | Promise<void>;
}

export class InMemorySpanExporter implements SpanExporter {
  readonly adapterKind = "test-only" as const;
  readonly adapterName = "in-memory-span-exporter";
  readonly records: SpanRecord[] = [];

  export(record: SpanRecord): void {
    this.records.push(record);
  }
}

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** Emits OpenTelemetry-compatible trace/span identifiers and OTLP-shaped span data. */
export class OpenTelemetry {
  constructor(
    private readonly clock: Clock,
    private readonly exporter: SpanExporter,
  ) {}

  exporterAdapter(): SpanExporter {
    return this.exporter;
  }

  async span<T>(
    name: string,
    attributes: Readonly<Record<string, JsonValue>>,
    operation: (context: SpanContext) => Promise<T>,
    parent?: SpanContext,
  ): Promise<T> {
    const context: SpanContext = { traceId: parent?.traceId ?? hex(16), spanId: hex(8) };
    const startTimeMs = this.clock.now();
    const safeName = safeIdentifier(name) ?? "invalid_span";
    const safeAttributes = sanitizeSpanAttributes(attributes);
    try {
      const result = await operation(context);
      this.safeExport({
        traceId: context.traceId,
        spanId: context.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name: safeName,
        startTimeMs,
        endTimeMs: this.clock.now(),
        status: "ok",
        attributes: safeAttributes,
      });
      return result;
    } catch (error) {
      this.safeExport({
        traceId: context.traceId,
        spanId: context.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name: safeName,
        startTimeMs,
        endTimeMs: this.clock.now(),
        status: "error",
        attributes: safeAttributes,
        errorCode: safeIdentifier(error instanceof Error ? error.name : "unknown") ?? "unknown",
      });
      throw error;
    }
  }

  private safeExport(record: SpanRecord): void {
    try {
      const result = this.exporter.export(record);
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Export failures are isolated from the instrumented operation.
    }
  }
}
