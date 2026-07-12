import { randomUUID } from "node:crypto";
import type {
  AuthorizationClient,
  FileMetadataStore,
  ObjectStore,
  Principal,
  UploadConstraints,
} from "../contracts.js";
import { conflict, forbidden, invalidInput, notFound, unavailable } from "../errors.js";

export interface CreateUploadInput {
  workspaceId: string;
  spaceId: string;
  displayName: string;
  declaredContentType: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface WorkspaceBudget {
  consume(principal: Principal, workspaceId: string, scope: string, cost?: number): Promise<void>;
}

function validatedExpiry(value: string, nowMs: number, maximumMs: number): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= nowMs || parsed > maximumMs + 1_000) {
    throw unavailable("Capability signer returned an invalid expiration");
  }
  return value;
}

function assertHttpsCapability(value: string, allowedOrigins: readonly string[]): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedOrigins.includes(url.origin)
  )
    throw unavailable("Capability signer returned an unsafe URL");
}

function assertUploadHeaders(
  headers: Readonly<Record<string, string>>,
  constraints: UploadConstraints,
): void {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  if (
    normalized.get("content-type") !== constraints.contentType ||
    normalized.get("content-length") !== String(constraints.sizeBytes) ||
    normalized.get("x-checksum-sha256")?.toLowerCase() !==
      constraints.checksumSha256.toLowerCase() ||
    normalized.get("if-none-match") !== "*"
  ) {
    throw unavailable("Capability signer omitted required upload bindings");
  }
}

function sameConstraints(left: UploadConstraints, right: UploadConstraints): boolean {
  return (
    left.contentType === right.contentType &&
    left.sizeBytes === right.sizeBytes &&
    left.checksumSha256 === right.checksumSha256 &&
    left.singleWrite === true &&
    right.singleWrite === true
  );
}

export class FileCapabilityService {
  constructor(
    private readonly authorization: AuthorizationClient,
    private readonly metadata: FileMetadataStore,
    private readonly objects: ObjectStore,
    private readonly budget: WorkspaceBudget,
    private readonly config: {
      uploadTtlSeconds: number;
      downloadTtlSeconds: number;
      maxUploadBytes: number;
      capabilityOrigins: readonly string[];
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createUpload(principal: Principal, input: CreateUploadInput) {
    if (input.sizeBytes <= 0 || input.sizeBytes > this.config.maxUploadBytes)
      throw invalidInput("File size is outside the allowed range");
    if (!/^[a-f0-9]{64}$/i.test(input.checksumSha256))
      throw invalidInput("A SHA-256 checksum is required");
    const hasControlCharacter = [...input.displayName].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
    if (Buffer.byteLength(input.displayName, "utf8") > 255 || hasControlCharacter)
      throw invalidInput("Display filename is invalid");
    const allowed = await this.authorization.authorize({
      principal,
      action: "file:upload",
      resource: { workspaceId: input.workspaceId, kind: "space", id: input.spaceId },
    });
    if (!allowed) throw forbidden();
    await this.budget.consume(
      principal,
      input.workspaceId,
      "file-upload",
      Math.max(1, Math.ceil(input.sizeBytes / 10_000_000)),
    );

    const nowMs = this.now().getTime();
    const expiresAt = new Date(nowMs + this.config.uploadTtlSeconds * 1_000).toISOString();
    const pending = await this.metadata.createPending({
      principal,
      reservationId: randomUUID(),
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      displayName: input.displayName,
      declaredContentType: input.declaredContentType,
      expectedBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256.toLowerCase(),
      maximumExpiresAt: expiresAt,
    });
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(pending.id) ||
      !/^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,7}$/.test(
        pending.objectKey,
      ) ||
      pending.workspaceId !== input.workspaceId ||
      pending.spaceId !== input.spaceId ||
      pending.uploaderId !== principal.id ||
      pending.displayName !== input.displayName ||
      pending.declaredContentType !== input.declaredContentType ||
      pending.expectedBytes !== input.sizeBytes ||
      pending.checksumSha256 !== input.checksumSha256.toLowerCase() ||
      pending.lifecycle !== "pending"
    ) {
      throw unavailable("File authority returned an invalid upload reservation");
    }
    const authoritativeExpiresAt = validatedExpiry(pending.expiresAt, nowMs, Date.parse(expiresAt));
    const capabilityTtlSeconds = Math.max(
      1,
      Math.floor((Date.parse(authoritativeExpiresAt) - nowMs) / 1_000),
    );
    const constraints: UploadConstraints = {
      contentType: input.declaredContentType,
      sizeBytes: input.sizeBytes,
      checksumSha256: pending.checksumSha256,
      singleWrite: true,
    };
    const capability = await this.objects.signQuarantineUpload({
      objectKey: pending.objectKey,
      constraints,
      ttlSeconds: Math.min(this.config.uploadTtlSeconds, capabilityTtlSeconds),
    });
    assertHttpsCapability(capability.url, this.config.capabilityOrigins);
    validatedExpiry(capability.expiresAt, nowMs, Date.parse(authoritativeExpiresAt));
    if (capability.method !== "PUT" || !sameConstraints(constraints, capability.constraints))
      throw unavailable("Capability signer did not bind all upload constraints");
    assertUploadHeaders(capability.requiredHeaders, constraints);
    return { uploadId: pending.id, lifecycle: "pending" as const, capability };
  }

