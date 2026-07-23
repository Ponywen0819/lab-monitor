# Build context is the repo root (npm workspaces need the whole tree),
# so this is referenced from docker-compose.yml as
# build.context=. build.dockerfile=packages/collector/Dockerfile

# Agent binaries are built here (not on the host) so the collector image is
# self-contained for the Remote Installer's upload step -- see
# packages/collector/src/remote-installer/index.ts's DEFAULT_AGENT_BINARY_DIR,
# which resolves to packages/agent/dist-bin relative to this package. Both
# architectures are built unconditionally (the lab isn't assumed to be one
# CPU architecture); install-agent.ts picks the right one per target via
# `uname -m` at install time, via Bun's own cross-compile support, without
# needing this build to run on either target architecture.
FROM oven/bun:1 AS agent-build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/agent/package.json packages/agent/package.json
RUN bun install
COPY packages/shared packages/shared
COPY packages/agent packages/agent
RUN cd packages/shared && bun run build
RUN cd packages/agent \
 && bun build --compile --target=bun-linux-x64 ./src/index.ts --outfile ./dist-bin/agent-linux-x64 \
 && bun build --compile --target=bun-linux-arm64 ./src/index.ts --outfile ./dist-bin/agent-linux-arm64

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/collector/package.json packages/collector/package.json
COPY packages/frontend/package.json packages/frontend/package.json
COPY packages/agent/package.json packages/agent/package.json
RUN npm ci
COPY packages/shared packages/shared
COPY packages/collector packages/collector
RUN npm run build --workspace=packages/shared \
 && npm run build --workspace=packages/collector

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/packages/collector packages/collector
COPY --from=agent-build /app/packages/agent/dist-bin/agent-linux-x64 packages/agent/dist-bin/agent-linux-x64
COPY --from=agent-build /app/packages/agent/dist-bin/agent-linux-arm64 packages/agent/dist-bin/agent-linux-arm64

EXPOSE 8080 8081
CMD ["node", "packages/collector/dist/index.js"]
