#!/usr/bin/env bash
#
# One command to test the SovereignCollection system fully locally before
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
#   3. Deploys the collection system (Attribution, DefaultRenderer,
#      GenerativeRenderer, SovereignCollection implementation, and the
#      factory that clones it) via DeployCollectionSystem.s.sol.
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

# DeployCollectionSystem.s.sol reads PRIVATE_KEY via vm.envUint and signs with
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
# auto-impersonate signs via eth_sendTransaction), DeployCollectionSystem.s.sol
# reads PRIVATE_KEY via vm.envUint and signs locally with
# vm.startBroadcast(deployerPk). --unlocked would tell forge to instead send
# via eth_sendTransaction using --sender as an unlocked account — mixing that
# with the script's own explicit-key signing is unnecessary and the two
# signing modes shouldn't be combined. So: pass PRIVATE_KEY, drop --unlocked,
# keep --sender for clarity/consistency (it must match the PRIVATE_KEY's
# address, verified above as Anvil account 0).
echo "▸ Deploying collection system contracts…"
DEPLOY_OUT="$(cd contracts && PRIVATE_KEY="$ANVIL_ACCOUNT_0_PK" forge script script/DeployCollectionSystem.s.sol \
  --rpc-url "$RPC" --broadcast --sender "$IMPERSONATE" 2>&1)" || {
  echo "$DEPLOY_OUT" | tail -30
  echo "error: deploy failed"
  exit 1
}

# Parse from the script's final "Summary:" block, which always prints in
# full (unlike the step-by-step logs, which skip the "deployed at" line for
# Attribution when it's already present at its predicted CREATE2 address).
ATTRIBUTION="$(echo "$DEPLOY_OUT" | grep -i "Attribution:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"
DEFAULT_RENDERER="$(echo "$DEPLOY_OUT" | grep -i "DefaultRenderer:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"
GENERATIVE_RENDERER="$(echo "$DEPLOY_OUT" | grep -i "GenerativeRenderer:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"
IMPLEMENTATION="$(echo "$DEPLOY_OUT" | grep -i "SovereignCollection impl:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"
FACTORY="$(echo "$DEPLOY_OUT" | grep -i "SovereignCollectionFactory:" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)"

for pair in "ATTRIBUTION:$ATTRIBUTION" "DEFAULT_RENDERER:$DEFAULT_RENDERER" \
            "GENERATIVE_RENDERER:$GENERATIVE_RENDERER" "IMPLEMENTATION:$IMPLEMENTATION" \
            "FACTORY:$FACTORY"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  if [ -z "$value" ]; then
    echo "$DEPLOY_OUT" | tail -50
    echo "error: could not parse $name address from deploy output"
    exit 1
  fi
done

echo "▸ Attribution:               $ATTRIBUTION"
echo "▸ DefaultRenderer:            $DEFAULT_RENDERER"
echo "▸ GenerativeRenderer:         $GENERATIVE_RENDERER"
echo "▸ SovereignCollection impl:   $IMPLEMENTATION"
echo "▸ SovereignCollectionFactory: $FACTORY"

# 3b) optional sample world (SEED_SAMPLE=1, default on): a generative
#     collection with mints (sketch uploaded to the real forked
#     ScriptyStorageV2), an edition with an inline-SVG cover, and a collab
#     roster with one claimed + one unclaimed artist — so every UI surface
#     has content immediately. SEED_SAMPLE=0 skips for a blank slate.
if [ "${SEED_SAMPLE:-1}" = "1" ]; then
  echo "▸ Seeding sample collections…"
  SEED_OUT="$(cd contracts && FACTORY="$FACTORY" GENERATIVE_RENDERER="$GENERATIVE_RENDERER" \
    PRIVATE_KEY="$ANVIL_ACCOUNT_0_PK" forge script script/SeedDevCollections.s.sol \
    --rpc-url "$RPC" --broadcast 2>&1)" || {
    echo "$SEED_OUT" | tail -20
    echo "warning: sample seeding failed (harness continues unseeded)"
  }
  echo "$SEED_OUT" | grep -E "Orbit Studies|Field Notes" | sed 's/^/  /'
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
NEXT_PUBLIC_SOVEREIGN_COLLECTION_FACTORY=$FACTORY
NEXT_PUBLIC_ATTRIBUTION=$ATTRIBUTION
NEXT_PUBLIC_GENERATIVE_RENDERER=$GENERATIVE_RENDERER
NEXT_PUBLIC_DEFAULT_RENDERER=$DEFAULT_RENDERER
EOF
echo "▸ Wrote $ENV_DEV  (delete it to restore prod env)"

echo
echo "──────────────────────────────────────────────────────────────"
echo "  PND Collections local test is ready."
echo "    Fork RPC : $RPC  (chain id $CHAIN_ID)"
echo "    Factory  : $FACTORY"
echo "    Acting as: $IMPERSONATE  (auto-connected, no wallet needed)"
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
