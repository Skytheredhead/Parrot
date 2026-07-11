import { readFile } from "node:fs/promises";

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4_000);
try {
  const token = (await readFile("/run/secrets/gateway_readiness_token", "utf8")).trim();
  if (token.length < 32) throw new Error("invalid readiness token secret");
  const response = await fetch("http://127.0.0.1:8080/health/ready", {
    headers: { "x-readiness-token": token },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`readiness returned ${response.status}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "readiness failed");
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
