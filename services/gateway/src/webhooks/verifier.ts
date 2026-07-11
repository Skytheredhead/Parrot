import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookSignatureVerifier, WebhookVerificationRequest } from "../contracts.js";
import { forbidden, invalidInput } from "../errors.js";

function header(headers: WebhookVerificationRequest["headers"], name: string): string {
  const value = headers[name];
  const selected = Array.isArray(value) ? value[0] : value;
  if (!selected) throw invalidInput(`Missing ${name} header`);
  return selected;
}

export class HmacSha256WebhookVerifier implements WebhookSignatureVerifier {
  constructor(private readonly keys: readonly Uint8Array[]) {
    if (keys.length === 0 || keys.some((key) => key.byteLength < 32))
      throw new Error("Webhook HMAC keys must contain at least 256 bits");
  }

  async verify(input: WebhookVerificationRequest): Promise<{ eventId: string }> {
    const eventId = header(input.headers, "x-webhook-id");
    const timestamp = header(input.headers, "x-webhook-timestamp");
    const signatureHeader = header(input.headers, "x-webhook-signature");
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(eventId)) throw invalidInput("Invalid webhook event ID");
    if (!/^\d{10}$/.test(timestamp)) throw invalidInput("Invalid webhook timestamp");
    const timestampMs = Number(timestamp) * 1_000;
    if (Math.abs(input.receivedAt.getTime() - timestampMs) > input.maxSkewSeconds * 1_000) {
      throw forbidden("Webhook timestamp is outside the accepted window");
    }
    const supplied = signatureHeader
      .split(",")
      .map((part) => /^v1=([a-f0-9]{64})$/i.exec(part.trim())?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => Buffer.from(value, "hex"));
    if (supplied.length === 0) throw invalidInput("Invalid webhook signature format");
    const prefix = Buffer.from(`${timestamp}.${eventId}.`, "utf8");
    const expected = this.keys.map((key) =>
      createHmac("sha256", key).update(prefix).update(input.body).digest(),
    );
    const valid = expected.some((candidate) =>
      supplied.some(
        (actual) => actual.length === candidate.length && timingSafeEqual(actual, candidate),
      ),
    );
    if (!valid) throw forbidden("Webhook signature is invalid");
    return { eventId };
  }
}
