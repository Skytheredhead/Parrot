import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkerProductionPorts } from "./composition.js";
import { workerRuntimeAdapters } from "./composition.js";
import type { WorkerConfig } from "./config.js";
import { DigestScheduler } from "./digest.js";
import { SystemClock } from "./domain.js";
import { OutboxConsumer, RetryPolicy, type RuntimeAdapter } from "./outbox.js";

type HostState = "new" | "running" | "stopping" | "stopped";

const timeoutError = (code: string): Error => Object.assign(new Error(code), { name: code });

const bounded = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let rejectTimeout: ((reason: unknown) => void) | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  timer = setTimeout(() => {
    const error = timeoutError(code);
    controller.abort(error);
    rejectTimeout?.(error);
  }, timeoutMs);
  timer.unref?.();
  const pending = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([pending, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
    void pending.catch(() => undefined);
  }
};

const waitFor = async (operation: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  try {
    await bounded(async () => operation, timeoutMs, "worker_drain_timeout");
    return true;
  } catch {
    return false;
  }
};

const wait = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export interface WorkerHostAddress {
  readonly host: string;
  readonly port: number;
}

export class WorkerHost {
  private state: HostState = "new";
  private readonly server: Server;
  private readonly adapters: readonly RuntimeAdapter[];
  private readonly consumer: OutboxConsumer;
  private readonly digestScheduler: DigestScheduler;
  private loopPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private idleController: AbortController | undefined;
  private activeController: AbortController | undefined;
  private lastPollHealthy = false;
  private readinessInFlight: Promise<boolean> | undefined;

  constructor(
    private readonly config: WorkerConfig,
    private readonly ports: WorkerProductionPorts,
  ) {
    const clock = new SystemClock();
    this.adapters = workerRuntimeAdapters(ports);
    this.digestScheduler = new DigestScheduler(
      ports.digestAuthority,
      ports.notificationProvider,
      config.workerId,
      Math.max(5_000, Math.min(config.leaseMs, 300_000)),
    );
    this.consumer = new OutboxConsumer(
      {
        workerId: config.workerId,
        leaseMs: config.leaseMs,
        heartbeatMs: config.heartbeatMs,
        heartbeatTimeoutMs: config.heartbeatTimeoutMs,
        claimTimeoutMs: config.claimTimeoutMs,
        handlerTimeoutMs: config.handlerTimeoutMs,
        shutdownTimeoutMs: config.shutdownTimeoutMs,
      },
      clock,
      ports.outbox,
      ports.effects,
      ports.handlers,
      new RetryPolicy({
        baseMs: config.backoffBaseMs,
        capMs: config.backoffCapMs,
        jitterRatio: config.backoffJitterRatio,
        maxAttempts: config.maxAttempts,
        maxAgeMs: config.maxJobAgeMs,
      }),
      ports.logger,
      ports.telemetry,
    );
    this.server = createServer(
      (request, response) => void this.handleHealth(request.url, response),
    );
    this.server.requestTimeout = Math.max(1_000, config.readinessTimeoutMs + 500);
    this.server.headersTimeout = this.server.requestTimeout;
    this.server.keepAliveTimeout = 1_000;
  }