  async completeUpload(principal: Principal, uploadId: string) {
    const pending = await this.metadata.getPending(principal, uploadId);
    if (!pending || pending.uploaderId !== principal.id) throw notFound("Upload ticket not found");
    const allowed = await this.authorization.authorize({
      principal,
      action: "file:upload",
      resource: { workspaceId: pending.workspaceId, kind: "space", id: pending.spaceId },
    });
    if (!allowed) throw notFound("Upload ticket not found");
    if (pending.lifecycle !== "pending") throw conflict("Upload is not pending");
    if (new Date(pending.expiresAt).getTime() <= this.now().getTime())
      throw conflict("Upload ticket expired");
    await this.budget.consume(principal, pending.workspaceId, "file-complete");
    const observed = await this.objects.headQuarantine(pending.objectKey);
    if (!observed) throw conflict("Quarantine object is missing");
    if (
      observed.sizeBytes !== pending.expectedBytes ||
      observed.contentType !== pending.declaredContentType ||
      observed.checksumSha256.toLowerCase() !== pending.checksumSha256 ||
      !observed.objectVersion
    ) {
      throw conflict("Uploaded object does not match the ticket");
    }
    await this.metadata.markQuarantined(principal, uploadId, {
      ...observed,
      checksumSha256: observed.checksumSha256.toLowerCase(),
    });
    return { uploadId, lifecycle: "quarantined" as const };
  }

  async createDownload(principal: Principal, fileId: string) {
    const file = await this.metadata.getFile(principal, fileId);
    if (!file || file.lifecycle === "deleted") throw notFound("File not found");
    const allowed = await this.authorization.authorize({
      principal,
      action: "file:download",
      resource: { workspaceId: file.workspaceId, kind: "file", id: file.id, spaceId: file.spaceId },
    });
    if (
      !allowed ||
      file.lifecycle !== "clean" ||
      file.immutable !== true ||
      !file.objectVersion ||
      !file.checksumSha256
    ) {
      throw notFound("File not found");
    }
    await this.budget.consume(principal, file.workspaceId, "file-download");
    const nowMs = this.now().getTime();
    const capability = await this.objects.signCleanDownload({
      objectKey: file.objectKey,
      objectVersion: file.objectVersion,
      checksumSha256: file.checksumSha256,
      displayName: file.displayName,
      contentType: file.detectedContentType,
      ttlSeconds: this.config.downloadTtlSeconds,
    });
    assertHttpsCapability(capability.url, this.config.capabilityOrigins);
    validatedExpiry(capability.expiresAt, nowMs, nowMs + this.config.downloadTtlSeconds * 1_000);
    if (capability.objectVersion !== file.objectVersion)
      throw unavailable("Capability signer did not pin the clean object version");
    return { fileId, contentType: file.detectedContentType, sizeBytes: file.sizeBytes, capability };
  }
}
