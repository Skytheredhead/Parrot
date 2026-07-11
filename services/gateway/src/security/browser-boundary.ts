import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { CsrfVerifier } from "../contracts.js";
import { forbidden, invalidInput } from "../errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const item of header?.split(";") ?? []) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    try {
      if (result.has(key)) throw invalidInput("Duplicate cookie name");
      result.set(key, decodeURIComponent(value));
    } catch {
      throw invalidInput("Malformed cookie header");
    }
  }
  return result;
}

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAllowedOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.includes(origin);
}

export function enforceBrowserBoundary(
  request: FastifyRequest,
  input: {
    allowedOrigins: readonly string[];
    sessionCookieName: string;
    csrfCookieName: string;
    csrfExempt: boolean;
    csrf: CsrfVerifier;
  },
): Promise<void> | void {
  if (SAFE_METHODS.has(request.method) || input.csrfExempt) return;

  const parsedCookies = parseCookies(request.headers.cookie);
  const sessionToken = parsedCookies.get(input.sessionCookieName);
  const hasSession = sessionToken !== undefined;
  const hasBearer = request.headers.authorization !== undefined;
  const origin = request.headers.origin;

  if (hasSession && hasBearer) {
    throw invalidInput("Cookie and bearer authentication cannot be mixed");
  }
  if (origin !== undefined && !isAllowedOrigin(origin, input.allowedOrigins)) {
    throw forbidden("Request origin is not allowed");
  }
  if (!hasSession) return;
  if (!origin || !isAllowedOrigin(origin, input.allowedOrigins)) {
    throw forbidden("A trusted Origin header is required for cookie-authenticated mutations");
  }
  const cookieToken = parsedCookies.get(input.csrfCookieName);
  const headerValue = request.headers["x-csrf-token"];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!cookieToken || !headerToken || !equalSecret(cookieToken, headerToken)) {
    throw forbidden("CSRF validation failed");
  }
  return input.csrf.verify({ sessionToken, csrfToken: headerToken }).then((valid) => {
    if (!valid) throw forbidden("CSRF validation failed");
  });
}
