import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentProvider, AgentStep } from "./agent.js";
import type { JsonValue } from "./domain.js";

type Fetch = typeof globalThis.fetch;
const ID = /^[A-Za-z0-9._:-]{1,256}$/;
const HASH = /^[a-f0-9]{64}$/;

const usage = (value: unknown): { outputTokens: number; costMicros: number } => {
  if (typeof value !== "object" || value === null) throw new Error("ollama_step_invalid");
  const row = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.outputTokens) ||
    Number(row.outputTokens) < 0 ||
    !Number.isSafeInteger(row.costMicros) ||
    Number(row.costMicros) < 0
  )
    throw new Error("ollama_usage_invalid");
  return { outputTokens: Number(row.outputTokens), costMicros: Number(row.costMicros) };
};
const jsonValue = (value: unknown): value is JsonValue => {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every(jsonValue);
  return (
    typeof value === "object" &&
    Object.keys(value as object).length <= 1_000 &&
    Object.entries(value as object).every(([key, nested]) => key.length <= 128 && jsonValue(nested))
  );
};
const parseStep = (text: string): AgentStep => {
  if (Buffer.byteLength(text, "utf8") > 2_000_000) throw new Error("ollama_response_too_large");
  const value = JSON.parse(text) as Record<string, unknown>;
  const parsedUsage = usage(value.usage);
  if (
    value.type === "final" &&
    typeof value.text === "string" &&
    Buffer.byteLength(value.text, "utf8") <= 1_000_000
  )
    return { type: "final", text: value.text, usage: parsedUsage };
  if (
    value.type === "tool_call" &&
    typeof value.callId === "string" &&
    ID.test(value.callId) &&
    typeof value.toolName === "string" &&
    ID.test(value.toolName) &&
    typeof value.toolVersion === "string" &&
    ID.test(value.toolVersion) &&
    jsonValue(value.arguments)
  ) {
    const effectClass = value.effectClass;
    if (
      effectClass !== undefined &&
      !["read", "external", "destructive"].includes(String(effectClass))
    )
      throw new Error("ollama_effect_class_invalid");
    const approvalNonce = value.approvalNonce;
    if (
      approvalNonce !== undefined &&
      (typeof approvalNonce !== "string" || !ID.test(approvalNonce))
    )
      throw new Error("ollama_approval_nonce_invalid");
    return {
      type: "tool_call",
      callId: value.callId,
      toolName: value.toolName,
      toolVersion: value.toolVersion,
      arguments: value.arguments,
      ...(effectClass ? { effectClass: effectClass as "read" | "external" | "destructive" } : {}),
      ...(approvalNonce ? { approvalNonce } : {}),
      usage: parsedUsage,
    };
  }
  throw new Error("ollama_step_invalid");
};

/** Durable request/result broker around a private, loopback Ollama endpoint. */
export class DurableOllamaAgentProvider implements AgentProvider {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "sqlite-ollama-agent-provider";
  private readonly db: DatabaseSync;
  private readonly endpoint: string;
  constructor(
    path: string,
    endpoint: string,
    private readonly model: string,
    private readonly timeoutMs = 300_000,
    private readonly fetcher: Fetch = fetch,
  ) {
    const url = new URL(endpoint);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !model ||
      model.length > 128
    )
      throw new Error("ollama_config_invalid");
    if (!path.startsWith("/")) throw new Error("ollama_broker_path_invalid");
    this.endpoint = url.origin;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS ollama_requests(request_id TEXT PRIMARY KEY,input_fingerprint TEXT NOT NULL,canonical_input TEXT NOT NULL,state TEXT NOT NULL,response_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);",
    );
  }
  assertProductionReady(): boolean {
    return this.timeoutMs >= 1_000 && this.timeoutMs <= 900_000;
  }
  async ready(): Promise<boolean> {
    try {
      const response = await this.fetcher(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  async reconcile(
    requestId: string,
    inputFingerprint: string,
    signal: AbortSignal,
  ): Promise<AgentStep | undefined> {
    if (signal.aborted) throw signal.reason;
    const row = this.db
      .prepare(
        "SELECT input_fingerprint,state,response_json FROM ollama_requests WHERE request_id=?",
      )
      .get(requestId) as
      | { input_fingerprint: string; state: string; response_json?: string }
      | undefined;
    if (!row) return undefined;
    if (row.input_fingerprint !== inputFingerprint)
      throw new Error("ollama_request_fingerprint_conflict");
    return row.state === "succeeded" && row.response_json
      ? parseStep(row.response_json)
      : undefined;
  }
  async next(
    requestId: string,
    inputFingerprint: string,
    canonicalInput: string,
    signal: AbortSignal,
  ): Promise<AgentStep> {
    if (
      !ID.test(requestId) ||
      !HASH.test(inputFingerprint) ||
      Buffer.byteLength(canonicalInput, "utf8") > 10_000_000
    )
      throw new Error("ollama_request_invalid");
    const reconciled = await this.reconcile(requestId, inputFingerprint, signal);
    if (reconciled) return reconciled;
    const now = Date.now();
    let inserted = false;
    try {
      this.db
        .prepare("INSERT INTO ollama_requests VALUES(?,?,?,'pending',NULL,?,?)")
        .run(requestId, inputFingerprint, canonicalInput, now, now);
      inserted = true;
    } catch {
      const row = this.db
        .prepare("SELECT input_fingerprint,canonical_input FROM ollama_requests WHERE request_id=?")
        .get(requestId) as { input_fingerprint: string; canonical_input: string };
      if (row.input_fingerprint !== inputFingerprint || row.canonical_input !== canonicalInput)
        throw new Error("ollama_request_conflict");
    }
    if (!inserted) throw new Error("ollama_request_outcome_unknown");
    const response = await this.fetcher(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        options: { temperature: 0, seed: 0 },
        messages: [
          { role: "system", content: "Return exactly one JSON AgentStep. Never include markdown." },
          { role: "user", content: canonicalInput },
        ],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (!response.ok)
      throw new Error(
        response.status === 429 || response.status >= 500 ? "ollama_transient" : "ollama_rejected",
      );
    const body = (await response.json()) as {
      message?: { content?: unknown };
      eval_count?: unknown;
    };
    if (typeof body.message?.content !== "string") throw new Error("ollama_response_invalid");
    const raw = JSON.parse(body.message.content) as Record<string, unknown>;
    raw.usage = {
      outputTokens: Number.isSafeInteger(body.eval_count) ? Number(body.eval_count) : 0,
      costMicros: 0,
    };
    const canonical = JSON.stringify(parseStep(JSON.stringify(raw)));
    this.db
      .prepare(
        "UPDATE ollama_requests SET state='succeeded',response_json=?,updated_at=? WHERE request_id=? AND input_fingerprint=?",
      )
      .run(canonical, Date.now(), requestId, inputFingerprint);
    return parseStep(canonical);
  }
  async cancel(): Promise<void> {
    /* Ollama fetches are canceled through the run AbortSignal. */
  }
}
