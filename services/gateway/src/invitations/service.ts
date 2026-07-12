import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  InvitationRole,
  InvitationStore,
  InvitationTokenHash,
  InvitationTokenHasher,
  Principal,
} from "../contracts.js";
import { GatewayError, forbidden, invalidInput, unavailable } from "../errors.js";

const TOKEN_VERSION = "inv1";
const TOKEN_SECRET_BYTES = 32;
const MIN_EXPIRY_SECONDS = 5 * 60;
const MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
const MAX_USE_LIMIT = 100;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenPattern = new RegExp(
  `^inv1\\.(${uuidV4Pattern.source.slice(1, -1)})\\.([A-Za-z0-9_-]{43})$`,
);
const emailSchema = z.email().max(254);

export interface CreateInvitationInput {
  workspaceId: string;
  role: InvitationRole;
  spaceIds: readonly string[];
  email?: string;
  expiresInSeconds: number;
  useLimit: number;
}

export function normalizeInvitationEmail(value: string): string {
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (!emailSchema.safeParse(normalized).success) throw invalidInput("Invitation email is invalid");
  return normalized;
}

const unavailableInvitation = () =>
  new GatewayError(404, "invitation_unavailable", "Invitation is unavailable");

export class InvitationService {
  constructor(
    private readonly tokens: InvitationTokenHasher,
    private readonly store: InvitationStore,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly entropy: (size: number) => Uint8Array = randomBytes,
  ) {}

  async create(principal: Principal, input: CreateInvitationInput, requestId: string) {
    if (principal.kind !== "human") throw forbidden();
    if (
      !Number.isSafeInteger(input.expiresInSeconds) ||
      input.expiresInSeconds < MIN_EXPIRY_SECONDS ||
      input.expiresInSeconds > MAX_EXPIRY_SECONDS ||
      !Number.isSafeInteger(input.useLimit) ||
      input.useLimit < 1 ||
      input.useLimit > MAX_USE_LIMIT
    ) {
      throw invalidInput("Invitation limits are invalid");
    }
    const invitationId = this.createId();
    if (!uuidV4Pattern.test(invitationId)) throw unavailable("Invitation ID generation failed");
    const secret = this.entropy(TOKEN_SECRET_BYTES);
    if (secret.byteLength !== TOKEN_SECRET_BYTES)
      throw unavailable("Invitation entropy generation failed");
    const token = `${TOKEN_VERSION}.${invitationId}.${Buffer.from(secret).toString("base64url")}`;
    const tokenHash = await this.tokens.hashForStorage(token);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + input.expiresInSeconds * 1_000);
    const spaceIds = Object.freeze([...new Set(input.spaceIds)].sort());
    await this.store.createAtomic({
      invitationId,
      workspaceId: input.workspaceId,
      role: input.role,
      spaceIds,
      ...(input.email === undefined
        ? {}
        : { normalizedEmail: normalizeInvitationEmail(input.email) }),
      creator: principal,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      useLimit: input.useLimit,
      tokenHash,
      requestId,
    });
    return {
      invitationId,
      token,
      expiresAt: expiresAt.toISOString(),
      useLimit: input.useLimit,
    };
  }

  async redeem(principal: Principal, token: string, requestId: string) {
    if (principal.kind !== "human" || principal.emailVerified !== true || !principal.email) {
      throw unavailableInvitation();
    }
    const parsed = tokenPattern.exec(token);
    if (!parsed?.[1]) throw unavailableInvitation();
    let verificationHashes: readonly InvitationTokenHash[];
    try {
      verificationHashes = await this.tokens.verificationHashes(token);
    } catch {
      throw unavailableInvitation();
    }
    if (
      verificationHashes.length === 0 ||
      verificationHashes.length > 8 ||
      verificationHashes.some(
        ({ keyId, digest }) =>
          !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) || !/^[A-Za-z0-9_-]{43}$/.test(digest),
      )
    ) {
      throw unavailableInvitation();
    }
    let normalizedVerifiedEmail: string;
    try {
      normalizedVerifiedEmail = normalizeInvitationEmail(principal.email);
    } catch {
      throw unavailableInvitation();
    }
    const result = await this.store.redeemAtomic({
      invitationId: parsed[1],
      verificationHashes,
      principal,
      normalizedVerifiedEmail,
      now: this.now().toISOString(),
      requestId,
    });
    if (result.status !== "accepted") throw unavailableInvitation();
    return result;
  }
}
