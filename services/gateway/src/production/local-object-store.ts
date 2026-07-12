import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
  ObjectCapabilityDownloadGrant,
  ObjectCapabilityIngress,
  ObjectCapabilityUploadGrant,
  ObjectStore,
  UploadConstraints,
} from "../contracts.js";
import { conflict, invalidInput, notFound, unavailable } from "../errors.js";

const keyPattern =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,7}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const versionPattern = checksumPattern;
const tokenPartPattern = /^[A-Za-z0-9_-]+$/;
const capabilityPayload = z.discriminatedUnion("op", [
  z
    .object({
      v: z.literal(1),
      op: z.literal("put"),
      id: z.uuid(),
      key: z.string().min(3).max(1_024).regex(keyPattern),
      version: z.string().regex(versionPattern),
      type: z
        .string()
        .min(3)
        .max(200)
        .regex(/^[^\s/]+\/[^\s/]+$/),
      bytes: z.number().int().positive().max(5_000_000_000),
      sha256: z.string().regex(checksumPattern),
      exp: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      op: z.literal("get"),
      id: z.uuid(),
      key: z.string().min(3).max(1_024).regex(keyPattern),
      version: z.string().regex(versionPattern),
      type: z
        .string()
        .min(3)
        .max(200)
        .regex(/^[^\s/]+\/[^\s/]+$/),
      sha256: z.string().regex(checksumPattern),
      name: z.string().min(1).max(255),
      exp: z.number().int().positive(),
    })
    .strict(),
]);

type CapabilityPayload = z.infer<typeof capabilityPayload>;
type PutPayload = Extract<CapabilityPayload, { op: "put" }>;
type GetPayload = Extract<CapabilityPayload, { op: "get" }>;

interface ObjectDescriptor {
  schemaVersion: 1;
  objectKey: string;
  objectVersion: string;
  sizeBytes: number;
  contentType: string;
  checksumSha256: string;
}

export interface LocalCapabilityObjectStoreOptions {
  publicOrigin: string;
  rootDirectory: string;
  hmacSecretFile: string;
  maxUploadBytes: number;
  now?: () => Date;
}

function oneHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  return value?.length === 1 ? value[0] : undefined;
}

function assertCanonicalKey(key: string): void {
  if (!keyPattern.test(key) || key.split("/").some((part) => part === "." || part === ".."))
    throw invalidInput("Object key is not canonical");
}

function safeDisplayName(name: string): void {
  if (
    Buffer.byteLength(name, "utf8") > 255 ||
    [...name].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 0x1f || point === 0x7f);
    })
  ) {
    throw invalidInput("Display filename is invalid");
  }
}

function descriptorSchema(value: unknown): ObjectDescriptor {
  return z
    .object({
      schemaVersion: z.literal(1),
      objectKey: z.string().regex(keyPattern),
      objectVersion: z.string().regex(versionPattern),
      sizeBytes: z.number().int().nonnegative().max(5_000_000_000),
      contentType: z
        .string()
        .min(3)
        .max(200)
        .regex(/^[^\s/]+\/[^\s/]+$/),
      checksumSha256: z.string().regex(checksumPattern),
    })
    .strict()
    .refine((descriptor) => descriptor.objectVersion === descriptor.checksumSha256, {
      message: "Object version must equal its content checksum",
    })
    .parse(value);
}

export class LocalCapabilityObjectStore implements ObjectStore, ObjectCapabilityIngress {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "host-local-immutable-object-capabilities";
  private readonly uploadGrants = new WeakSet<object>();
  private readonly downloadGrants = new WeakSet<object>();
  private constructor(
    private readonly options: Required<Omit<LocalCapabilityObjectStoreOptions, "now">> & {
      now: () => Date;
    },
    private readonly secret: Buffer,
  ) {}

