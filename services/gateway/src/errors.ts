export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export const unauthorized = (message = "Authentication is required") =>
  new GatewayError(401, "unauthorized", message);

export const forbidden = (message = "This action is not allowed") =>
  new GatewayError(403, "forbidden", message);

export const notFound = (message = "Resource not found") =>
  new GatewayError(404, "not_found", message);

export const conflict = (message: string) => new GatewayError(409, "conflict", message);

export const invalidInput = (message: string, details?: Readonly<Record<string, unknown>>) =>
  new GatewayError(400, "invalid_input", message, details);

export const unavailable = (message = "A required dependency is unavailable") =>
  new GatewayError(503, "unavailable", message);
