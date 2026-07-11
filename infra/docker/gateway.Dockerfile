ARG NODE_IMAGE=node:24.18.0-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5
FROM ${NODE_IMAGE} AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @project-conversation/gateway build \
    && pnpm --filter @project-conversation/gateway deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /nonexistent --shell /usr/sbin/nologin app
COPY --from=build --chown=10001:10001 /out/ /app/
COPY --chown=10001:10001 infra/docker/gateway-entrypoint.mjs /usr/local/libexec/gateway-entrypoint.mjs
COPY --chown=10001:10001 infra/healthchecks/gateway-readiness.mjs /usr/local/libexec/gateway-readiness.mjs
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/usr/local/libexec/gateway-entrypoint.mjs"]
CMD ["/app/dist/main.js"]
