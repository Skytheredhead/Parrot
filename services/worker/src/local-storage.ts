import { createHash, timingSafeEqual } from "node:crypto";
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ObjectStore, ObjectVersion } from "./adapters.js";
import type {
  WorkspaceExportCleanupRequest,
  WorkspaceExportDeleteReconciliation,
  WorkspaceExportDeleteResult,
  WorkspaceExportMaterializationRequest,
  WorkspaceExportMaterializationResult,
  WorkspaceExportMaterializer,
  WorkspaceExportReconciliationResult,
} from "./workspace-export.js";

const SAFE_KEY =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,31}$/;
const HASH = /^[a-f0-9]{64}$/;

const ensureKey = (key: string): string => {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.includes("\\"))
    throw new Error("object_key_invalid");
  return key;
};

const within = (root: string, key: string): string => {
  const path = resolve(root, ensureKey(key));
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("object_key_invalid");
  return path;
};

const aborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Immutable, content-address-checked object operations rooted below one private directory. */
export class FilesystemObjectStore implements ObjectStore {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "filesystem-object-store";
  private readonly root: string;

  constructor(
    root: string,
    private readonly maxBytes = 1_073_741_824,
  ) {
    if (!root.startsWith("/") || maxBytes < 1 || !Number.isSafeInteger(maxBytes))
      throw new Error("object_store_config_invalid");
    this.root = resolve(root);
  }

  assertProductionReady(): boolean {
    return this.root !== "/" && this.maxBytes > 0;
  }

