import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const mode = process.argv[2];
const smokeId = process.env.PARROT_OBJECT_SMOKE_ID;
if (!smokeId || !/^[a-z0-9-]{8,64}$/.test(smokeId)) throw new Error("invalid smoke id");

const source = Buffer.from(`parrot deployed object smoke ${smokeId}`);
const checksum = createHash("sha256").update(source).digest("hex");
const sourceKey = `uploads/smoke-${smokeId}/source/1`;
const cleanKey = `clean/smoke-${smokeId}/1`;
const signal = new AbortController().signal;

if (mode === "gateway-upload" || mode === "gateway-download") {
  const { LocalCapabilityObjectStore } = await import(
    "file:///app/dist/production/local-object-store.js"
  );
  const gateway = await LocalCapabilityObjectStore.create({
    publicOrigin: "https://parrotapi.skylarenns.com",
    rootDirectory: "/var/lib/parrot/objects",
    hmacSecretFile: "/run/secrets/parrot_object_capability_hmac",
    maxUploadBytes: 1_024,
  });
  if (mode === "gateway-upload") {
    const upload = await gateway.signQuarantineUpload({
      objectKey: sourceKey,
      constraints: {
        contentType: "text/plain",
        sizeBytes: source.byteLength,
        checksumSha256: checksum,
        singleWrite: true,
      },
      ttlSeconds: 60,
    });
    const token = upload.url.split("/").at(-1);
    const grant = await gateway.authorizeUpload({
      token,
      method: "PUT",
      headers: upload.requiredHeaders,
    });
    await gateway.consumeUpload({
      grant,
      body: (async function* () {
        yield source;
      })(),
    });
  } else {
    const download = await gateway.signCleanDownload({
      objectKey: cleanKey,
      objectVersion: checksum,
      checksumSha256: checksum,
      displayName: "parrot-smoke.txt",
      contentType: "text/plain",
      ttlSeconds: 60,
    });
    const grant = await gateway.authorizeDownload({
      token: download.url.split("/").at(-1),
      method: "GET",
    });
    const opened = await gateway.openDownload({ grant });
    const chunks = [];
    for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
    assert.equal(opened.contentType, "text/plain");
    assert.deepEqual(Buffer.concat(chunks), source);
  }
} else if (mode === "worker-scan" || mode === "worker-cleanup") {
  const { ClamAvScanner, FileProcessingHandler, FilesystemObjectStore, newJob } = await import(
    "file:///app/dist/index.js"
  );
  const store = new FilesystemObjectStore("/var/lib/parrot/objects", 1_024);
  if (mode === "worker-cleanup") {
    assert.equal(await store.deleteIfMatch(sourceKey, checksum, signal), true);
    assert.equal(await store.deleteIfMatch(cleanKey, checksum, signal), true);
  } else {
    const plan = {
      workspaceId: `smoke-${smokeId}`,
      fileId: `file-${smokeId}`,
      version: 1,
      sourceKey,
      cleanDestinationKey: cleanKey,
      allowedTypes: ["text/plain"],
      maxBytes: 1_024,
      maxExtractedCharacters: 1_024,
    };
    let markedClean;
    const handler = new FileProcessingHandler(
      store,
      new ClamAvScanner({ socketPath: "/run/clamav/clamd.sock", maxBytes: 1_024 }),
      {
        adapterKind: "durable",
        adapterName: "deployed-smoke-unused-extractor",
        async extract() {
          throw new Error("extractor unexpectedly called");
        },
      },
      {
        adapterKind: "durable",
        adapterName: "deployed-smoke-authority",
        async plan() {
          return plan;
        },
        async detectedType() {
          return "text/plain";
        },
        async markClean(_plan, version) {
          markedClean = version;
        },
        async markRejected() {
          throw new Error("clean smoke object rejected");
        },
        async recordExtractedText() {},
        async claimDeletion() {
          return undefined;
        },
        async finalizeDeletion() {},
        async releaseDeletion() {},
        async pendingDeletionClaims() {
          return [];
        },
        async recordOrphanDiscrepancy() {},
        async reconcile() {
          return { type: "not_found" };
        },
      },
    );
    const job = newJob(
      {
        id: `scan-${smokeId}`,
        workspaceId: plan.workspaceId,
        kind: "file.scan",
        effectKey: `scan-${smokeId}:1`,
        payload: { fileId: plan.fileId, version: 1, objectKey: sourceKey },
      },
      0,
    );
    const result = await handler.execute(job, job.effectKey, signal);
    assert.equal(result.type, "succeeded");
    assert.equal(markedClean, checksum);
  }
} else {
  throw new Error("expected gateway-upload, worker-scan, gateway-download, or worker-cleanup");
}

console.log(`${mode} passed`);