  async start(): Promise<void> {
    if (this.state !== "new") throw new Error("worker_host_already_started");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.config.healthPort, this.config.healthHost);
    });
    this.state = "running";
    this.ports.logger.log("info", "worker.host.started", {
      attributes: { count: this.adapters.length },
    });
    this.loopPromise = this.pollLoop();
  }

  address(): WorkerHostAddress | undefined {
    const address = this.server.address();
    if (!address || typeof address === "string") return undefined;
    const info = address as AddressInfo;
    return { host: info.address, port: info.port };
  }

  isLive(): boolean {
    return this.state === "running" || this.state === "stopping";
  }

  async isReady(): Promise<boolean> {
    if (this.state !== "running" || !this.lastPollHealthy) return false;
    if (this.readinessInFlight) return this.readinessInFlight;
    const check = this.checkAdapters().finally(() => {
      if (this.readinessInFlight === check) this.readinessInFlight = undefined;
    });
    this.readinessInFlight = check;
    return check;
  }

  stop(reason = "shutdown"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal(reason);
    return this.stopPromise;
  }

  private async pollLoop(): Promise<void> {
    while (this.state === "running") {
      const active = new AbortController();
      this.activeController = active;
      let processed = false;
      let digestHealthy = true;
      try {
        processed = await this.consumer.tick(active.signal);
        try {
          const digest = await bounded(
            (timeoutSignal) =>
              this.digestScheduler.runOnce(
                new Date(),
                AbortSignal.any([active.signal, timeoutSignal]),
              ),
            Math.min(this.config.handlerTimeoutMs, 300_000),
            "worker_digest_timeout",
          );
          processed = digest.claimed > 0 || processed;
        } catch (error) {
          if (this.state !== "running") break;
          digestHealthy = false;
          this.ports.logger.log("error", "worker.digest.failed", {
            attributes: { code: error instanceof Error ? error.name : "unknown" },
          });
        }
        this.lastPollHealthy = digestHealthy;
      } catch (error) {
        if (this.state !== "running") break;
        this.lastPollHealthy = false;
        this.ports.logger.log("error", "worker.poll.failed", {
          attributes: { code: error instanceof Error ? error.name : "unknown" },
        });
      } finally {
        if (this.activeController === active) this.activeController = undefined;
      }
      if (this.state !== "running") break;
      this.idleController = new AbortController();
      await wait(processed ? 0 : this.config.pollIntervalMs, this.idleController.signal);
      this.idleController = undefined;
    }
  }

  private async checkAdapters(): Promise<boolean> {
    const checks = this.adapters.map(async (adapter) => {
      if (typeof adapter.ready !== "function") return false;
      try {
        return await bounded(
          (signal) => adapter.ready?.(signal) ?? Promise.resolve(false),
          this.config.readinessTimeoutMs,
          "worker_readiness_timeout",
        );
      } catch {
        return false;
      }
    });
    return (await Promise.all(checks)).every(Boolean);
  }

  private async stopInternal(reason: string): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "new") {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    this.lastPollHealthy = false;
    this.idleController?.abort(timeoutError("worker_stopping"));
    this.ports.logger.log("info", "worker.host.stopping", { attributes: { code: reason } });

    const loop = this.loopPromise ?? Promise.resolve();
    const drained = await waitFor(loop, this.config.shutdownTimeoutMs);
    if (!drained) {
      this.activeController?.abort(timeoutError("worker_shutdown_timeout"));
      await waitFor(loop, this.config.shutdownTimeoutMs);
    }

    await this.closeAdapters();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    this.state = "stopped";
    this.ports.logger.log("info", "worker.host.stopped", {
      attributes: { code: drained ? "drained" : "aborted" },
    });
  }

  private async closeAdapters(): Promise<void> {
    const deadline = Date.now() + this.config.shutdownTimeoutMs;
    for (const adapter of [...this.adapters].reverse()) {
      if (typeof adapter.close !== "function") continue;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        this.ports.logger.log("warn", "worker.adapter.close_deadline", {
          attributes: { code: adapter.adapterName },
        });
        break;
      }
      try {
        await bounded(
          (signal) => adapter.close?.(signal) ?? Promise.resolve(),
          Math.min(this.config.readinessTimeoutMs, remainingMs),
          "worker_adapter_close_timeout",
        );
      } catch {
        this.ports.logger.log("warn", "worker.adapter.close_failed", {
          attributes: { code: adapter.adapterName },
        });
      }
    }
  }

  private async handleHealth(
    url: string | undefined,
    response: import("node:http").ServerResponse,
  ) {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (url === "/health/live") {
      response.statusCode = this.isLive() ? 200 : 503;
      response.end(JSON.stringify({ status: this.isLive() ? "ok" : "stopped" }));
      return;
    }
    if (url === "/health/ready") {
      const ready = await this.isReady();
      response.statusCode = ready ? 200 : 503;
      response.end(JSON.stringify({ status: ready ? "ready" : "not_ready" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ status: "not_found" }));
  }
}
