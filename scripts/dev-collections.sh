#!/usr/bin/env bash
#
# One command to test the Surface system fully locally before
# deploying.
#
#   pnpm dev:collections
#     (or: bash scripts/dev-collections.sh)
#
# What it does:
#   1. Finds a free port (won't collide with an Anvil you already have on 8545).
#   2. Starts an Anvil mainnet fork on a custom chain id (31339 — the same id
#      the web app's wagmi config registers for the fork chain) with
#      auto-impersonate on. Forking mainnet means Multicall3 (0xcA11…) and ENS
#      are present, so every PND surface works, not just collections.
#   3. Deploys the Surface system (Attribution, DefaultRenderer,
#      GenerativeRenderer, Surface implementation, and the
#      factory that clones it) via DeploySurfaceSystem.s.sol.
#   4. Funds an impersonated wallet so you can click through create + mint with
#      NO real wallet or signing — the app auto-connects as that address.
#   5. Writes apps/web/.env.development.local (layers over your real .env.local
#      in `next dev`, gitignored) with the fork settings + deployed addresses.
#   6. Starts the web dev server.
#
# When you Ctrl+C, Anvil is stopped. To fully restore production env, delete
# apps/web/.env.development.local (the script also prints this reminder).
#
# Overridable via env:
#   FORK_RPC      upstream RPC to fork (default: free publicnode)
#   IMPERSONATE   address you act as (default: Anvil account 0)
#   WEB_PORT      Next dev port (default: 3000)
#   DEV_NO_WEB    if set, skip `next dev`; print the env summary and keep
#                 Anvil alive until Ctrl+C (for CI/agent verification).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Foundry on PATH even if the caller's shell doesn't have it.
if ! command -v anvil >/dev/null 2>&1; then
  export PATH="$HOME/.foundry/bin:$PATH"
fi
command -v anvil >/dev/null 2>&1 || { echo "error: anvil not found (install Foundry: https://getfoundry.sh)"; exit 1; }

# Free public RPC for the fork (per repo RPC policy: don't burn paid CU on
# forks). Anvil caches state locally, so the upstream sees only a trickle.
FORK_RPC="${FORK_RPC:-https://ethereum-rpc.publicnode.com}"
CHAIN_ID=31339                      # must match wagmi.ts forkChain id

# DeploySurfaceSystem.s.sol reads PRIVATE_KEY via vm.envUint and signs with
# vm.startBroadcast(deployerPk) directly — it does NOT rely on --unlocked
# eth_sendTransaction impersonation like DeployEditions.s.sol did. So we pass
# the well-known Anvil account-0 private key as PRIVATE_KEY for the forge
# script invocation, and keep IMPERSONATE pinned to the address that key
# derives to (Anvil account 0) so the impersonated/funded wallet in the app
# is the same account that deployed the contracts.
ANVIL_ACCOUNT_0_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
IMPERSONATE="${IMPERSONATE:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"  # Anvil acct 0

# Web dev port: honor an explicit WEB_PORT, else first free port >= 3000 so we
# don't collide with other dev servers (Next would otherwise fail EADDRINUSE).
if [ -z "${WEB_PORT:-}" ]; then
  WEB_PORT=3000
  while lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; do WEB_PORT=$((WEB_PORT + 1)); done
fi

# 1) free anvil port, starting above the common 8545 dev node.
PORT=8546
while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
RPC="http://127.0.0.1:$PORT"

echo "▸ Anvil fork: $RPC  (chain id $CHAIN_ID, forking $FORK_RPC)"
anvil \
  --fork-url "$FORK_RPC" \
  --chain-id "$CHAIN_ID" \
  --port "$PORT" \
  --host 127.0.0.1 \
  --auto-impersonate \
  --silent &
ANVIL_PID=$!

