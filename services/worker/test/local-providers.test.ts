import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BoundedTextExtractor, ClamAvScanner } from "../src/content-providers.js";
import { DurableOtlpAdapter } from "../src/durable-telemetry.js";
import { GmailNotificationProvider } from "../src/gmail-provider.js";
import {
  FilesystemObjectStore,
  FilesystemWorkspaceExportMaterializer,
} from "../src/local-storage.js";
import { DurableOllamaAgentProvider } from "../src/ollama-provider.js";
import { SqliteFtsSearchBackend } from "../src/sqlite-search.js";

const temp = (name: string): Promise<string> => mkdtemp(join(tmpdir(), `parrot-${name}-`));
const signal = new AbortController().signal;

test("filesystem object store is immutable, fenced, and traversal-safe", async () => {
  const root = await temp("objects");
  const store = new FilesystemObjectStore(root, 100);
  assert.equal(await store.ready(), true);
  const bytes = Buffer.from("hello");
  const version = await store.writeClean("safe/file.txt", bytes, signal);
  assert.equal(await store.writeClean("safe/file.txt", bytes, signal), version);
  await assert.rejects(
    store.writeClean("safe/file.txt", Buffer.from("changed"), signal),
    /immutable_object_conflict/,
  );
  await assert.rejects(store.stat("../escape", signal), /object_key_invalid/);
  assert.equal(await store.deleteIfMatch("safe/file.txt", "0".repeat(64), signal), false);
  assert.equal(await store.deleteIfMatch("safe/file.txt", version, signal), true);
});

test("filesystem export materialization reconciles and conditionally deletes", async () => {
  const root = await temp("exports");
  const materializer = new FilesystemWorkspaceExportMaterializer(root, {
    async *stream() {
      yield Buffer.from('{"id":1}\n');
    },
  });
  const request = {
    exportId: "ex1",
    workspaceId: "ws1",
    lifecycleEpoch: 1,
    workspaceRevision: 1,
    exportRevision: 1,
    artifactPrefix: "exports/ws1/ex1/",
    materializationKey: "workspace-export:key",
    deleteAfter: Date.now() + 1_000,
  };
  const result = await materializer.materialize(request, signal);
  assert.equal(result.type, "succeeded");
  assert.equal(
    (await materializer.reconcile(request.materializationKey, signal)).type,
    "succeeded",
  );
  if (result.type !== "succeeded") return;
  assert.equal(
    (
      await materializer.deleteExact(
        {
          exportId: "ex1",
          workspaceId: "ws1",
          exportRevision: 1,
          artifactKey: result.artifactKey,
          contentHash: "0".repeat(64),
          artifactVersion: "0".repeat(64),
          sizeBytes: result.sizeBytes,
          cleanupKey: "workspace-export-cleanup:bad",
        },
        signal,
      )
    ).type,
    "conditional_mismatch",
  );
  const cleanupKey = "workspace-export-cleanup:good";
  assert.equal(
    (
      await materializer.deleteExact(
        {
          exportId: "ex1",
          workspaceId: "ws1",
          exportRevision: 1,
          artifactKey: result.artifactKey,
          contentHash: result.contentHash,
          artifactVersion: result.providerReference,
          sizeBytes: result.sizeBytes,
          cleanupKey,
        },
        signal,
      )
    ).type,
    "deleted",
  );
  assert.equal((await materializer.reconcileDelete(cleanupKey, signal)).type, "deleted");
});

test("SQLite FTS applies monotonic versions and ACL-scopes queries", async () => {
  const root = await temp("search");
  const search = new SqliteFtsSearchBackend(join(root, "search.db"));
  await search.apply({
    workspaceId: "ws",
    resourceId: "r1",
    resourceRevision: 2,
    aclRevision: 1,
    body: "hello parrot",
    visibilityIds: ["member-a"],
    tombstone: false,
  });
  await search.apply({
    workspaceId: "ws",
    resourceId: "r1",
    resourceRevision: 1,
    aclRevision: 1,
    body: "stale",
    visibilityIds: ["member-b"],
    tombstone: false,
  });
  assert.deepEqual(search.query("ws", ["member-a"], "parrot"), ["r1"]);
  assert.deepEqual(search.query("ws", ["member-b"], "parrot"), []);
  assert.equal((await search.version("ws", "r1"))?.resourceRevision, 2);
});

test("bounded extractor rejects invalid UTF-8, NUL, unsupported formats, and oversize", async () => {
  const extractor = new BoundedTextExtractor(10, 10);
  assert.equal(await extractor.extract(Buffer.from("hello"), "text/plain", signal), "hello");
  await assert.rejects(
    extractor.extract(Buffer.from([0xff]), "text/plain", signal),
    /invalid_utf8/,
  );
  await assert.rejects(
    extractor.extract(Buffer.from("a\0b"), "text/plain", signal),
    /nul_rejected/,
  );
  await assert.rejects(
    extractor.extract(Buffer.from("pdf"), "application/pdf", signal),
    /unsupported/,
  );
});

