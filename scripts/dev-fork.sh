#!/usr/bin/env bash
# Local mainnet-fork helper for testing the migrate / bulk-delist flows
# against a real artist with FND + SR V2 listings.
#
# What this does:
#   1. Sources MAINNET_RPC_URL from contracts/.env.
#   2. Starts anvil forking mainnet at chain id 31337 with auto-impersonate
#      enabled (anvil accepts unsigned txs from any from-address).
#   3. Funds the impersonated artist with 1 ETH so they can pay gas for
#      cancel + relist txs.
#
# Then in another terminal:
#   - Set apps/web/.env.local:
#       NEXT_PUBLIC_ALCHEMY_MAINNET_URL=http://localhost:8545
#       NEXT_PUBLIC_ANVIL_RPC_URL=http://localhost:8545
#       NEXT_PUBLIC_DEV_IMPERSONATE=0xe2374f3a3a10f73fb673ef1aa54a248d1e56517e
#   - Restart the dev server (npm run dev --workspace=apps/web)
#   - Visit http://localhost:<port>/artist/<artist>/migrate
#
# Restore production env (revert .env.local + restart) when done.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/contracts/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — needs MAINNET_RPC_URL." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [[ -z "${MAINNET_RPC_URL:-}" ]]; then
  echo "error: MAINNET_RPC_URL is empty in $ENV_FILE." >&2
  exit 1
fi

# Default impersonation target: mainnet artist with both FND + SR V2
# listings (verified by scripts/dev-fork-find-artist.ts). Overridable via
# the first CLI argument.
IMPERSONATE_ADDR="${1:-0xe2374f3a3a10f73fb673ef1aa54a248d1e56517e}"

if ! [[ "$IMPERSONATE_ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "error: '$IMPERSONATE_ADDR' is not a valid 0x address." >&2
  exit 1
fi

echo "Starting anvil mainnet fork (chain id 31337, auto-impersonate on)..."
echo "Will fund $IMPERSONATE_ADDR with 1 ETH after the node is ready."
echo

# Run anvil in the foreground; on Ctrl+C the script exits cleanly.
# `--chain-id 31337` matches the `foundry` chain in viem so the dapp's
# FORK_MODE switch picks the right preferred chain.
anvil \
  --fork-url "$MAINNET_RPC_URL" \
  --chain-id 31337 \
  --auto-impersonate \
  --host 127.0.0.1 \
  --port 8545 &
ANVIL_PID=$!

cleanup() {
  if kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID"
  fi
}
trap cleanup EXIT INT TERM

# Wait for anvil to come up (it's near-instant but be defensive).
for _ in {1..20}; do
  if cast block-number --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

# Top up balance — many artists hold all their ETH elsewhere; without
# this the cancel/relist txs fail with "insufficient funds for gas".
echo "Funding $IMPERSONATE_ADDR with 1 ETH..."
cast rpc anvil_setBalance \
  "$IMPERSONATE_ADDR" \
  "0xde0b6b3a7640000" \
  --rpc-url http://127.0.0.1:8545 >/dev/null

echo
echo "Anvil is running on http://127.0.0.1:8545"
echo "Impersonating: $IMPERSONATE_ADDR"
echo
echo "In a second terminal, edit apps/web/.env.local:"
echo "  NEXT_PUBLIC_ALCHEMY_MAINNET_URL=http://localhost:8545"
echo "  NEXT_PUBLIC_DEV_IMPERSONATE=$IMPERSONATE_ADDR"
echo "Then: npm run dev --workspace=apps/web"
echo
echo "Press Ctrl+C to stop anvil."

wait "$ANVIL_PID"
