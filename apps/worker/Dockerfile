# Deterministic worker image.
#
# Why a Dockerfile and not Nixpacks/Railpack: Railway's managed builders
# changed their defaults under us (builder swap, Node downgraded to 18,
# corepack signature breakage, differing build-vs-runtime file layout),
# which broke every worker deploy. Pinning the toolchain here makes the
# build immune to platform-default drift.
#
# Build context is the repo ROOT (monorepo). Point Railway at this file
# with the service var RAILWAY_DOCKERFILE_PATH=apps/worker/Dockerfile.
FROM node:22-slim

# pnpm via npm (not corepack — node 18's corepack had a broken signing key,
# and a global npm install lands on PATH in a real node image).
RUN npm install -g pnpm@9.14.2

WORKDIR /app

# Full monorepo so workspace symlinks (@pin/*) resolve to real source
# paths outside node_modules — required for `node --experimental-strip-types`
# to transpile the workspace TS packages.
COPY . .

RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production

# The worker runs TypeScript directly via Node's type stripping (Node 22).
WORKDIR /app/apps/worker
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/index.ts"]