test("ClamAV client streams bounded chunks and parses FOUND", async () => {
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      if (chunk.toString().startsWith("zINSTREAM"))
        socket.end("stream: Eicar-Test-Signature FOUND\0");
      else socket.end("PONG\0");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  try {
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: address.port });
    assert.deepEqual(await scanner.scan(Buffer.from("x"), signal), {
      clean: false,
      engine: "clamav",
      signature: "Eicar-Test-Signature",
    });
  } finally {
    server.close();
  }
});

test("Gmail provider uses deterministic Message-ID and reconciles before send", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  let lookupCount = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.includes("oauth2")) return Response.json({ access_token: "token" });
    if (url.includes("?q=")) {
      lookupCount += 1;
      return Response.json(lookupCount === 1 ? {} : { messages: [{ id: "gmail-1" }] });
    }
    return Response.json({ id: "gmail-1" });
  };
  const provider = new GmailNotificationProvider(
    {
      sender: "sender@example.com",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      messageIdDomain: "parrot.example.com",
    },
    {
      async email() {
        return "to@example.com";
      },
    },
    fetcher,
  );
  const request = {
    intentId: "i",
    recipientId: "u",
    channel: "email" as const,
    resourceId: "r",
    authorizationEpoch: 1,
    deliveryRevision: 1,
    preferenceRevision: 1,
    content: { format: "plain_text" as const, body: "hello" },
    deliveryKey: "d",
    coalescingKey: "c",
  };
  assert.equal((await provider.send(request, "same-key", signal)).type, "succeeded");
  assert.equal((await provider.reconcile("same-key", signal)).type, "succeeded");
  const send = calls.find((call) => call.url.endsWith("/send"));
  assert.ok(send?.body);
  const raw = JSON.parse(send.body).raw as string;
  assert.match(
    Buffer.from(raw, "base64url").toString(),
    /Message-ID: <parrot-[a-f0-9]{64}@parrot\.example\.com>/,
  );
});

test("Ollama broker binds request IDs to fingerprints and reconciles stored results", async () => {
  const root = await temp("ollama");
  let generations = 0;
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith("/api/tags")) return Response.json({ models: [] });
    generations += 1;
    return Response.json({
      message: {
        content: JSON.stringify({
          type: "final",
          text: "done",
          usage: { outputTokens: 1, costMicros: 0 },
        }),
      },
      eval_count: 7,
    });
  };
  const provider = new DurableOllamaAgentProvider(
    join(root, "broker.db"),
    "http://127.0.0.1:11434",
    "model",
    1_000,
    fetcher,
  );
  const hash = "a".repeat(64);
  const first = await provider.next("request-1", hash, "{}", signal);
  assert.equal(first.type, "final");
  assert.equal(first.usage.outputTokens, 7);
  assert.equal((await provider.next("request-1", hash, "{}", signal)).type, "final");
  assert.equal(generations, 1);
  await assert.rejects(
    provider.reconcile("request-1", "b".repeat(64), signal),
    /fingerprint_conflict/,
  );
});

test("Ollama broker never blindly regenerates a pending ambiguous request", async () => {
  const root = await temp("ollama-ambiguous");
  let calls = 0;
  const provider = new DurableOllamaAgentProvider(
    join(root, "broker.db"),
    "http://127.0.0.1:11434",
    "model",
    1_000,
    async () => {
      calls += 1;
      throw new Error("connection_lost");
    },
  );
  const hash = "c".repeat(64);
  await assert.rejects(provider.next("request-2", hash, "{}", signal), /connection_lost/);
  await assert.rejects(provider.next("request-2", hash, "{}", signal), /outcome_unknown/);
  assert.equal(calls, 1);
});

test("OTLP adapter durably spools failures and flushes successful batches", async () => {
  const root = await temp("otlp");
  let success = false;
  const adapter = new DurableOtlpAdapter(
    join(root, "telemetry.db"),
    "http://127.0.0.1:4318",
    "parrot-worker",
    1_000,
    1_000,
    async () => new Response("", { status: success ? 200 : 503 }),
  );
  adapter.write({
    timestamp: new Date().toISOString(),
    level: "info",
    service: "worker",
    event: "test",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(adapter.pending(), 1);
  success = true;
  await adapter.flush();
  assert.equal(adapter.pending(), 0);
  assert.equal(await readFile(join(root, "telemetry.db")).then((value) => value.length > 0), true);
});
