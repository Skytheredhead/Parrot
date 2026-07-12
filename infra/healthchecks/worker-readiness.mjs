const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4_000);
try {
  const response = await fetch("http://127.0.0.1:8081/health/ready", {
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`readiness returned ${response.status}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "readiness failed");
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
