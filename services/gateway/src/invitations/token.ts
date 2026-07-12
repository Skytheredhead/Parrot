import { createHmac, timingSafeEqual } from "node:crypto";
import type { InvitationTokenHash, InvitationTokenHasher } from "../contracts.js";

export interface InvitationHashKey {
  readonly keyId: string;
  readonly key: Uint8Array;
}

const digest = (key: Uint8Array, token: string): Buffer =>
  createHmac("sha256", key).update(token, "utf8").digest();

export class HmacInvitationTokenHasher implements InvitationTokenHasher {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "hmac-invitation-token-hasher";
  readonly #keys: readonly InvitationHashKey[];

  constructor(keys: readonly InvitationHashKey[]) {
    if (
      keys.length === 0 ||
      keys.length > 8 ||
      new Set(keys.map(({ keyId }) => keyId)).size !== keys.length ||
      keys.some(({ keyId, key }) => !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) || key.byteLength < 32)
    ) {
      throw new Error("Invitation hash keys require unique safe IDs and at least 256 bits");
    }
    this.#keys = Object.freeze(
      keys.map(({ keyId, key }) => Object.freeze({ keyId, key: Uint8Array.from(key) })),
    );
  }

  async hashForStorage(token: string): Promise<InvitationTokenHash> {
    const active = this.#keys[0];
    if (!active) throw new Error("Invitation hash key is unavailable");
    return { keyId: active.keyId, digest: digest(active.key, token).toString("base64url") };
  }

  async verificationHashes(token: string): Promise<readonly InvitationTokenHash[]> {
    return Object.freeze(
      this.#keys.map(({ keyId, key }) =>
        Object.freeze({ keyId, digest: digest(key, token).toString("base64url") }),
      ),
    );
  }

  async verify(token: string, expected: InvitationTokenHash): Promise<boolean> {
    const key = this.#keys.find(({ keyId }) => keyId === expected.keyId);
    const computed = key ? digest(key.key, token) : Buffer.alloc(32);
    const decoded = Buffer.from(expected.digest, "base64url");
    const fixedLength = Buffer.alloc(32);
    decoded.copy(fixedLength, 0, 0, Math.min(decoded.length, fixedLength.length));
    const equal = timingSafeEqual(computed, fixedLength);
    return key !== undefined && decoded.length === fixedLength.length && equal;
  }

  async ready(_signal: AbortSignal): Promise<boolean> {
    return true;
  }
}
