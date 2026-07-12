import { createHmac } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  IpRateLimitInput,
  PrincipalRateLimitInput,
  RateLimitClient,
  RateLimitResult,
  WorkspaceRateLimitInput,
} from "../contracts.js";

function windowMilliseconds(value: string): number {
  const match = /^(\d{1,4})\s+(second|minute|hour)s?$/.exec(value.trim().toLowerCase());
  if (!match?.[1] || !match[2]) throw new Error("RATE_LIMIT_WINDOW is invalid");
  const amount = Number(match[1]);
  const multiplier = { second: 1_000, minute: 60_000, hour: 3_600_000 }[match[2]];
  if (!multiplier) throw new Error("RATE_LIMIT_WINDOW is invalid");
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result < 1_000 || result > 86_400_000)
    throw new Error("RATE_LIMIT_WINDOW is outside the durable bound");
  return result;
}

export class SqliteRateLimits implements RateLimitClient {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "host-local-sqlite-rate-limits";
  private constructor(
    private readonly database: DatabaseSync,
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly hashKey: Uint8Array,
    private readonly now: () => number,
  ) {}

  static async create(input: {
    path: string;
    maximum: number;
    window: string;
    hashKey: Uint8Array;
    now?: () => number;
  }): Promise<SqliteRateLimits> {
    if (!input.path.startsWith("/") || input.hashKey.byteLength < 32)
      throw new Error("SQLite rate-limit storage and key configuration is invalid");
    await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(input.path, { timeout: 2_000 });
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;");
    database.exec(
      "CREATE TABLE IF NOT EXISTS rate_limit_bucket (bucket_key TEXT PRIMARY KEY, window_start_ms INTEGER NOT NULL, used INTEGER NOT NULL) STRICT",
    );
    await chmod(input.path, 0o600);
    return new SqliteRateLimits(
      database,
      input.maximum,
      windowMilliseconds(input.window),
      Uint8Array.from(input.hashKey),
      input.now ?? Date.now,
    );
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    try {
      this.database.prepare("SELECT 1 AS ok").get();
      return true;
    } catch {
      return false;
    }
  }

  async consumeIp(input: IpRateLimitInput): Promise<RateLimitResult> {
    return this.consume("ip", [input.ip, input.scope], input.cost);
  }

  async consumePrincipal(input: PrincipalRateLimitInput): Promise<RateLimitResult> {
    return this.consume("principal", [input.principalId, input.scope], input.cost);
  }

  async consumeWorkspace(input: WorkspaceRateLimitInput): Promise<RateLimitResult> {
    return this.consume(
      "workspace",
      [input.principalId, input.workspaceId, input.scope],
      input.cost,
    );
  }

  private consume(kind: string, parts: readonly string[], cost: number): RateLimitResult {
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > this.maximum)
      return { allowed: false, retryAfterSeconds: Math.ceil(this.windowMs / 1_000) };
    const now = this.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    const key = createHmac("sha256", this.hashKey)
      .update(JSON.stringify([kind, ...parts]))
      .digest("base64url");
    const row = this.database
      .prepare(
        `INSERT INTO rate_limit_bucket(bucket_key, window_start_ms, used)
         VALUES (?, ?, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET
           window_start_ms = CASE WHEN window_start_ms = excluded.window_start_ms THEN window_start_ms ELSE excluded.window_start_ms END,
           used = CASE WHEN window_start_ms = excluded.window_start_ms THEN used + excluded.used ELSE excluded.used END
         RETURNING window_start_ms, used`,
      )
      .get(key, windowStart, cost) as { window_start_ms: number; used: number };
    // Opportunistic bounded cleanup; it is not part of the authorization decision.
    this.database
      .prepare("DELETE FROM rate_limit_bucket WHERE window_start_ms < ?")
      .run(windowStart - this.windowMs);
    const allowed = row.used <= this.maximum;
    return {
      allowed,
      ...(allowed
        ? {}
        : {
            retryAfterSeconds: Math.max(1, Math.ceil((windowStart + this.windowMs - now) / 1_000)),
          }),
    };
  }
}
