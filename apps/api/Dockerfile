# Multi-stage image for the AVKU API.
# Build context is the repository root (see docker-compose*.yml).
#
# Dependencies and source are baked in at build time so the running container
# does not perform `pnpm install` on startup and does not need the repository
# bind-mounted into it.

# --- Base: Node + fonts required by sharp/certificate rendering ---
FROM node:22-bookworm AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-liberation \
    fonts-roboto \
    gosu \
  && rm -rf /var/lib/apt/lists/*
COPY infra/node/fonts.conf /etc/fonts/local.conf
RUN fc-cache -f
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

# --- Dependencies installed at build time ---
FROM base AS deps
WORKDIR /app/apps/api
COPY apps/api/package.json apps/api/pnpm-lock.yaml apps/api/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# --- Runtime ---
FROM base AS app-runtime
ARG AVKU_RELEASE_ID=unversioned-build
ENV AVKU_RELEASE_ID=$AVKU_RELEASE_ID
WORKDIR /app/apps/api
ENV NODE_ENV=production
ENV DATA_ROOT=/data
# Templates are baked into the image (see COPY below); this is the multi-template
# catalogue root and the single source of truth for the API at runtime. Use the
# plural CERTIFICATES_TEMPLATES_DIRECTORY here — the singular legacy
# CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR pins the API to one template and would
# hide the English card.
ENV CERTIFICATES_TEMPLATES_DIRECTORY=/app/storage/certificates/templates
ENV CERTIFICATES_DEFAULT_TEMPLATE_ID=volunteer-card-v1-uk
ENV NODE_OPTIONS=--no-warnings=ExperimentalWarning

# The canonical certificate store in production is the SQLite DB on the /data
# volume. No legacy registry.json is bundled, so CERTIFICATES_LEGACY_REGISTRY_PATH
# is intentionally unset (the default /data/certificates/registry.json simply
# does not exist on a fresh volume, making the one-time migration a no-op). To
# bootstrap-migrate an old registry.json, mount it and set that variable.
COPY --from=deps /app/apps/api/node_modules ./node_modules
COPY apps/api/package.json apps/api/pnpm-lock.yaml apps/api/pnpm-workspace.yaml apps/api/tsconfig.json ./
COPY apps/api/src ./src
COPY apps/web/src /app/recovery/web/src
COPY apps/web/public /app/recovery/web/public
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/vite.config.js apps/web/index.html /app/recovery/web/
COPY apps/api/Dockerfile /app/recovery/deployment/api.Dockerfile
COPY apps/web/Dockerfile /app/recovery/deployment/web.Dockerfile
COPY infra/node/fonts.conf /app/recovery/deployment/fonts.conf
COPY infra/nginx/app.conf infra/nginx/web.conf /app/recovery/deployment/nginx/
COPY apps/api/docker-entrypoint.sh /app/recovery/deployment/api-entrypoint.sh
COPY .dockerignore /app/recovery/deployment/dockerignore
COPY infra/certificate-backup/extract.py /app/recovery/deployment/extract.py
COPY infra/certificate-backup/extract.py /app/infra/certificate-backup/extract.py
COPY storage/certificates/templates /app/storage/certificates/templates
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Make the entrypoint executable and hand the app tree to the unprivileged
# `node` user. Repo files are copied in as root with restrictive (0640) modes,
# so without this the non-root runtime user could not even read package.json.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && chown -R node:node /app

EXPOSE 3001
# The container starts as root only so the entrypoint can make the /data volume
# writable; it then drops to the unprivileged `node` user (via gosu) for the
# actual server process, so nothing long-running runs as root.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# Run tsx directly via node instead of `pnpm start`: this avoids invoking the
# corepack/pnpm shim at every startup (which would otherwise reach out to the
# npm registry to fetch a package manager), keeping start-up offline and free of
# extra supply-chain surface. Matches the loader used by the test script.
CMD ["node", "--import", "tsx", "src/main.ts"]

# Long operations run separately, with no production data volume or Docker socket.
FROM app-runtime AS backup-worker
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client python3 util-linux \
  && rm -rf /var/lib/apt/lists/*
USER node
ENTRYPOINT ["flock", "-n", "/jobs/worker.lock"]
CMD ["node", "--import", "tsx", "src/modules/certificate-backups/worker.ts"]

# Preserve the API as the default target for existing direct Docker builds.
FROM app-runtime AS runtime
