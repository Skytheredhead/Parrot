import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  AgentToolRegistry,
  FakeClock,
  HandlerRegistry,
  InMemoryAgentRunRepository,
  InMemoryApprovalStore,
  InMemoryAuthorizationGate,
  InMemoryEffectLedger,
  InMemoryNotificationProvider,
  InMemoryObjectStore,
  InMemorySearchBackend,
  InMemorySpanExporter,
  InMemoryTransactionalOutbox,
  OpenTelemetry,
  ScriptedAgentProvider,
  StaticAgentContextSource,
  StructuredLogger,
  WorkerHost,
  loadWorkerConfig,
  newJob,
  type EffectResult,
  type JobHandler,
  type JobKind,
  type RuntimeAdapter,
  type WorkerProductionPorts,
} from "../src/index.js";

const jobKinds: readonly JobKind[] = [
  "notification.deliver",
  "search.upsert",
  "search.tombstone",
  "search.rebuild",
  "file.scan",
  "file.extract",
  "file.cleanup",
  "agent.run",
];

const config = (overrides: Partial<ReturnType<typeof loadWorkerConfig>> = {}) => ({
  ...loadWorkerConfig({
    WORKER_ENVIRONMENT: "test",
    WORKER_ID: "worker-runtime-test",
    WORKER_LEASE_MS: "1000",
    WORKER_HEARTBEAT_MS: "100",
    WORKER_HEARTBEAT_TIMEOUT_MS: "100",
    WORKER_CLAIM_TIMEOUT_MS: "100",
    WORKER_HANDLER_TIMEOUT_MS: "1000",
    WORKER_SHUTDOWN_TIMEOUT_MS: "100",
    WORKER_POLL_INTERVAL_MS: "25",
    WORKER_READINESS_TIMEOUT_MS: "100",
  }),
  healthPort: 0,
  ...overrides,
});

const readyAdapter = <T extends RuntimeAdapter>(adapter: T, close?: () => void): T => {
  Object.assign(adapter, {
    ready: async (signal: AbortSignal) => !signal.aborted,
    ...(close
      ? {
          close: async (signal: AbortSignal) => {
            if (!signal.aborted) close();
          },
        }
      : {}),
  });
  return adapter;
};

const placeholder = (name: string): RuntimeAdapter => ({
  adapterKind: "test-only",
  adapterName: name,
  ready: async (signal) => !signal.aborted,
});

const graph = (
  options: {
    readonly outbox?: InMemoryTransactionalOutbox;
    readonly handler?: JobHandler;
    readonly onClose?: () => void;
  } = {},
): WorkerProductionPorts => {
  const clock = new FakeClock(Date.now());
  const outbox = readyAdapter(
    options.outbox ?? new InMemoryTransactionalOutbox(clock),
    options.onClose,
  );
  const effects = readyAdapter(new InMemoryEffectLedger(clock));
  const handlers = new HandlerRegistry();
  const fallback: JobHandler = {
    retryWhenReconciledNotFound: false,
    dependencies: [outbox],
    async execute(): Promise<EffectResult> {
      return { type: "permanent_failure", code: "unused" };
    },
    async reconcile() {
      return { type: "unknown" };
    },
  };
  for (const kind of jobKinds) {
    handlers.registerTestOnly(
      kind,
      kind === "notification.deliver" && options.handler ? options.handler : fallback,
    );
  }
  const tool = {
    adapterKind: "test-only" as const,
    adapterName: "runtime-test-tool",
    ready: async (signal: AbortSignal) => !signal.aborted,
    name: "runtime-test-tool",
    version: "1",
    effectClass: "read" as const,
    approvalPolicy: "never" as const,
    retryWhenReconciledNotFound: false,
    normalizeArguments: (value: import("../src/index.js").JsonValue) => value,
    async execute(): Promise<EffectResult> {
      return { type: "succeeded" };
    },
    async reconcile() {
      return { type: "not_found" as const };
    },
  };
  const logSink = readyAdapter({
    adapterKind: "test-only" as const,
    adapterName: "runtime-test-logs",
    write() {},
  });
  const spanExporter = readyAdapter(new InMemorySpanExporter());
  const search = readyAdapter(new InMemorySearchBackend());
  const objects = readyAdapter(new InMemoryObjectStore());
  return {
    outbox,
    effects,
    agentRuns: readyAdapter(new InMemoryAgentRunRepository()),
    approvals: readyAdapter(new InMemoryApprovalStore()),
    search,
    rebuildSource: search,
    files: placeholder("runtime-test-files") as WorkerProductionPorts["files"],
    objects,
    scanner: placeholder("runtime-test-scanner") as WorkerProductionPorts["scanner"],
    extractor: placeholder("runtime-test-extractor") as WorkerProductionPorts["extractor"],
    authorization: readyAdapter(new InMemoryAuthorizationGate()),
    contextSource: readyAdapter(new StaticAgentContextSource([])),
    notificationProvider: readyAdapter(new InMemoryNotificationProvider()),
    agentProvider: readyAdapter(new ScriptedAgentProvider([])),
    logSink,
    logger: new StructuredLogger("runtime-test", "error", logSink),
    spanExporter,
    telemetry: new OpenTelemetry(clock, spanExporter),
    handlers,
    tools: new AgentToolRegistry().register(tool),
  };
};