  static async create(
    options: LocalCapabilityObjectStoreOptions,
  ): Promise<LocalCapabilityObjectStore> {
    const origin = new URL(options.publicOrigin);
    if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin)
      throw new Error("The object capability public origin must be an exact HTTPS origin");
    if (!options.rootDirectory.startsWith("/") || !options.hmacSecretFile.startsWith("/"))
      throw new Error("Object storage and secret-file paths must be absolute");
    const secretStat = await stat(options.hmacSecretFile);
    if (!secretStat.isFile() || secretStat.size < 32 || secretStat.size > 4_096)
      throw new Error("The object capability secret file must contain 32-4096 bytes");
    const secret = Buffer.from((await readFile(options.hmacSecretFile, "utf8")).trim(), "utf8");
    if (secret.byteLength < 32) throw new Error("The object capability secret is too short");
    await mkdir(join(options.rootDirectory, "objects"), { recursive: true, mode: 0o700 });
    await mkdir(join(options.rootDirectory, "heads"), { recursive: true, mode: 0o700 });
    await mkdir(join(options.rootDirectory, "tmp"), { recursive: true, mode: 0o700 });
    for (const directory of [
      options.rootDirectory,
      join(options.rootDirectory, "objects"),
      join(options.rootDirectory, "heads"),
      join(options.rootDirectory, "tmp"),
    ]) {
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
        throw new Error("Object storage directories cannot be symbolic links");
      await chmod(directory, 0o700);
    }
    return new LocalCapabilityObjectStore(
      { ...options, now: options.now ?? (() => new Date()) },
      secret,
    );
  }

  async ready(_signal: AbortSignal): Promise<boolean> {
    try {
      const root = await stat(this.options.rootDirectory);
      return root.isDirectory();
    } catch {
      return false;
    }
  }

  async signQuarantineUpload(input: {
    objectKey: string;
    constraints: UploadConstraints;
    ttlSeconds: number;
  }) {
    assertCanonicalKey(input.objectKey);
    if (
      input.constraints.sizeBytes > this.options.maxUploadBytes ||
      !checksumPattern.test(input.constraints.checksumSha256) ||
      input.constraints.singleWrite !== true ||
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds < 1 ||
      input.ttlSeconds > 900
    )
      throw invalidInput("Upload constraints are invalid");
    const payload: PutPayload = {
      v: 1,
      op: "put",
      id: randomUUID(),
      key: input.objectKey,
      version: input.constraints.checksumSha256.toLowerCase(),
      type: input.constraints.contentType,
      bytes: input.constraints.sizeBytes,
      sha256: input.constraints.checksumSha256.toLowerCase(),
      exp: this.epochSeconds() + input.ttlSeconds,
    };
    const token = this.sign(payload);
    return {
      url: `${this.options.publicOrigin}/v1/object-capabilities/upload/${token}`,
      method: "PUT" as const,
      expiresAt: new Date(payload.exp * 1_000).toISOString(),
      requiredHeaders: {
        "content-type": payload.type,
        "content-length": String(payload.bytes),
        "x-checksum-sha256": payload.sha256,
        "if-none-match": "*",
      },
      constraints: { ...input.constraints, checksumSha256: payload.sha256 },
    };
  }

  async headQuarantine(objectKey: string) {
    const descriptor = await this.readDescriptor(objectKey);
    return descriptor && (objectKey.startsWith("quarantine/") || objectKey.startsWith("uploads/"))
      ? {
          sizeBytes: descriptor.sizeBytes,
          contentType: descriptor.contentType,
          objectVersion: descriptor.objectVersion,
          checksumSha256: descriptor.checksumSha256,
        }
      : null;
  }

  async signCleanDownload(input: {
    objectKey: string;
    objectVersion: string;
    checksumSha256: string;
    displayName: string;
    contentType: string;
    ttlSeconds: number;
  }) {
    assertCanonicalKey(input.objectKey);
    safeDisplayName(input.displayName);
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 120)
      throw invalidInput("Download capability lifetime is invalid");
    const descriptor = await this.readDescriptor(input.objectKey);
    if (
      !descriptor ||
      descriptor.objectVersion !== input.objectVersion ||
      descriptor.checksumSha256 !== input.checksumSha256.toLowerCase() ||
      descriptor.contentType !== input.contentType
    )
      throw notFound("Object version not found");
    const payload: GetPayload = {
      v: 1,
      op: "get",
      id: randomUUID(),
      key: input.objectKey,
      version: input.objectVersion,
      type: input.contentType,
      sha256: input.checksumSha256.toLowerCase(),
      name: input.displayName,
      exp: this.epochSeconds() + input.ttlSeconds,
    };
    return {
      url: `${this.options.publicOrigin}/v1/object-capabilities/download/${this.sign(payload)}`,
      expiresAt: new Date(payload.exp * 1_000).toISOString(),
      objectVersion: input.objectVersion,
    };
  }

  async authorizeUpload(input: {
    token: string;
    method: string;
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  }): Promise<ObjectCapabilityUploadGrant> {
    const payload = this.verify(input.token);
    if (payload.op !== "put" || input.method !== "PUT") throw notFound();
    const contentLength = oneHeader(input.headers, "content-length");
    const contentType = oneHeader(input.headers, "content-type");
    const checksum = oneHeader(input.headers, "x-checksum-sha256")?.toLowerCase();
    const ifNoneMatch = oneHeader(input.headers, "if-none-match");
    if (
      contentLength !== String(payload.bytes) ||
      contentType !== payload.type ||
      checksum !== payload.sha256 ||
      ifNoneMatch !== "*" ||
      input.headers["transfer-encoding"] !== undefined ||
      input.headers["content-encoding"] !== undefined
    )
      throw invalidInput("Upload headers do not match the capability");
    const grant = Object.freeze({
      capabilityId: payload.id,
      objectKey: payload.key,
      objectVersion: payload.version,
      contentType: payload.type,
      sizeBytes: payload.bytes,
      checksumSha256: payload.sha256,
      expiresAtEpochSeconds: payload.exp,
    });
    this.uploadGrants.add(grant);
    return grant;
  }

  async consumeUpload(input: {
    grant: ObjectCapabilityUploadGrant;
    body: AsyncIterable<Uint8Array>;
  }) {
    if (!this.uploadGrants.has(input.grant)) throw notFound();
    if (input.grant.expiresAtEpochSeconds <= this.epochSeconds()) throw notFound();
    const tempPath = join(this.options.rootDirectory, "tmp", `${input.grant.capabilityId}.part`);
    const handle = await open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw conflict("Upload capability is already in use");
      throw error;
    });
    let bytes = 0;
    const hash = createHash("sha256");
    const iterator = input.body[Symbol.asyncIterator]();
    try {
      while (true) {
        const remainingMs =
          input.grant.expiresAtEpochSeconds * 1_000 - this.options.now().getTime();
        if (remainingMs <= 0) throw notFound();
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          iterator.next(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(notFound()), remainingMs);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        if (result.done) break;
        const chunk = result.value;
        if (!(chunk instanceof Uint8Array)) throw invalidInput("Upload body is invalid");
        bytes += chunk.byteLength;
        if (bytes > input.grant.sizeBytes) throw invalidInput("Upload exceeds its signed size");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten <= 0) throw unavailable("Object storage stopped accepting bytes");
          offset += bytesWritten;
        }
      }
      await handle.sync();
    } catch (error) {
      void iterator.return?.().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await rm(tempPath, { force: true });
      throw error;
    }
    await handle.close();
    const checksumSha256 = hash.digest("hex");
    if (bytes !== input.grant.sizeBytes || checksumSha256 !== input.grant.checksumSha256) {
      await rm(tempPath, { force: true });
      throw invalidInput("Upload body does not match its signed size and checksum");
    }
    const versionPath = this.versionPath(input.grant.objectKey, input.grant.objectVersion);
    const descriptorPath = this.descriptorPath(input.grant.objectKey);
    const descriptorTempPath = join(
      this.options.rootDirectory,
      "tmp",
      `${input.grant.capabilityId}.json`,
    );
    await mkdir(dirname(versionPath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(descriptorPath), { recursive: true, mode: 0o700 });
    let versionLinked = false;
    try {
      // Link is non-overwriting and therefore preserves immutable versions under races.
      await link(tempPath, versionPath);
      versionLinked = true;
      const descriptor: ObjectDescriptor = {
        schemaVersion: 1,
        objectKey: input.grant.objectKey,
        objectVersion: input.grant.objectVersion,
        sizeBytes: bytes,
        contentType: input.grant.contentType,
        checksumSha256,
      };
      const descriptorHandle = await open(
        descriptorTempPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await descriptorHandle.writeFile(JSON.stringify(descriptor));
        await descriptorHandle.sync();
      } finally {
        await descriptorHandle.close();
      }
      // Publishing a fully-synced descriptor through link is exclusive and non-overwriting.
      await link(descriptorTempPath, descriptorPath);
    } catch (error) {
      if (versionLinked) await rm(versionPath, { force: true });
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw conflict("Object key is immutable and already exists");
      throw error;
    } finally {
      await rm(tempPath, { force: true });
      await rm(descriptorTempPath, { force: true });
    }
    return { objectVersion: input.grant.objectVersion, checksumSha256, sizeBytes: bytes };
  }

  async authorizeDownload(input: {
    token: string;
    method: string;
  }): Promise<ObjectCapabilityDownloadGrant> {
    const payload = this.verify(input.token);
    if (payload.op !== "get" || input.method !== "GET") throw notFound();
    const grant = Object.freeze({
      capabilityId: payload.id,
      objectKey: payload.key,
      objectVersion: payload.version,
      contentType: payload.type,
      checksumSha256: payload.sha256,
      displayName: payload.name,
      expiresAtEpochSeconds: payload.exp,
    });
    this.downloadGrants.add(grant);
    return grant;
  }

  async openDownload(input: { grant: ObjectCapabilityDownloadGrant }) {
    if (!this.downloadGrants.has(input.grant)) throw notFound();
    if (input.grant.expiresAtEpochSeconds <= this.epochSeconds()) throw notFound();
    const descriptor = await this.readDescriptor(input.grant.objectKey);
    if (
      !descriptor ||
      descriptor.objectVersion !== input.grant.objectVersion ||
      descriptor.checksumSha256 !== input.grant.checksumSha256 ||
      descriptor.contentType !== input.grant.contentType
    )
      throw notFound();
    const objectPath = this.versionPath(input.grant.objectKey, input.grant.objectVersion);
    const handle = await open(objectPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const objectStat = await handle.stat();
    if (!objectStat.isFile() || objectStat.size !== descriptor.sizeBytes) {
      await handle.close();
      throw unavailable("Object integrity check failed");
    }
    return {
      body: handle.createReadStream(),
      sizeBytes: descriptor.sizeBytes,
      checksumSha256: descriptor.checksumSha256,
      contentType: descriptor.contentType,
      displayName: input.grant.displayName,
      objectVersion: descriptor.objectVersion,
    };
  }

  private epochSeconds(): number {
    return Math.floor(this.options.now().getTime() / 1_000);
  }

  private sign(payload: CapabilityPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}${signature}`;
  }

  private verify(token: string): CapabilityPayload {
    // HMAC-SHA256 is always 43 unpadded base64url characters.
    if (token.length <= 43) throw notFound();
    const encoded = token.slice(0, -43);
    const signature = token.slice(-43);
    if (!tokenPartPattern.test(encoded) || !tokenPartPattern.test(signature)) throw notFound();
    const expected = createHmac("sha256", this.secret).update(encoded).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      throw notFound();
    }
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected))
      throw notFound();
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw notFound();
    }
    const parsed = capabilityPayload.safeParse(decoded);
    if (!parsed.success || parsed.data.exp <= this.epochSeconds()) throw notFound();
    return parsed.data;
  }

  private keyHash(key: string): string {
    assertCanonicalKey(key);
    return createHash("sha256").update(key).digest("hex");
  }

  private descriptorPath(key: string): string {
    const hash = this.keyHash(key);
    return join(this.options.rootDirectory, "heads", hash.slice(0, 2), `${hash}.json`);
  }

  private versionPath(key: string, version: string): string {
    if (!versionPattern.test(version)) throw invalidInput("Object version is invalid");
    const hash = this.keyHash(key);
    return join(this.options.rootDirectory, "objects", hash.slice(0, 2), hash, version);
  }

  private async readDescriptor(key: string): Promise<ObjectDescriptor | null> {
    try {
      const raw = await readFile(this.descriptorPath(key), "utf8");
      const descriptor = descriptorSchema(JSON.parse(raw));
      return descriptor.objectKey === key ? descriptor : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError || error instanceof z.ZodError)
        throw unavailable("Object metadata is corrupt");
      throw error;
    }
  }
}
