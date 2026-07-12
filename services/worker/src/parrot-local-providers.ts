import { resolve } from "node:path";
import type {
  NotificationProvider,
  NotificationProviderResult,
  NotificationReconciliationResult,
  NotificationRequest,
} from "./adapters.js";
import { BoundedTextExtractor, ClamAvScanner } from "./content-providers.js";
import { DurableOtlpAdapter } from "./durable-telemetry.js";
import type { NotificationRecipientResolver } from "./gmail-provider.js";
import { GmailNotificationProvider, gmailConfigFromEnv } from "./gmail-provider.js";
import {
  FilesystemObjectStore,
  FilesystemWorkspaceExportMaterializer,
  type WorkspaceExportSource,
} from "./local-storage.js";
import { DurableOllamaAgentProvider } from "./ollama-provider.js";
import { SqliteFtsSearchBackend } from "./sqlite-search.js";
import type {
  WorkspaceExportCleanupRequest,
  WorkspaceExportDeleteReconciliation,
  WorkspaceExportDeleteResult,
  WorkspaceExportMaterializationRequest,
  WorkspaceExportMaterializationResult,
  WorkspaceExportMaterializer,
  WorkspaceExportReconciliationResult,
} from "./workspace-export.js";

export interface ParrotLocalProviderDependencies {
  /** Resolves only from current Spacetime authority; never cache recipient addresses here. */
  readonly notificationRecipients?: NotificationRecipientResolver;
  /** Streams an authorization-fenced, canonical workspace snapshot. */
  readonly workspaceExportSource?: WorkspaceExportSource;
}

class UnavailableNotificationProvider implements NotificationProvider {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "browser-realtime-only-notification-provider";
  assertProductionReady(): boolean {
    return true;
  }
  async ready(): Promise<boolean> {
    return true;
  }
  async send(
    _request: NotificationRequest,
    _idempotencyKey: string,
    _signal: AbortSignal,
  ): Promise<NotificationProviderResult> {
    return { type: "permanent_failure", code: "channel_unavailable" };
  }
  async reconcile(
    _idempotencyKey: string,
    _signal: AbortSignal,
  ): Promise<NotificationReconciliationResult> {
    return { type: "not_found" };
  }
}

class UnavailableWorkspaceExportMaterializer implements WorkspaceExportMaterializer {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "workspace-export-disabled-until-source-authority";
  assertProductionReady(): boolean {
    return true;
  }
  async ready(): Promise<boolean> {
    return true;
  }
  async materialize(
    _request: WorkspaceExportMaterializationRequest,
    _signal: AbortSignal,
  ): Promise<WorkspaceExportMaterializationResult> {
    return { type: "permanent_failure", code: "source_rejected" };
  }
  async reconcile(
    _materializationKey: string,
    _signal: AbortSignal,
  ): Promise<WorkspaceExportReconciliationResult> {
    return { type: "not_found" };
  }
  async deleteExact(
    _request: WorkspaceExportCleanupRequest,
    _signal: AbortSignal,
  ): Promise<WorkspaceExportDeleteResult> {
    return { type: "conditional_mismatch" };
  }
  async reconcileDelete(
    _cleanupKey: string,
    _signal: AbortSignal,
  ): Promise<WorkspaceExportDeleteReconciliation> {
    return { type: "conditional_mismatch" };
  }
}

/**
 * Builds the reviewed local provider half of WorkerProductionPorts.
 * Authority, outbox, effect ledger, and repository ports are intentionally absent and must be
 * supplied by the authenticated Spacetime adapter module.
 */
export const createParrotLocalProviders = (
  env: NodeJS.ProcessEnv,
  dependencies: ParrotLocalProviderDependencies,
) => {
  const stateRoot = env.PARROT_STATE_ROOT?.trim();
  const bigRoot = env.PARROT_BIG_ROOT?.trim();
  const clamSocket = env.CLAMAV_SOCKET?.trim();
  const ollamaModel = env.OLLAMA_MODEL?.trim();
  const gmail = gmailConfigFromEnv(env);
  if (
    !stateRoot?.startsWith("/") ||
    !bigRoot?.startsWith("/") ||
    !clamSocket?.startsWith("/") ||
    !ollamaModel
  ) {
    throw new Error("parrot_local_provider_environment_incomplete");
  }
  const state = resolve(stateRoot);
  const big = resolve(bigRoot);
  const telemetry = new DurableOtlpAdapter(
    resolve(state, "telemetry.sqlite"),
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim(),
    env.OTEL_SERVICE_NAME?.trim() || "parrot-worker",
  );
  return Object.freeze({
    search: new SqliteFtsSearchBackend(resolve(state, "search.sqlite")),
    objects: new FilesystemObjectStore(resolve(big, "objects")),
    scanner: new ClamAvScanner({ socketPath: clamSocket }),
    extractor: new BoundedTextExtractor(),
    notificationProvider:
      gmail && dependencies.notificationRecipients
        ? new GmailNotificationProvider(gmail, dependencies.notificationRecipients)
        : new UnavailableNotificationProvider(),
    agentProvider: new DurableOllamaAgentProvider(
      resolve(state, "ollama-broker.sqlite"),
      env.OLLAMA_ENDPOINT?.trim() || "http://127.0.0.1:11434",
      ollamaModel,
    ),
    workspaceExportMaterializer: dependencies.workspaceExportSource
      ? new FilesystemWorkspaceExportMaterializer(
          resolve(big, "exports"),
          dependencies.workspaceExportSource,
        )
      : new UnavailableWorkspaceExportMaterializer(),
    logSink: telemetry,
    spanExporter: telemetry,
  });
};
