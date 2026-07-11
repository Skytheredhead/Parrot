import type { Principal } from "./contracts.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
    rawBody?: Buffer;
  }

  interface FastifyContextConfig {
    csrfExempt?: boolean;
  }
}
