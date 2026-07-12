export type WorkerEnvironment = "development" | "test" | "staging" | "production";

export interface WorkerConfig {
  readonly environment: WorkerEnvironment;
  readonly adapterModule: string | undefined;
  readonly workerId: string;
  readonly healthHost: "127.0.0.1" | "0.0.0.0";
  readonly healthPort: number;
  readonly pollIntervalMs: number;
  readonly claimTimeoutMs: number;
  readonly readinessTimeoutMs: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly handlerTimeoutMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly maxAttempts: number;
  readonly maxJobAgeMs: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly backoffJitterRatio: number;
  readonly checkpointMs: number;
  readonly maxContextBytes: number;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
  readonly maxRunCostMicros: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly otelServiceName: string;
}

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid worker environment: ${issues.join("; ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

const integer = (
  env: NodeJS.ProcessEnv,
  key: string,
  issues: string[],
  options: { min: number; max: number; defaultValue?: number },
): number => {
  const raw = env[key];
  if (raw === undefined && options.defaultValue !== undefined) return options.defaultValue;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    issues.push(`${key} must be an integer from ${options.min} to ${options.max}`);
    return options.defaultValue ?? options.min;
  }
  return parsed;
};

const ratio = (
  env: NodeJS.ProcessEnv,
  key: string,
  issues: string[],
  defaultValue: number,
): number => {
  const raw = env[key];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    issues.push(`${key} must be a number from 0 to 1`);
    return defaultValue;
  }
  return parsed;
};