cleanup() { kill "$ANVIL_PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# wait for readiness
for _ in $(seq 1 60); do
  if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || { echo "error: Anvil did not come up"; exit 1; }

# 2) fund the impersonated wallet (10000 ETH) so create/mint never run out of gas.
cast rpc anvil_setBalance "$IMPERSONATE" 0x21e19e0c9bab2400000 --rpc-url "$RPC" >/dev/null

# 3) deploy the collection system.
# NOTE: unlike DeployEditions.s.sol (which relied on --unlocked so Anvil's
# auto-impersonate signs via eth_sendTransaction), DeploySurfaceSystem.s.sol
# reads PRIVATE_KEY via vm.envUint and signs locally with
# vm.startBroadcast(deployerPk). --unlocked would tell forge to instead send
# via eth_sendTransaction using --sender as an unlocked account — mixing that
# with the script's own explicit-key signing is unnecessary and the two
# signing modes shouldn't be combined. So: pass PRIVATE_KEY, drop --unlocked,
# keep --sender for clarity/consistency (it must match the PRIVATE_KEY's
# address, verified above as Anvil account 0).
echo "▸ Deploying Surface system contracts…"
# CATALOG pins the collections to the REAL Catalog public good (present on the
# mainnet fork), so the seed's creator claims land in the same Catalog the
# collections read — the dev roster then actually confirms.
DEPLOY_OUT="$(cd contracts && CATALOG="0x467a9c39e03C595EC3075D856f19C7386b6b915d" \
  PRIVATE_KEY="$ANVIL_ACCOUNT_0_PK" forge script script/DeploySurfaceSystem.s.sol \
  --rpc-url "$RPC" --broadcast --sender "$IMPERSONATE" 2>&1)" || {
  echo "$DEPLOY_OUT" | tail -30
  echo "error: deploy failed"
  exit 1
}

# Parse from the script's final "Summary:" block, which always prints in full
# (unlike the step-by-step logs, which vary).
CATALOG="$(echo "$DEPLOY_OUT" | grep -i "Catalog:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"
RENDER_ASSETS="$(echo "$DEPLOY_OUT" | grep -i "RenderAssets:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"
DEFAULT_RENDERER="$(echo "$DEPLOY_OUT" | grep -i "DefaultRenderer:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"
GATE_HOOK="$(echo "$DEPLOY_OUT" | grep -i "GateHook:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"
IMPLEMENTATION="$(echo "$DEPLOY_OUT" | grep -i "Surface (seq) impl:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"
FACTORY="$(echo "$DEPLOY_OUT" | grep -i "SurfaceFactory:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"

for pair in "CATALOG:$CATALOG" "RENDER_ASSETS:$RENDER_ASSETS" "DEFAULT_RENDERER:$DEFAULT_RENDERER" \
            "GATE_HOOK:$GATE_HOOK" "IMPLEMENTATION:$IMPLEMENTATION" "FACTORY:$FACTORY"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  if [ -z "$value" ]; then
    echo "$DEPLOY_OUT" | tail -50
    echo "error: could not parse $name address from deploy output"
    exit 1
  fi
done

echo "▸ Catalog:                    $CATALOG"
echo "▸ RenderAssets:               $RENDER_ASSETS"
echo "▸ DefaultRenderer:            $DEFAULT_RENDERER"
echo "▸ Surface impl:   $IMPLEMENTATION"
echo "▸ SurfaceFactory: $FACTORY"
echo "▸ GateHook:                   $GATE_HOOK"

# 3b) optional sample world (SEED_SAMPLE=1, default on): three collections
#     rendered through the DefaultRenderer with inline-SVG covers — one with a
#     collab roster (one claimed + one unclaimed creator) and mints, one
#     unminted, one edition — so every UI surface has content immediately.
#     SEED_SAMPLE=0 skips for a blank slate.
if [ "${SEED_SAMPLE:-1}" = "1" ]; then
  echo "▸ Seeding sample collections…"
  SEED_OUT="$(cd contracts && FACTORY="$FACTORY" RENDER_ASSETS="$RENDER_ASSETS" GATE_HOOK="$GATE_HOOK" \
    PRIVATE_KEY="$ANVIL_ACCOUNT_0_PK" forge script script/SeedDevSurfaces.s.sol \
    --tc SeedDevSurfaces --rpc-url "$RPC" --broadcast 2>&1)" || {
    echo "$SEED_OUT" | tail -20
    echo "warning: sample seeding failed (harness continues unseeded)"
  }
  echo "$SEED_OUT" | grep -E "Orbit Studies|Signal Drift|Field Notes" | sed 's/^/  /'
fi

# 3c) optional Homage to the Punk seed (SEED_HOMAGE=1, default on): the sibling
#     `homage to the punk` repo's own Sovereign-core deploy script
#     (DeployDevSovereign.s.sol), run against THIS factory/fork so the collection
#     shows up in the same local Collections UI. Silently skipped (not a hard
#     failure) when the sibling repo isn't checked out next to this one.
HOMAGE_REPO="${HOMAGE_REPO:-$HOME/CascadeProjects/homage to the punk}"
# Captured from the homage seed and written into the dev env below, so PND's homage
# registry (lib/homage/registry.ts) can recognize this collection and render the
# bespoke homage mint instrument instead of the generic "sold via minter" notice.
HOMAGE_COLLECTION_ADDR=""
HOMAGE_MINTER_ADDR=""
HOMAGE_RENDERER_ADDR=""
if [ "${SEED_HOMAGE:-1}" = "1" ] && [ -d "$HOMAGE_REPO/contracts" ]; then
  echo "▸ Seeding Homage to the Punk…"
  SEED_HOMAGE_OUT="$(cd "$HOMAGE_REPO/contracts" && FACTORY="$FACTORY" PRIVATE_KEY="$ANVIL_ACCOUNT_0_PK" \
    forge script script/DeployDevSovereign.s.sol --rpc-url "$RPC" --broadcast 2>&1)" || {
    echo "$SEED_HOMAGE_OUT" | tail -20
    echo "warning: Homage seeding failed (harness continues)"
  }
  echo "$SEED_HOMAGE_OUT" | grep -E "HomageRendererSovereign:|HomageCollection:|HomageMinter:|HomageFeeSplitter:|Collection page:" | sed 's/^/  /'
  HOMAGE_COLLECTION_ADDR="$(echo "$SEED_HOMAGE_OUT" | grep -i "HomageCollection:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1 || true)"
  HOMAGE_MINTER_ADDR="$(echo "$SEED_HOMAGE_OUT" | grep -i "HomageMinter:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1 || true)"
  HOMAGE_RENDERER_ADDR="$(echo "$SEED_HOMAGE_OUT" | grep -i "HomageRendererSovereign:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1 || true)"
