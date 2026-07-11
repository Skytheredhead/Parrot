import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeClock,
  InMemorySpanExporter,
  OpenTelemetry,
  StructuredLogger,
  type LogRecord,
  type LogSink,
} from "../src/index.js";

test("structured logging redacts secrets and drops non-allowlisted attributes", () => {
  const records: LogRecord[] = [];
  const sink: LogSink = {
    adapterKind: "test-only",
    adapterName: "telemetry-test-log-sink",
    write(record) {
      records.push(record);
    },
  };
  const logger = new StructuredLogger("worker", "debug", sink);
  logger.log("error", "agent.run.terminal", {
    workspaceId: "person@example.com",
    runId: "run-1",
    attributes: {
      code: "Bearer top-secret-token",
      body: "private post body",
      authorization: "api_key=also-secret",
      attempt: 2,
    },
  });
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes("top-secret-token"), false);
  assert.equal(serialized.includes("also-secret"), false);
  assert.equal(serialized.includes("person@example.com"), false);
  assert.equal(serialized.includes("private post body"), false);
  assert.equal(records[0]?.attributes?.attempt, 2);
  assert.equal(records[0]?.attributes?.body, undefined);
});

test("telemetry spans allowlist and sanitize attributes before export", async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = new OpenTelemetry(new FakeClock(10), exporter);
  await telemetry.span(
    "worker.agent.run",
    {
      "run.id": "person@example.com",
      "job.kind": "notification.deliver",
      "job.attempt": 2,
      body: "private post body",
      token: "Bearer top-secret-token",
    },
    async () => undefined,
  );
  const serialized = JSON.stringify(exporter.records);
  assert.equal(serialized.includes("person@example.com"), false);
  assert.equal(serialized.includes("private post body"), false);
  assert.equal(serialized.includes("top-secret-token"), false);
  assert.equal(exporter.records[0]?.attributes["job.attempt"], 2);
});

test("logging and span export failures never alter business outcomes", async () => {
  const logger = new StructuredLogger("worker", "debug", {
    adapterKind: "test-only",
    adapterName: "throwing-log-sink",
    write() {
      throw new Error("log_sink_failed");
    },
  });
  assert.doesNotThrow(() =>
    logger.log("info", "completed", { attributes: { code: "https://secret.test/path" } }),
  );

  const telemetry = new OpenTelemetry(new FakeClock(10), {
    adapterKind: "test-only",
    adapterName: "throwing-span-exporter",
    export() {
      throw new Error("span_export_failed");
    },
  });
  await assert.doesNotReject(telemetry.span("operation", {}, async () => "committed"));
  await assert.rejects(
    telemetry.span("operation", {}, async () => {
      throw new Error("business_failure");
    }),
    /business_failure/,
  );
});

test("all URLs and credential-shaped tokens are redacted", () => {
  const records: LogRecord[] = [];
  const logger = new StructuredLogger("worker", "debug", {
    adapterKind: "test-only",
    adapterName: "redaction-log-sink",
    write(record) {
      records.push(record);
    },
  });
  logger.log("error", "failed", {
    attributes: {
      code: "https://objects.test/private/path abcdef0123456789abcdef0123456789",
    },
  });
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes("objects.test"), false);
  assert.equal(serialized.includes("abcdef0123456789"), false);
});

test("async rejected and hung telemetry exporters are detached from business work", async () => {
  const rejected = new OpenTelemetry(new FakeClock(10), {
    adapterKind: "test-only",
    adapterName: "rejecting-async-exporter",
    async export() {
      throw new Error("async_export_failed");
    },
  });
  await assert.doesNotReject(rejected.span("operation", {}, async () => "committed"));
  await new Promise((resolve) => setImmediate(resolve));

  const hung = new OpenTelemetry(new FakeClock(10), {
    adapterKind: "test-only",
    adapterName: "hung-async-exporter",
    export() {
      return new Promise<void>(() => undefined);
    },
  });
  const result = await hung.span("operation", {}, async () => "committed");
  assert.equal(result, "committed");
});
