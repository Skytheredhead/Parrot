import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LogRecord, LogSink, SpanExporter, SpanRecord } from "./telemetry.js";

type Fetch = typeof globalThis.fetch;

/** Durable local spool with bounded OTLP/HTTP JSON delivery and console fallback. */
export class DurableOtlpAdapter implements LogSink, SpanExporter {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "sqlite-otlp-spool";
  private readonly db: DatabaseSync;
  private flushing = false;
  constructor(
    path: string,
    private readonly endpoint: string | undefined,
    private readonly serviceName: string,
    private readonly maxRows = 100_000,
    private readonly timeoutMs = 5_000,
    private readonly fetcher: Fetch = fetch,
  ) {
    if (
      !path.startsWith("/") ||
      !serviceName ||
      serviceName.length > 128 ||
      maxRows < 100 ||
      timeoutMs < 100
    )
      throw new Error("telemetry_config_invalid");
    if (endpoint) {
      const url = new URL(endpoint);
      if (
        !(
          ["https:"].includes(url.protocol) ||
          (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
        ) ||
        url.username ||
        url.password
      )
        throw new Error("otlp_endpoint_invalid");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS telemetry_spool(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);",
    );
  }
  assertProductionReady(): boolean {
    return this.maxRows >= 100;
  }
  async ready(): Promise<boolean> {
    try {
      this.db.prepare("SELECT count(*) AS n FROM telemetry_spool").get();
      return true;
    } catch {
      return false;
    }
  }
  write(record: LogRecord): void {
    this.enqueue("log", record);
  }
  export(record: SpanRecord): void {
    this.enqueue("span", record);
  }
  private enqueue(kind: "log" | "span", payload: LogRecord | SpanRecord): void {
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) return;
    this.db
      .prepare("INSERT INTO telemetry_spool(kind,payload,created_at) VALUES(?,?,?)")
      .run(kind, serialized, Date.now());
    this.db
      .prepare(
        "DELETE FROM telemetry_spool WHERE id IN (SELECT id FROM telemetry_spool ORDER BY id ASC LIMIT MAX((SELECT count(*) FROM telemetry_spool)-?,0))",
      )
      .run(this.maxRows);
    if (!this.endpoint) {
      try {
        process.stdout.write(`${serialized}\n`);
      } catch {}
      return;
    }
    void this.flush();
  }
  async flush(): Promise<void> {
    if (this.flushing || !this.endpoint) return;
    this.flushing = true;
    try {
      const rows = this.db
        .prepare("SELECT id,kind,payload FROM telemetry_spool ORDER BY id LIMIT 100")
        .all() as Array<{ id: number; kind: string; payload: string }>;
      if (rows.length === 0) return;
      for (const kind of ["log", "span"] as const) {
        const group = rows.filter((row) => row.kind === kind);
        if (group.length === 0) continue;
        const records = group.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
        const body = kind === "log" ? this.logEnvelope(records) : this.traceEnvelope(records);
        const response = await this.fetcher(
          `${this.endpoint.replace(/\/$/, "")}/${kind === "log" ? "v1/logs" : "v1/traces"}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
          },
        );
        const placeholders = group.map(() => "?").join(",");
        this.db
          .prepare(
            `${response.ok ? "DELETE FROM telemetry_spool" : "UPDATE telemetry_spool SET attempts=attempts+1"} WHERE id IN (${placeholders})`,
          )
          .run(...group.map((row) => row.id));
      }
    } catch {
      /* Durable rows remain for retry. */
    } finally {
      this.flushing = false;
    }
  }
  private resource(): object {
    return { attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }] };
  }
  private attributes(value: unknown): object[] {
    if (typeof value !== "object" || value === null) return [];
    return Object.entries(value)
      .slice(0, 64)
      .map(([key, item]) => ({
        key,
        value:
          typeof item === "number"
            ? { doubleValue: item }
            : typeof item === "boolean"
              ? { boolValue: item }
              : { stringValue: String(item).slice(0, 256) },
      }));
  }
  private logEnvelope(records: ReadonlyArray<Record<string, unknown>>): object {
    return {
      resourceLogs: [
        {
          resource: this.resource(),
          scopeLogs: [
            {
              scope: { name: this.serviceName },
              logRecords: records.map((record) => ({
                timeUnixNano: String(Date.parse(String(record.timestamp)) * 1_000_000),
                severityText: String(record.level).toUpperCase(),
                body: { stringValue: String(record.event) },
                attributes: this.attributes(record.attributes),
              })),
            },
          ],
        },
      ],
    };
  }
  private traceEnvelope(records: ReadonlyArray<Record<string, unknown>>): object {
    return {
      resourceSpans: [
        {
          resource: this.resource(),
          scopeSpans: [
            {
              scope: { name: this.serviceName },
              spans: records.map((record) => ({
                traceId: record.traceId,
                spanId: record.spanId,
                ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
                name: record.name,
                kind: 1,
                startTimeUnixNano: String(Number(record.startTimeMs) * 1_000_000),
                endTimeUnixNano: String(Number(record.endTimeMs) * 1_000_000),
                attributes: this.attributes(record.attributes),
                status: {
                  code: record.status === "ok" ? 1 : 2,
                  ...(record.errorCode ? { message: String(record.errorCode) } : {}),
                },
              })),
            },
          ],
        },
      ],
    };
  }
  pending(): number {
    return Number(
      (this.db.prepare("SELECT count(*) AS n FROM telemetry_spool").get() as { n: number }).n,
    );
  }
}