elif [ "${SEED_HOMAGE:-1}" = "1" ]; then
  echo "▸ Homage seeding skipped: $HOMAGE_REPO/contracts not found"
fi

# 4) write dev env (non-destructive: .env.development.local wins over
#    .env.local only in `next dev`, and is gitignored).
ENV_DEV="apps/web/.env.development.local"
cat > "$ENV_DEV" <<EOF
# Auto-generated by scripts/dev-collections.sh for local fork testing.
# Delete this file to restore your normal dev env.
NEXT_PUBLIC_USE_LOCAL_RPC=1
NEXT_PUBLIC_ANVIL_RPC_URL=$RPC
NEXT_PUBLIC_DEV_IMPERSONATE=$IMPERSONATE
NEXT_PUBLIC_SURFACE_FACTORY=$FACTORY
NEXT_PUBLIC_RENDER_ASSETS=$RENDER_ASSETS
NEXT_PUBLIC_DEFAULT_RENDERER=$DEFAULT_RENDERER
NEXT_PUBLIC_GATE_HOOK=$GATE_HOOK
EOF
if [ -n "$HOMAGE_COLLECTION_ADDR" ] && [ -n "$HOMAGE_MINTER_ADDR" ]; then
  cat >> "$ENV_DEV" <<EOF
# Homage to the Punk (seeded above) — the /mint/homage gallery venue reads the
# *_ADDRESS vars (mint-modules/homage.ts); the non-suffixed pair feeds the
# /collections detection port. Both point at the same fork deploy.
NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS=$HOMAGE_COLLECTION_ADDR
NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS=$HOMAGE_MINTER_ADDR
NEXT_PUBLIC_HOMAGE_RENDERER=$HOMAGE_RENDERER_ADDR
NEXT_PUBLIC_HOMAGE_COLLECTION=$HOMAGE_COLLECTION_ADDR
NEXT_PUBLIC_HOMAGE_MINTER=$HOMAGE_MINTER_ADDR
EOF
fi
echo "▸ Wrote $ENV_DEV  (delete it to restore prod env)"

echo
echo "──────────────────────────────────────────────────────────────"
echo "  Collections local test is ready."
echo "    Fork RPC : $RPC  (chain id $CHAIN_ID)"
echo "    Factory  : $FACTORY"
echo "    Acting as: $IMPERSONATE  (auto-connected, no wallet needed)"
if [ "${SEED_HOMAGE:-1}" = "1" ] && [ -d "$HOMAGE_REPO/contracts" ]; then
  echo "    Homage   : seeded from $HOMAGE_REPO (see HomageCollection above)"
fi
echo
echo "    Open:  http://localhost:$WEB_PORT/collections"
echo "    Stop:  Ctrl+C  (then: rm $ENV_DEV)"
echo "──────────────────────────────────────────────────────────────"
echo

if [ -n "${DEV_NO_WEB:-}" ]; then
  echo "▸ DEV_NO_WEB set: skipping next dev. Anvil stays up until Ctrl+C."
  wait "$ANVIL_PID"
  exit 0
fi

# 5) start the web dev server in the foreground (Ctrl+C stops both).
# Call `next` directly (not `pnpm run dev -- --port`): pnpm forwards `--`
# literally, which Next then treats as the project dir.
pnpm --filter @pin/web exec next dev --turbopack --port "$WEB_PORT"
