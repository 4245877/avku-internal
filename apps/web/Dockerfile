# Multi-stage image for the AVKU web SPA.
# Build context is the repository root (see docker-compose*.yml).
#
# The production bundle is built here and served as static files by an
# unprivileged nginx. No source, node_modules, repository bind-mount or
# dev-class server (vite preview) reaches the running container — which is what
# previously exposed the whole repo (including the Cloudflare Tunnel token) to a
# network-facing container.

# --- Build the static bundle ---
FROM node:22-bookworm AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app/apps/web

# The API base URL is baked into the bundle at build time. Default is the
# same-origin `/api` served by the edge nginx; override via the AVKU_WEB_API_URL
# build arg only if a different base is ever needed.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
# @playwright/test is a dev-only E2E dependency. The build stage still installs
# it (the lockfile is installed whole, and `--prod` would drop vite itself), but
# this stops its postinstall from pulling ~400MB of browser binaries into a
# layer the bundle never needs. The runtime stage below copies only `dist/`, so
# neither Playwright nor a browser reaches the shipped image either way.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
# node_modules / dist / logs are excluded by .dockerignore, so this brings in
# only the sources needed to build (index.html, vite.config.js, src/).
COPY apps/web/ ./
RUN pnpm run build

# --- Serve the bundle (unprivileged, static only) ---
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
# The base image already runs as the non-root `nginx` user (uid 101) and listens
# on 8080.
COPY infra/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
