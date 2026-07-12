import { createHash } from "node:crypto";
import type {
  NotificationProvider,
  NotificationProviderResult,
  NotificationReconciliationResult,
  NotificationRequest,
} from "./adapters.js";

export interface GmailOAuthConfig {
  readonly sender: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly messageIdDomain: string;
  readonly timeoutMs?: number;
}

export interface NotificationRecipientResolver {
  email(recipientId: string, signal: AbortSignal): Promise<string | undefined>;
}
type Fetch = typeof globalThis.fetch;
const EMAIL =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

/** Gmail API delivery with a deterministic RFC Message-ID as its provider idempotency anchor. */
export class GmailNotificationProvider implements NotificationProvider {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "gmail-api-notification-provider";
  private readonly timeoutMs: number;
  constructor(
    private readonly config: GmailOAuthConfig,
    private readonly recipients: NotificationRecipientResolver,
    private readonly fetcher: Fetch = fetch,
  ) {
    this.timeoutMs = config.timeoutMs ?? 15_000;
    if (
      !EMAIL.test(config.sender) ||
      !/^[A-Za-z0-9.-]{1,253}$/.test(config.messageIdDomain) ||
      !config.clientId ||
      !config.clientSecret ||
      !config.refreshToken ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 60_000
    )
      throw new Error("gmail_config_invalid");
  }
  assertProductionReady(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.refreshToken);
  }
  async ready(): Promise<boolean> {
    try {
      await this.accessToken(AbortSignal.timeout(Math.min(this.timeoutMs, 2_000)));
      return true;
    } catch {
      return false;
    }
  }
  private messageId(key: string): string {
    return `<parrot-${createHash("sha256").update(key).digest("hex")}@${this.config.messageIdDomain}>`;
  }
  private async accessToken(signal: AbortSignal): Promise<string> {
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (!response.ok)
      throw new Error(
        response.status === 429 || response.status >= 500
          ? "gmail_transient"
          : "gmail_auth_rejected",
      );
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length > 8_192)
      throw new Error("gmail_token_invalid");
    return body.access_token;
  }
  private async lookup(
    key: string,
    signal: AbortSignal,
  ): Promise<NotificationReconciliationResult> {
    const token = await this.accessToken(signal);
    const query = encodeURIComponent(`rfc822msgid:${this.messageId(key)}`);
    const response = await this.fetcher(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=2`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      },
    );
    if (!response.ok) return { type: "unknown" };
    const body = (await response.json()) as { messages?: Array<{ id?: unknown }> };
    const id = body.messages?.[0]?.id;
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id)
      ? { type: "succeeded", providerReference: id }
      : { type: "not_found" };
  }
  async send(
    request: NotificationRequest,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<NotificationProviderResult> {
    if (request.channel !== "email")
      return { type: "permanent_failure", code: "channel_unavailable" };
    try {
      const existing = await this.lookup(idempotencyKey, signal);
      if (existing.type === "succeeded") return existing;
      const recipient = await this.recipients.email(request.recipientId, signal);
      if (!recipient || !EMAIL.test(recipient))
        return { type: "permanent_failure", code: "invalid_recipient" };
      const messageId = this.messageId(idempotencyKey);
      const subject =
        request.channel === "email" ? "New activity in Parrot" : "Parrot notification";
      const raw = [
        `From: ${this.config.sender}`,
        `To: ${recipient}`,
        `Subject: ${subject}`,
        `Message-ID: ${messageId}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        request.content.body,
      ].join("\r\n");
      const token = await this.accessToken(signal);
      const response = await this.fetcher(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        },
      );
      if (response.status === 429)
        return { type: "transient_failure", code: "rate_limited", retryAfterMs: 30_000 };
      if (response.status >= 500)
        return { type: "outcome_unknown", code: "connection_lost_after_send" };
      if (!response.ok)
        return {
          type: "permanent_failure",
          code: response.status === 400 ? "provider_rejected" : "channel_unavailable",
        };
      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(body.id)
        ? { type: "succeeded", providerReference: body.id }
        : { type: "outcome_unknown", code: "connection_lost_after_send" };
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
      )
        return { type: "outcome_unknown", code: "provider_timeout" };
      if (error instanceof Error && error.message === "gmail_auth_rejected")
        return { type: "permanent_failure", code: "channel_unavailable" };
      return { type: "transient_failure", code: "network_error", retryAfterMs: 5_000 };
    }
  }
  async reconcile(
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<NotificationReconciliationResult> {
    try {
      return await this.lookup(idempotencyKey, signal);
    } catch {
      return { type: "unknown" };
    }
  }
}

export const gmailConfigFromEnv = (env: NodeJS.ProcessEnv): GmailOAuthConfig | undefined => {
  const sender = env.GMAIL_SENDER?.trim(),
    clientId = env.GMAIL_CLIENT_ID?.trim(),
    clientSecret = env.GMAIL_CLIENT_SECRET?.trim(),
    refreshToken = env.GMAIL_REFRESH_TOKEN?.trim(),
    messageIdDomain = env.GMAIL_MESSAGE_ID_DOMAIN?.trim();
  return sender && clientId && clientSecret && refreshToken && messageIdDomain
    ? { sender, clientId, clientSecret, refreshToken, messageIdDomain }
    : undefined;
};
