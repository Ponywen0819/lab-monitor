# Build context is the repo root (npm workspaces need the whole tree),
# so this is referenced from docker-compose.yml as
# build.context=. build.dockerfile=packages/frontend/Dockerfile

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/collector/package.json packages/collector/package.json
COPY packages/frontend/package.json packages/frontend/package.json
COPY packages/agent/package.json packages/agent/package.json
RUN npm ci
COPY packages/shared packages/shared
COPY packages/frontend packages/frontend

# Vite bakes these into the static bundle at build time -- there is no
# runtime env injection for a plain static file server, so the lab
# server's real LAN address must be known at `docker compose build` time.
ARG VITE_HTTP_BASE_URL
ARG VITE_WS_URL
ENV VITE_HTTP_BASE_URL=$VITE_HTTP_BASE_URL
ENV VITE_WS_URL=$VITE_WS_URL
RUN npm run build --workspace=packages/shared \
 && npm run build --workspace=packages/frontend

FROM nginx:alpine
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
