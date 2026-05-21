# Deterministic indexer (Ponder) image.
#
# Same rationale as apps/worker/Dockerfile: Railway's managed builders
# changed defaults (Nixpacks->Railpack, Node 18, broken corepack, differing
# build-vs-runtime layout) and break the pnpm-monorepo deploy. Pinning the
# toolchain here makes it immune to platform-default drift.
#
# Build context is the repo ROOT. Point Railway at this file with the
# service var RAILWAY_DOCKERFILE_PATH=apps/indexer/Dockerfile.
FROM node:22-slim

RUN npm install -g pnpm@9.14.2

WORKDIR /app

# Full monorepo so workspace packages resolve and Ponder codegen can read
# the schema/config.
COPY . .

# Install, then generate Ponder's typed artifacts (ponder.schema -> types).
RUN pnpm install --frozen-lockfile && pnpm --filter @pin/indexer codegen

ENV NODE_ENV=production

# `ponder start` serves the indexer + health endpoint on $PORT (Railway
# injects it). Run from the package dir so Ponder finds its config.
WORKDIR /app/apps/indexer
CMD ["pnpm", "exec", "ponder", "start"]
