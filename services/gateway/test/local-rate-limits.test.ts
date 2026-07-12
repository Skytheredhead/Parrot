import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRateLimits } from "../src/production/local-rate-limits.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SqliteRateLimits", () => {
  it("atomically persists fixed-window principal limits and resets at the boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "parrot-rate-test-"));
    roots.push(root);
    let now = 10_000;
    const limits = await SqliteRateLimits.create({
      path: join(root, "state", "limits.sqlite"),
      maximum: 2,
      window: "1 minute",
      hashKey: Buffer.alloc(32, 7),
      now: () => now,
    });
    const input = { principalId: "principal", scope: "search", cost: 1 };
    await expect(limits.consumePrincipal(input)).resolves.toEqual({ allowed: true });
    await expect(limits.consumePrincipal(input)).resolves.toEqual({ allowed: true });
    await expect(limits.consumePrincipal(input)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 50,
    });
    now = 60_000;
    await expect(limits.consumePrincipal(input)).resolves.toEqual({ allowed: true });
  });
});