const eventually = async (condition: () => boolean | Promise<boolean>, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition_not_met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("worker host serves minimal liveness/readiness and closes adapters", async () => {
  let closes = 0;
  const host = new WorkerHost(config(), graph({ onClose: () => closes++ }));
  await host.start();
  const address = host.address();
  assert.ok(address);
  const origin = `http://127.0.0.1:${address.port}`;
  await eventually(() => host.isReady());
  const live = await fetch(`${origin}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "ok" });
  const ready = await fetch(`${origin}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });
  const missing = await fetch(`${origin}/internal/details`);
  assert.equal(missing.status, 404);
  await host.stop("test");
  assert.equal(closes, 1);
  assert.equal(host.isLive(), false);
});

test("SIGTERM-style stop drains an owned job without aborting it", async () => {
  const clock = new FakeClock(Date.now());
  const outbox = new InMemoryTransactionalOutbox(clock);
  let release: (() => void) | undefined;
  let started = false;
  let aborted = false;
  const handler: JobHandler = {
    retryWhenReconciledNotFound: false,
    dependencies: [outbox],
    async execute(_job, _effectKey, signal) {
      started = true;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { type: "succeeded" };
    },
    async reconcile() {
      return { type: "not_found" };
    },
  };
  const ports = graph({ outbox, handler });
  await outbox.enqueue(
    newJob(
      {
        id: "runtime-drain-job",
        workspaceId: "workspace-1",
        kind: "notification.deliver",
        payload: { intentId: "intent-1" },
      },
      clock.now(),
    ),
  );
  const host = new WorkerHost(config({ shutdownTimeoutMs: 1_000 }), ports);
  await host.start();
  await eventually(() => started);
  const stopping = host.stop("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(aborted, false);
  assert.ok(release);
  release();
  await stopping;
  assert.equal(aborted, false);
  assert.equal((await outbox.get("runtime-drain-job"))?.state, "succeeded");
});

test("shutdown deadline aborts non-cooperative work and returns without acknowledging it", async () => {
  const clock = new FakeClock(Date.now());
  const outbox = new InMemoryTransactionalOutbox(clock);
  let started = false;
  let aborted = false;
  const handler: JobHandler = {
    retryWhenReconciledNotFound: false,
    dependencies: [outbox],
    async execute(_job, _effectKey, signal) {
      started = true;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<EffectResult>(() => undefined);
    },
    async reconcile() {
      return { type: "not_found" };
    },
  };
  const ports = graph({ outbox, handler });
  await outbox.enqueue(
    newJob(
      {
        id: "runtime-abort-job",
        workspaceId: "workspace-1",
        kind: "notification.deliver",
        payload: { intentId: "intent-2" },
      },
      clock.now(),
    ),
  );
  const host = new WorkerHost(config({ shutdownTimeoutMs: 50 }), ports);
  await host.start();
  await eventually(() => started);
  const before = Date.now();
  await host.stop("SIGTERM");
  assert.equal(aborted, true);
  assert.ok(Date.now() - before < 1_000);
  assert.equal((await outbox.get("runtime-abort-job"))?.state, "leased");
});

test("standalone process fails closed without WORKER_ADAPTER_MODULE", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      WORKER_ENVIRONMENT: "production",
      WORKER_ID: "worker-process-test",
      WORKER_LEASE_MS: "30000",
      WORKER_HEARTBEAT_MS: "10000",
      WORKER_ADAPTER_MODULE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /WORKER_ADAPTER_MODULE/);
});
