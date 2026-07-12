import { connect, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import type { MalwareScanner, TextExtractor } from "./adapters.js";

const abortError = (signal: AbortSignal): unknown => signal.reason ?? new Error("aborted");

export interface ClamAvConfig {
  readonly socketPath?: string;
  readonly host?: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** ClamAV INSTREAM client restricted to a local daemon. */
export class ClamAvScanner implements MalwareScanner {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "clamav-instream-scanner";
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  constructor(private readonly config: ClamAvConfig) {
    if ((!config.socketPath && !config.host) || (config.socketPath && config.host))
      throw new Error("clamav_endpoint_invalid");
    if (config.host && !["127.0.0.1", "::1"].includes(config.host))
      throw new Error("clamav_must_be_local");
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxBytes = config.maxBytes ?? 100 * 1024 * 1024;
    if (this.timeoutMs < 100 || this.timeoutMs > 300_000 || this.maxBytes < 1)
      throw new Error("clamav_config_invalid");
  }
  assertProductionReady(): boolean {
    return Boolean(this.config.socketPath || this.config.host);
  }
  async ready(): Promise<boolean> {
    try {
      return (
        (await this.command(
          "zPING\0",
          undefined,
          AbortSignal.timeout(Math.min(this.timeoutMs, 2_000)),
        )) === "PONG"
      );
    } catch {
      return false;
    }
  }
  private command(
    command: string,
    bytes: Uint8Array | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let socket: Socket | undefined;
      let settled = false;
      let response = "";
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        socket?.destroy();
        error ? reject(error) : resolve(response.replace(/\0/g, "").trim());
      };
      const onAbort = (): void => finish(abortError(signal));
      const timer = setTimeout(() => finish(new Error("clamav_timeout")), this.timeoutMs);
      timer.unref();
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      socket = this.config.socketPath
        ? connect(this.config.socketPath)
        : connect(this.config.port ?? 3310, this.config.host);
      socket.setNoDelay(true);
      socket.on("error", finish);
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (response.length > 4_096) finish(new Error("clamav_response_too_large"));
      });
      socket.on("end", () => finish());
      socket.on("connect", () => {
        socket?.write(command);
        if (bytes) {
          for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
            const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.byteLength));
            const length = Buffer.allocUnsafe(4);
            length.writeUInt32BE(chunk.byteLength);
            socket?.write(length);
            socket?.write(chunk);
          }
          socket?.end(Buffer.alloc(4));
        } else socket?.end();
      });
    });
  }
  async scan(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<{ readonly clean: boolean; readonly engine: string; readonly signature?: string }> {
    if (bytes.byteLength > this.maxBytes) throw new Error("clamav_input_too_large");
    const response = await this.command("zINSTREAM\0", bytes, signal);
    if (response.endsWith(" OK")) return { clean: true, engine: "clamav" };
    const found = response.match(/: (.{1,256}) FOUND$/);
    if (found?.[1])
      return {
        clean: false,
        engine: "clamav",
        signature: found[1].replace(/[^A-Za-z0-9._ -]/g, "_"),
      };
    throw new Error("clamav_protocol_error");
  }
}

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/** Strict UTF-8 text extraction only; complex document formats require an isolated converter. */
export class BoundedTextExtractor implements TextExtractor {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "bounded-text-extractor";
  constructor(
    private readonly maxBytes = 10 * 1024 * 1024,
    private readonly maxCharacters = 2_000_000,
  ) {}
  assertProductionReady(): boolean {
    return this.maxBytes > 0 && this.maxCharacters > 0;
  }
  async ready(): Promise<boolean> {
    return true;
  }
  async extract(bytes: Uint8Array, detectedType: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw abortError(signal);
    const type = detectedType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!TEXT_TYPES.has(type)) throw new Error("extract_type_unsupported");
    if (bytes.byteLength > this.maxBytes) throw new Error("extract_input_too_large");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).normalize("NFC");
    } catch {
      throw new Error("extract_invalid_utf8");
    }
    if (text.includes("\0")) throw new Error("extract_nul_rejected");
    text = [...text]
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code === 9 || code === 10 || code === 13 || code >= 32;
      })
      .join("");
    if ([...text].length > this.maxCharacters) throw new Error("extract_output_too_large");
    if (type === "application/json") {
      try {
        JSON.parse(text);
      } catch {
        throw new Error("extract_invalid_json");
      }
    }
    return text;
  }
}
