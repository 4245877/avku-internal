FROM node:22-bookworm@sha256:a25c9934ff6382cd4f08b6bc26c82bf4ea69b1e6f8dabfb2ead457374127c365

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-liberation \
    fonts-roboto \
  && rm -rf /var/lib/apt/lists/*

COPY infra/node/fonts.conf /etc/fonts/local.conf

RUN fc-cache -f