export const loadWorkerConfig = (env: NodeJS.ProcessEnv): WorkerConfig => {
  const issues: string[] = [];
  const environment = env.WORKER_ENVIRONMENT;
  const allowedEnvironments: readonly WorkerEnvironment[] = [
    "development",
    "test",
    "staging",
    "production",
  ];
  if (!allowedEnvironments.includes(environment as WorkerEnvironment)) {
    issues.push("WORKER_ENVIRONMENT must be development, test, staging, or production");
  }

  const workerId = env.WORKER_ID?.trim() ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(workerId)) {
    issues.push("WORKER_ID must be 3-128 safe identifier characters");
  }

  const adapterModule = env.WORKER_ADAPTER_MODULE?.trim();
  if (
    adapterModule !== undefined &&
    (!adapterModule.startsWith("/") || adapterModule.length > 1_024)
  ) {
    issues.push("WORKER_ADAPTER_MODULE must be an absolute path no longer than 1024 characters");
  }

  const healthHost = env.WORKER_HEALTH_HOST ?? "127.0.0.1";
  if (healthHost !== "127.0.0.1" && healthHost !== "0.0.0.0") {
    issues.push("WORKER_HEALTH_HOST must be 127.0.0.1 or 0.0.0.0");
  }

  const leaseMs = integer(env, "WORKER_LEASE_MS", issues, {
    min: 1_000,
    max: 900_000,
    defaultValue: 30_000,
  });
  const heartbeatMs = integer(env, "WORKER_HEARTBEAT_MS", issues, {
    min: 100,
    max: 300_000,
    defaultValue: 10_000,
  });
  if (heartbeatMs * 2 >= leaseMs) {
    issues.push("WORKER_HEARTBEAT_MS must be less than half WORKER_LEASE_MS");
  }

  const logLevel = env.WORKER_LOG_LEVEL ?? "info";
  if (
    !(["debug", "info", "warn", "error"] as const).includes(logLevel as WorkerConfig["logLevel"])
  ) {
    issues.push("WORKER_LOG_LEVEL must be debug, info, warn, or error");
  }

  const otelServiceName = env.OTEL_SERVICE_NAME?.trim() ?? "project-conversation-worker";
  if (otelServiceName.length === 0 || otelServiceName.length > 128) {
    issues.push("OTEL_SERVICE_NAME must be 1-128 characters");
  }

  const config: WorkerConfig = {
    environment: environment as WorkerEnvironment,
    adapterModule,
    workerId,
    healthHost: healthHost as WorkerConfig["healthHost"],
    healthPort: integer(env, "WORKER_HEALTH_PORT", issues, {
      min: 1_024,
      max: 65_535,
      defaultValue: 8_081,
    }),
    pollIntervalMs: integer(env, "WORKER_POLL_INTERVAL_MS", issues, {
      min: 25,
      max: 60_000,
      defaultValue: 500,
    }),
    claimTimeoutMs: integer(env, "WORKER_CLAIM_TIMEOUT_MS", issues, {
      min: 100,
      max: 60_000,
      defaultValue: 5_000,
    }),
    readinessTimeoutMs: integer(env, "WORKER_READINESS_TIMEOUT_MS", issues, {
      min: 100,
      max: 30_000,
      defaultValue: 2_000,
    }),
    leaseMs,
    heartbeatMs,
    handlerTimeoutMs: integer(env, "WORKER_HANDLER_TIMEOUT_MS", issues, {
      min: 1_000,
      max: 3_600_000,
      defaultValue: 120_000,
    }),
    heartbeatTimeoutMs: integer(env, "WORKER_HEARTBEAT_TIMEOUT_MS", issues, {
      min: 100,
      max: 300_000,
      defaultValue: 5_000,
    }),
    shutdownTimeoutMs: integer(env, "WORKER_SHUTDOWN_TIMEOUT_MS", issues, {
      min: 100,
      max: 300_000,
      defaultValue: 10_000,
    }),
    maxAttempts: integer(env, "WORKER_MAX_ATTEMPTS", issues, {
      min: 1,
      max: 100,
      defaultValue: 8,
    }),
    maxJobAgeMs: integer(env, "WORKER_MAX_JOB_AGE_MS", issues, {
      min: 1_000,
      max: 2_592_000_000,
      defaultValue: 604_800_000,
    }),
    backoffBaseMs: integer(env, "WORKER_BACKOFF_BASE_MS", issues, {
      min: 10,
      max: 86_400_000,
      defaultValue: 1_000,
    }),
    backoffCapMs: integer(env, "WORKER_BACKOFF_CAP_MS", issues, {
      min: 10,
      max: 86_400_000,
      defaultValue: 300_000,
    }),
    backoffJitterRatio: ratio(env, "WORKER_BACKOFF_JITTER_RATIO", issues, 0.2),
    checkpointMs: integer(env, "WORKER_CHECKPOINT_MS", issues, {
      min: 100,
      max: 300_000,
      defaultValue: 2_000,
    }),
    maxContextBytes: integer(env, "AGENT_MAX_CONTEXT_BYTES", issues, {
      min: 1_024,
      max: 100_000_000,
      defaultValue: 1_000_000,
    }),
    maxOutputTokens: integer(env, "AGENT_MAX_OUTPUT_TOKENS", issues, {
      min: 1,
      max: 1_000_000,
      defaultValue: 16_000,
    }),
    maxToolCalls: integer(env, "AGENT_MAX_TOOL_CALLS", issues, {
      min: 0,
      max: 10_000,
      defaultValue: 32,
    }),
    maxRunCostMicros: integer(env, "AGENT_MAX_RUN_COST_MICROS", issues, {
      min: 0,
      max: 10_000_000_000,
      defaultValue: 5_000_000,
    }),
    logLevel: logLevel as WorkerConfig["logLevel"],
    otelServiceName,
  };

  if (config.backoffBaseMs > config.backoffCapMs) {
    issues.push("WORKER_BACKOFF_BASE_MS cannot exceed WORKER_BACKOFF_CAP_MS");
  }
  if (config.heartbeatTimeoutMs >= config.leaseMs) {
    issues.push("WORKER_HEARTBEAT_TIMEOUT_MS must be less than WORKER_LEASE_MS");
  }
  if (config.claimTimeoutMs >= config.leaseMs) {
    issues.push("WORKER_CLAIM_TIMEOUT_MS must be less than WORKER_LEASE_MS");
  }
  if (issues.length > 0) throw new EnvValidationError(issues);
  return Object.freeze(config);
};
