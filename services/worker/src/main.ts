import { pathToFileURL } from "node:url";
import type { WorkerProductionPorts } from "./composition.js";
import { composeWorkerRuntime } from "./composition.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { WorkerHost } from "./runtime.js";

interface WorkerAdapterModule {
  createWorkerPorts(config: WorkerConfig): Promise<WorkerProductionPorts> | WorkerProductionPorts;
}

const config = loadWorkerConfig(process.env);
if (!config.adapterModule) {
  throw new Error(
    "WORKER_ADAPTER_MODULE must point to a reviewed worker adapter composition module",
  );
}

const adapterUrl = pathToFileURL(config.adapterModule).href;
const adapterModule = (await import(adapterUrl)) as Partial<WorkerAdapterModule>;
if (typeof adapterModule.createWorkerPorts !== "function") {
  throw new Error("Worker adapter module must export createWorkerPorts(config)");
}

const candidatePorts = await adapterModule.createWorkerPorts(config);
const ports = composeWorkerRuntime(config.environment, candidatePorts);
const host = new WorkerHost(config, ports);
await host.start();

let shutdownStarted = false;
const shutdown = (signal: "SIGINT" | "SIGTERM") => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  void host
    .stop(signal)
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
};

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
