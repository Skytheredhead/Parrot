import { createHmac, timingSafeEqual } from "node:crypto";
import type { SearchCursorBinding, SearchCursorCodec } from "../contracts.js";
import { invalidInput } from "../errors.js";

interface CursorPayload extends SearchCursorBinding {
  version: 1;
  engineCursor: string;
  expiresAt: number;
}

function signature(key: Uint8Array, payload: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

export class HmacSearchCursorCodec implements SearchCursorCodec {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "hmac-search-cursor";
  constructor(private readonly keys: readonly Uint8Array[]) {
    if (keys.length === 0 || keys.some((key) => key.byteLength < 32))
      throw new Error("Search cursor keys must contain at least 256 bits");
  }

  async encode(
    input: SearchCursorBinding & { engineCursor: string; expiresAt: number },
  ): Promise<string> {
    const payload: CursorPayload = { version: 1, ...input };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signingKey = this.keys[0];
    if (!signingKey) throw new Error("Search cursor signing key is unavailable");
    return `${encoded}.${signature(signingKey, encoded).toString("base64url")}`;
  }

  async decode(
    cursor: string,
    binding: SearchCursorBinding,
    nowEpochSeconds: number,
  ): Promise<string> {
    const [payloadPart, signaturePart, extraPart] = cursor.split(".");
    if (!payloadPart || !signaturePart || extraPart !== undefined)
      throw invalidInput("Invalid search cursor");
    const actual = Buffer.from(signaturePart, "base64url");
    const valid = this.keys.some((key) => {
      const expected = signature(key, payloadPart);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    if (!valid) throw invalidInput("Invalid search cursor");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    } catch {
      throw invalidInput("Invalid search cursor");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("engineCursor" in parsed) ||
      typeof parsed.engineCursor !== "string" ||
      !parsed.engineCursor ||
      !("expiresAt" in parsed) ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= nowEpochSeconds ||
      !("principalId" in parsed) ||
      parsed.principalId !== binding.principalId ||
      !("workspaceId" in parsed) ||
      parsed.workspaceId !== binding.workspaceId ||
      !("queryHash" in parsed) ||
      parsed.queryHash !== binding.queryHash ||
      !("authzEpoch" in parsed) ||
      parsed.authzEpoch !== binding.authzEpoch
    ) {
      throw invalidInput("Search cursor is expired or belongs to another search");
    }
    return parsed.engineCursor;
  }

  async ready(_signal: AbortSignal): Promise<boolean> {
    return true;
  }
}
