import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCapabilityObjectStore } from "../services/gateway/dist/index.js";
import {
  FileProcessingHandler,
  FilesystemObjectStore,
  newJob,
} from "../services/worker/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "parrot-shared-objects-"));
try {
  const secret = join(root, "capability-secret");
  await writeFile(secret, "shared-object-contract-secret-at-least-32-bytes", { mode: 0o400 });
  const objectsRoot = join(root, "objects");
  const gateway = await LocalCapabilityObjectStore.create({
    publicOrigin: "https://parrotapi.skylarenns.com",
    rootDirectory: objectsRoot,
    hmacSecretFile: secret,
    maxUploadBytes: 1_024,
  });
  const worker = new FilesystemObjectStore(objectsRoot, 1_024);
  assert.equal(await worker.ready(), true);

  const source = Buffer.from("parrot upload to scan to download");
  const checksum = createHash("sha256").update(source).digest("hex");
  const upload = await gateway.signQuarantineUpload({
    objectKey:
      "uploads/018f1000-0000-7000-8000-000000000001/018f1000-0000-7000-8000-000000000002/1",
    constraints: {
      contentType: "text/plain",
      sizeBytes: source.byteLength,
      checksumSha256: checksum,
      singleWrite: true,
    },
    ttlSeconds: 300,
  });
  const uploadToken = upload.url.split("/").at(-1);
  assert.ok(uploadToken);
  const grant = await gateway.authorizeUpload({
    token: uploadToken,
    method: "PUT",
    headers: upload.requiredHeaders,
  });
  await gateway.consumeUpload({
    grant,
    body: (async function* () {
      yield source;
    })(),
  });

  const scanned = [];
  for await (const chunk of worker.readStream(grant.objectKey, new AbortController().signal))
    scanned.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(scanned), source);

  const cleanKey = "clean/018f1000-0000-7000-8000-000000000002/1";
  const plan = {
    workspaceId: "018f1000-0000-7000-8000-000000000001",
    fileId: "018f1000-0000-7000-8000-000000000002",
    version: 1,
    sourceKey: grant.objectKey,
    cleanDestinationKey: cleanKey,
    allowedTypes: ["text/plain"],
    maxBytes: 1_024,
    maxExtractedCharacters: 1_024,
  };
  let cleanVersion;
  const authority = {
    adapterKind: "durable",
    adapterName: "shared-contract-authority",
    async plan() {
      return plan;
    },
    async detectedType() {
      return "text/plain";
    },
    async markClean(_plan, objectVersion) {
      cleanVersion = objectVersion;
    },
    async markRejected() {
      throw new Error("shared contract unexpectedly rejected the clean object");
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
  };
  const handler = new FileProcessingHandler(
    worker,
    {
      adapterKind: "durable",
      adapterName: "shared-contract-scanner",
      async scan() {
        return { clean: true, engine: "contract-test" };
      },
    },
    {
      adapterKind: "durable",
      adapterName: "shared-contract-extractor",
      async extract() {
        throw new Error("extractor must not run during scan");
      },
    },
    authority,
  );
  const scanJob = newJob(
    {
      id: "shared-object-contract-scan",
      workspaceId: plan.workspaceId,
      kind: "file.scan",
      effectKey: "shared-object-contract-scan:1",
      payload: {
        fileId: plan.fileId,
        version: plan.version,
        objectKey: plan.sourceKey,
      },
    },
    0,
  );
  assert.deepEqual(
    await handler.execute(scanJob, scanJob.effectKey, new AbortController().signal),
    {
      type: "succeeded",
      result: { fileId: plan.fileId, version: plan.version, cleanKey: checksum },
    },
  );
  assert.equal(cleanVersion, checksum);
  const download = await gateway.signCleanDownload({
    objectKey: cleanKey,
    objectVersion: cleanVersion,
    checksumSha256: checksum,
    displayName: "scan.txt",
    contentType: "text/plain",
    ttlSeconds: 60,
  });
  const downloadToken = download.url.split("/").at(-1);
  assert.ok(downloadToken);
  const downloadGrant = await gateway.authorizeDownload({
    token: downloadToken,
    method: "GET",
  });
  const opened = await gateway.openDownload({ grant: downloadGrant });
  const downloaded = [];
  for await (const chunk of opened.body) downloaded.push(Buffer.from(chunk));
  assert.equal(opened.contentType, "text/plain");
  assert.deepEqual(Buffer.concat(downloaded), source);
  console.log("Shared upload-scan-download object contract passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
