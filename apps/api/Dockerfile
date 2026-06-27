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
FROM base AS runtime
WORKDIR /app/apps/api
ENV NODE_ENV=production
ENV DATA_ROOT=/data
ENV CERTIFICATES_TEMPLATES_DIRECTORY=/app/storage/certificates/templates
ENV CERTIFICATES_DEFAULT_TEMPLATE_ID=volunteer-card-v1-uk
ENV NODE_OPTIONS=--no-warnings=ExperimentalWarning

COPY --from=deps /app/apps/api/node_modules ./node_modules
COPY apps/api/package.json apps/api/pnpm-workspace.yaml ./
COPY apps/api/src ./src
COPY storage/certificates/templates /app/storage/certificates/templates

EXPOSE 3001
CMD ["pnpm", "start"]
