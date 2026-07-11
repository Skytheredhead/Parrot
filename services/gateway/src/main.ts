import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GatewayDependencies } from "./contracts.js";
import { loadConfig } from "./config.js";
import { startTelemetry } from "./observability.js";

interface AdapterModule {
  createGatewayDependencies(
    config: ReturnType<typeof loadConfig>,
  ): Promise<GatewayDependencies> | GatewayDependencies;
}

const config = loadConfig(process.env);
if (!config.adapterModule) {
  throw new Error(
    "GATEWAY_ADAPTER_MODULE must point to a reviewed production adapter composition module",
  );
}
const telemetry = await startTelemetry(config.telemetry);
const adapterUrl = pathToFileURL(resolve(config.adapterModule)).href;
const adapters = (await import(adapterUrl)) as Partial<AdapterModule>;
if (typeof adapters.createGatewayDependencies !== "function") {
  throw new Error("Adapter module must export createGatewayDependencies(config)");
}
const dependencies = await adapters.createGatewayDependencies(config);
const { buildGateway } = await import("./app.js");
const app = await buildGateway(config, dependencies);

const shutdown = async (signal: string) => {
  app.log.info({ event: "shutdown_started", signal });
  await app.close();
  await telemetry.shutdown();
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
await app.listen({ host: config.host, port: config.port });
