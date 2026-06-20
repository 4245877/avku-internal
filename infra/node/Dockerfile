FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-liberation \
    fonts-roboto \
  && rm -rf /var/lib/apt/lists/*

COPY infra/node/fonts.conf /etc/fonts/local.conf

RUN fc-cache -f
