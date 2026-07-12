import type { AgentTool, ToolEffectClass } from "./agent.js";
import type { EffectResult, JsonValue, ReconciliationResult } from "./domain.js";
import type { RuntimeAdapter } from "./outbox.js";

export interface AgentToolNormalizationContext {
  readonly workspaceId: string;
  readonly runId: string;
  readonly authorizationEpoch: number;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly callId: string;
}

export interface AgentToolExecutionContext {
  readonly workspaceId: string;
  readonly runId: string;
  readonly authorizationEpoch: number;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly idempotencyKey: string;
}

export interface AgentToolExecutionBoundary extends RuntimeAdapter {
  normalize(
    input: AgentToolNormalizationContext & { readonly arguments: JsonValue },
    signal: AbortSignal,
  ): Promise<JsonValue>;
  execute(
    input: AgentToolExecutionContext & { readonly arguments: JsonValue },
    signal: AbortSignal,
  ): Promise<EffectResult>;
  reconcile(input: AgentToolExecutionContext, signal: AbortSignal): Promise<ReconciliationResult>;
}

export interface ReviewedAgentToolExecutionBoundaryDefinition extends RuntimeAdapter {
  normalize(
    input: AgentToolNormalizationContext & { readonly arguments: JsonValue },
    signal: AbortSignal,
  ): Promise<JsonValue>;
  execute(
    input: AgentToolExecutionContext & { readonly arguments: JsonValue },
    signal: AbortSignal,
  ): Promise<EffectResult>;
  reconcile(input: AgentToolExecutionContext, signal: AbortSignal): Promise<ReconciliationResult>;
}

interface BoundaryReview {
  readonly prototype: object | null;
  readonly normalize: AgentToolExecutionBoundary["normalize"];
  readonly execute: AgentToolExecutionBoundary["execute"];
  readonly reconcile: AgentToolExecutionBoundary["reconcile"];
}

const reviewedBoundaries = new WeakMap<object, BoundaryReview>();

/** Captures an immutable, provider-neutral execution boundary before it enters a runtime graph. */
export const createReviewedAgentToolExecutionBoundary = (
  definition: ReviewedAgentToolExecutionBoundaryDefinition,
): AgentToolExecutionBoundary => {
  if (definition.adapterKind !== "durable") throw new Error("tool_boundary_not_durable");
  if (
    typeof definition.assertProductionReady !== "function" ||
    typeof definition.ready !== "function" ||
    typeof definition.normalize !== "function" ||
    typeof definition.execute !== "function" ||
    typeof definition.reconcile !== "function"
  ) {
    throw new Error("tool_boundary_contract_invalid");
  }
  const normalize = definition.normalize.bind(definition);
  const execute = definition.execute.bind(definition);
  const reconcile = definition.reconcile.bind(definition);
  const boundary: AgentToolExecutionBoundary = Object.freeze({
    adapterKind: "durable",
    adapterName: definition.adapterName,
    assertProductionReady: definition.assertProductionReady.bind(definition),
    ready: definition.ready.bind(definition),
    ...(definition.close ? { close: definition.close.bind(definition) } : {}),
    normalize,
    execute,
    reconcile,
  });
  reviewedBoundaries.set(boundary, {
    prototype: Object.getPrototypeOf(boundary),
    normalize,
    execute,
    reconcile,
  });
  return boundary;
};

export const isReviewedAgentToolExecutionBoundary = (
  boundary: AgentToolExecutionBoundary,
): boolean => {
  const review = reviewedBoundaries.get(boundary);
  return (
    review !== undefined &&
    Object.isFrozen(boundary) &&
    Object.getPrototypeOf(boundary) === review.prototype &&
    boundary.normalize === review.normalize &&
    boundary.execute === review.execute &&
    boundary.reconcile === review.reconcile
  );
};

/** Durable tool definitions are metadata only; all executable behavior belongs to the boundary. */
export interface BoundaryEnforcedAgentToolDefinition {
  readonly adapterKind: "durable";
  readonly adapterName: string;
  readonly name: string;
  readonly version: string;
  readonly effectClass: ToolEffectClass;
  readonly approvalPolicy: "never" | "required";
  readonly retryWhenReconciledNotFound: boolean;
}

interface BoundaryToolReview {
  readonly boundary: AgentToolExecutionBoundary;
  readonly prototype: object | null;
  readonly normalizeArguments: AgentTool["normalizeArguments"];
  readonly execute: AgentTool["execute"];
  readonly reconcile: AgentTool["reconcile"];
}

const reviewedBoundaryTools = new WeakMap<object, BoundaryToolReview>();

export const createBoundaryEnforcedAgentTool = (
  boundary: AgentToolExecutionBoundary,
  definition: BoundaryEnforcedAgentToolDefinition,
): AgentTool => {
  if (!isReviewedAgentToolExecutionBoundary(boundary)) {
    throw new Error("tool_boundary_not_reviewed");
  }
  if (
    typeof boundary.assertProductionReady !== "function" ||
    typeof boundary.ready !== "function"
  ) {
    throw new Error("tool_boundary_contract_invalid");
  }
  const assertProductionReady = boundary.assertProductionReady;
  const ready = boundary.ready;
  const normalizeArguments: AgentTool["normalizeArguments"] = () => {
    throw new Error("tool_normalization_context_required");
  };
  const execute: AgentTool["execute"] = async () => {
    throw new Error("tool_execution_context_required");
  };
  const reconcile: AgentTool["reconcile"] = async () => {
    throw new Error("tool_reconciliation_context_required");
  };
  const tool: AgentTool = Object.freeze({
    adapterKind: definition.adapterKind,
    adapterName: definition.adapterName,
    assertProductionReady,
    ready,
    name: definition.name,
    version: definition.version,
    effectClass: definition.effectClass,
    approvalPolicy: definition.approvalPolicy,
    retryWhenReconciledNotFound: definition.retryWhenReconciledNotFound,
    normalizeArguments,
    execute,
    reconcile,
  });
  reviewedBoundaryTools.set(tool, {
    boundary,
    prototype: Object.getPrototypeOf(tool),
    normalizeArguments,
    execute,
    reconcile,
  });
  return tool;
};

export const isBoundaryEnforcedAgentTool = (
  tool: AgentTool,
  boundary: AgentToolExecutionBoundary,
): boolean => {
  const review = reviewedBoundaryTools.get(tool);
  return (
    review !== undefined &&
    review.boundary === boundary &&
    Object.isFrozen(tool) &&
    Object.getPrototypeOf(tool) === review.prototype &&
    tool.normalizeArguments === review.normalizeArguments &&
    tool.execute === review.execute &&
    tool.reconcile === review.reconcile
  );
};