  async ready(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await access(this.root, constants.R_OK | constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async *readStream(key: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    aborted(signal);
    const handle = await open(within(this.root, key), "r");
    let total = 0;
    try {
      for await (const chunk of handle.createReadStream({ highWaterMark: 64 * 1024, signal })) {
        total += chunk.length;
        if (total > this.maxBytes) throw new Error("object_too_large");
        yield new Uint8Array(chunk);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async writeClean(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    aborted(signal);
    if (bytes.byteLength > this.maxBytes) throw new Error("object_too_large");
    const destination = within(this.root, key);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const version = sha256(bytes);
    try {
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600, signal });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(destination, { signal });
      const existingHash = sha256(existing);
      if (!timingSafeEqual(Buffer.from(existingHash), Buffer.from(version)))
        throw new Error("immutable_object_conflict");
    }
    return version;
  }

  async stat(key: string, signal: AbortSignal): Promise<ObjectVersion | undefined> {
    aborted(signal);
    try {
      return { versionTag: sha256(await readFile(within(this.root, key), { signal })) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async deleteIfMatch(key: string, versionTag: string, signal: AbortSignal): Promise<boolean> {
    aborted(signal);
    if (!HASH.test(versionTag)) throw new Error("object_version_invalid");
    const path = within(this.root, key);
    let actual: string;
    try {
      actual = sha256(await readFile(path, { signal }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (!timingSafeEqual(Buffer.from(actual), Buffer.from(versionTag))) return false;
    await rm(path, { force: true });
    return true;
  }

  async *list(prefix: string, signal: AbortSignal): AsyncIterable<string> {
    aborted(signal);
    const safePrefix = ensureKey(prefix);
    const base = within(this.root, safePrefix);
    const pending = [base];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      let entries: Dirent[];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        aborted(signal);
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) yield relative(this.root, path).split(sep).join("/");
      }
    }
  }
}

export interface WorkspaceExportSource {
  stream(
    request: WorkspaceExportMaterializationRequest,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}

/** Atomic export writer with a durable sidecar receipt for crash reconciliation. */
export class FilesystemWorkspaceExportMaterializer implements WorkspaceExportMaterializer {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "filesystem-workspace-export-materializer";
  private readonly root: string;
  constructor(
    root: string,
    private readonly source: WorkspaceExportSource,
    private readonly maxBytes = 1_099_511_627_776,
  ) {
    if (!root.startsWith("/") || typeof source.stream !== "function")
      throw new Error("export_materializer_config_invalid");
    this.root = resolve(root);
  }
  assertProductionReady(): boolean {
    return this.root !== "/" && this.maxBytes > 0;
  }
  async ready(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await access(this.root, constants.R_OK | constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private receipt(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return within(this.root, `receipts/${digest}.json`);
  }

  async materialize(
    request: WorkspaceExportMaterializationRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceExportMaterializationResult> {
    aborted(signal);
    const existing = await this.reconcile(request.materializationKey, signal);
    if (existing.type === "succeeded") return existing;
    const artifactKey = `${request.artifactPrefix}export.jsonl`;
    const artifact = within(this.root, artifactKey);
    const receipt = this.receipt(request.materializationKey);
    await mkdir(dirname(artifact), { recursive: true, mode: 0o700 });
    await mkdir(dirname(receipt), { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(artifact, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return { type: "outcome_unknown", code: "connection_lost_after_write" };
      return { type: "transient_failure", code: "provider_unavailable", retryAfterMs: 1_000 };
    }
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const chunk of this.source.stream(request, signal)) {
        aborted(signal);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > this.maxBytes) {
          await handle.close();
          await rm(artifact, { force: true });
          return { type: "permanent_failure", code: "artifact_too_large" };
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      const contentHash = hash.digest("hex");
      const providerReference = contentHash;
      await writeFile(
        receipt,
        JSON.stringify({
          artifactKey,
          contentHash,
          sizeBytes,
          providerReference,
          deleteAfter: request.deleteAfter,
        }),
        { flag: "wx", mode: 0o600 },
      );
      return { type: "succeeded", artifactKey, contentHash, sizeBytes, providerReference };
    } catch (error) {
      await handle.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const reconciled = await this.reconcile(request.materializationKey, signal);
        return reconciled.type === "succeeded"
          ? reconciled
          : { type: "outcome_unknown", code: "connection_lost_after_write" };
      }
      if (signal.aborted) return { type: "outcome_unknown", code: "provider_timeout" };
      return { type: "outcome_unknown", code: "connection_lost_after_write" };
    }
  }

  async reconcile(key: string, signal: AbortSignal): Promise<WorkspaceExportReconciliationResult> {
    aborted(signal);
    try {
      const value = JSON.parse(await readFile(this.receipt(key), "utf8")) as Record<
        string,
        unknown
      >;
      const bytes = await readFile(within(this.root, String(value.artifactKey)), { signal });
      if (sha256(bytes) !== value.contentHash || bytes.byteLength !== value.sizeBytes)
        return { type: "unknown" };
      return {
        type: "succeeded",
        artifactKey: String(value.artifactKey),
        contentHash: String(value.contentHash),
        sizeBytes: Number(value.sizeBytes),
        providerReference: String(value.providerReference),
      };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { type: "not_found" }
        : { type: "unknown" };
    }
  }

  async deleteExact(
    request: WorkspaceExportCleanupRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceExportDeleteResult> {
    aborted(signal);
    const path = within(this.root, request.artifactKey);
    const cleanupReceipt = this.receipt(request.cleanupKey);
    try {
      const bytes = await readFile(path, { signal });
      if (
        sha256(bytes) !== request.contentHash ||
        request.artifactVersion !== request.contentHash ||
        bytes.byteLength !== request.sizeBytes
      )
        return { type: "conditional_mismatch" };
      await rm(path);
      await mkdir(dirname(cleanupReceipt), { recursive: true, mode: 0o700 });
      await writeFile(cleanupReceipt, "deleted", { flag: "wx", mode: 0o600 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      return { type: "deleted" };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { type: "not_found" }
        : { type: "transient_failure", code: "provider_unavailable", retryAfterMs: 1_000 };
    }
  }
  async reconcileDelete(
    requestKey: string,
    signal: AbortSignal,
  ): Promise<WorkspaceExportDeleteReconciliation> {
    aborted(signal);
    try {
      await stat(this.receipt(requestKey));
      return { type: "deleted" };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { type: "unknown" }
        : { type: "unknown" };
    }
  }
}
