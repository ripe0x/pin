#!/usr/bin/env bash
# Update the existing Form of Solitude Sepolia collection, preserving its tokens.
# Run: bash script/update-anton-sepolia.sh [--plan]
# Each transaction requires a separate, explicit "yes" at the terminal.
set -euo pipefail

cd "$(dirname "$0")/.."
RPC_URL=${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}
ACCOUNT=${ANTON_ACCOUNT:-ripe0x}
PASSWORD_FILE=${ANTON_PASSWORD_FILE:-$HOME/.foundry/megarip-keystore.pass}
SIGNER=0xCB43078C32423F5348Cab5885911C3B5faE217F9
COLLECTION=0xE95F98179a6365881aed0cb5331D96976E9Fe09b
OLD_ASSETS=0xF314c0CAA5E3f55e1046626D1CAdF511c127423F
OLD_RENDERER=0x420a0c59Ec154edCb988869330fC18Cb35784c11
MINTER=0x76EA8061A941858001811B003a630EC67029284e
STATE=broadcast/anton-sepolia-update.json

for tool in cast forge jq; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
lower() { tr '[:upper:]' '[:lower:]'; }
[[ -r "$PASSWORD_FILE" ]] || { echo "Keystore password file is unavailable" >&2; exit 1; }
[[ "$(cast chain-id --rpc-url "$RPC_URL")" == 11155111 ]] || { echo "Expected Sepolia chain 11155111" >&2; exit 1; }
[[ "$(printf '%s' "$SIGNER" | lower)" == "$(cast wallet address --account "$ACCOUNT" --password-file "$PASSWORD_FILE" | lower)" ]] || {
  echo "Keystore signer does not match the collection owner" >&2; exit 1;
}
[[ "$(printf '%s' "$SIGNER" | lower)" == "$(cast call "$COLLECTION" 'owner()(address)' --rpc-url "$RPC_URL" | lower)" ]] || {
  echo "Collection owner changed" >&2; exit 1;
}

config() { cast call "$COLLECTION" 'config()((uint256,uint16,address,address,bool,bool),uint256)' --rpc-url "$RPC_URL"; }
cap() { config | head -1 | cut -d, -f1 | tr -d '('; }
code_exists() { [[ "$(cast code "$1" --rpc-url "$RPC_URL")" != 0x ]]; }
state_get() { [[ -f "$STATE" ]] && jq -r --arg key "$1" '.[$key] // empty' "$STATE" || true; }
state_set() {
  mkdir -p broadcast
  [[ -f "$STATE" ]] || printf '{}\n' > "$STATE"
  local tmp
  tmp=$(mktemp "${STATE}.XXXXXX")
  jq --arg key "$1" --arg value "$2" '.[$key] = $value' "$STATE" > "$tmp"
  mv "$tmp" "$STATE"
}
check_pending() {
  local pending
  pending=$(state_get pending)
  [[ -z "$pending" ]] || { echo "Unreconciled $pending transaction. Inspect its receipt before resuming; state: $STATE" >&2; exit 1; }
}
confirm() {
  local answer nonce
  [[ -t 0 ]] || { echo "Run in an interactive terminal for per-transaction confirmation" >&2; exit 1; }
  nonce=$(cast nonce "$SIGNER" --rpc-url "$RPC_URL")
  printf '\nChain: Sepolia (11155111) | signer: %s | nonce: %s\n' "$SIGNER" "$nonce"
  printf '%s\nNative value: 0 ETH; signer pays Sepolia gas.\n' "$1"
  printf 'Type yes to broadcast this transaction: '
  read -r answer
  [[ "$answer" == yes ]] || { echo "Stopped before broadcast"; exit 0; }
  CONFIRMED_NONCE=$nonce
  [[ "${3:-}" == defer ]] || state_set pending "$2 (nonce $nonce)"
}
record_receipt() {
  local file=$1 key=$2 address=${3:-} count status hash chain_status tx_from
  [[ -f "$file" ]] || { echo "Missing broadcast receipt: $file" >&2; exit 1; }
  count=$(jq '.transactions | length' "$file")
  [[ "$count" == 1 ]] || { echo "Expected exactly one transaction in $file" >&2; exit 1; }
  status=$(jq -r '.receipts[0].status | tostring' "$file")
  [[ "$status" == 1 || "$status" == 0x1 ]] || { echo "Receipt is not successful: $status" >&2; exit 1; }
  hash=$(jq -r '.receipts[0].transactionHash // empty' "$file")
  [[ -n "$hash" ]] || { echo "Missing transaction hash in $file" >&2; exit 1; }
  chain_status=$(cast receipt "$hash" status --rpc-url "$RPC_URL")
  [[ "$chain_status" == 1 || "$chain_status" == 0x1 ]] || { echo "Onchain receipt failed: $hash" >&2; exit 1; }
  tx_from=$(cast tx "$hash" from --rpc-url "$RPC_URL" | lower)
  [[ "$tx_from" == "$(printf '%s' "$SIGNER" | lower)" ]] || { echo "Unexpected transaction sender: $tx_from" >&2; exit 1; }
  if [[ -z "$address" ]]; then address=$(jq -r '.receipts[0].contractAddress // .transactions[0].contractAddress // empty' "$file"); fi
  if [[ "$key" == renderAssets || "$key" == store || "$key" == renderer ]]; then
    [[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] && code_exists "$address" || {
      echo "Deployment address is missing or has no code; reconcile $hash before resuming" >&2; exit 1;
    }
  fi
  [[ -z "$address" ]] || state_set "$key" "$address"
  state_set "${key}Tx" "$hash"
  state_set pending ''
  printf 'Confirmed %s: %s\n' "$key" "$hash"
  [[ -z "$address" || "$address" == true ]] || printf 'Address: %s\n' "$address"
}
run_forge() {
  forge script "$1" --rpc-url "$RPC_URL" --sender "$SIGNER" \
    --account "$ACCOUNT" --password-file "$PASSWORD_FILE" --broadcast --slow
}

echo "Existing collection: $COLLECTION"
echo "Current config: $(config | head -1)"
echo "Minted: $(config | tail -1)"
echo "Mint price (1 token): $(cast call "$MINTER" 'priceOf(address,uint256)(uint256)' "$SIGNER" 1 --rpc-url "$RPC_URL") wei"
[[ "$(cast call "$MINTER" 'priceOf(address,uint256)(uint256)' "$SIGNER" 1 --rpc-url "$RPC_URL" | cut -d' ' -f1)" == 1000000000000000 ]] || {
  echo "Mint price is no longer 0.001 ETH" >&2; exit 1;
}
[[ "${1:-}" == --plan || -z "${1:-}" ]] || { echo 'Usage: bash script/update-anton-sepolia.sh [--plan]' >&2; exit 1; }
minted=$(config | tail -1)
[[ "$minted" =~ ^[0-9]+$ && "$minted" -le 256 ]] || { echo "Minted count cannot fit cap 256: $minted" >&2; exit 1; }
current_cap=$(cap)
if [[ "$current_cap" != 256 ]]; then
  [[ "$(cast call "$COLLECTION" 'isSupplyLocked()(bool)' --rpc-url "$RPC_URL")" == false ]] || {
    echo "Supply is locked at $current_cap; cannot update to 256" >&2; exit 1;
  }
fi
current_renderer=$(cast call "$COLLECTION" 'renderer()(address)' --rpc-url "$RPC_URL")
if [[ "$(printf '%s' "$current_renderer" | lower)" == "$(printf '%s' "$OLD_RENDERER" | lower)" ]]; then
  [[ "$(cast call "$COLLECTION" 'isRendererLocked()(bool)' --rpc-url "$RPC_URL")" == false ]] || {
    echo 'Existing renderer is locked; cannot update the artwork' >&2; exit 1;
  }
else
  [[ -n "$(state_get renderer)" && "$(printf '%s' "$current_renderer" | lower)" == "$(state_get renderer | lower)" ]] || {
    echo "Collection renderer changed unexpectedly: $current_renderer" >&2; exit 1;
  }
fi
if [[ "${1:-}" == --plan ]]; then
  echo 'Plan: deploy RenderAssets; copy capture template; deploy artwork store and renderer; switch this collection; set cap to 256.'
  echo 'The wrapper stops for explicit confirmation before each of the six transactions.'
  exit 0
fi
check_pending

assets=$(state_get renderAssets)
if [[ -z "$assets" ]]; then
  [[ "$(cast call "$COLLECTION" 'renderer()(address)' --rpc-url "$RPC_URL")" == "$OLD_RENDERER" ]] || {
    echo "Collection renderer changed; reconcile before deploying" >&2; exit 1;
  }
  confirm 'CREATE RenderAssets: ownerless editable metadata and capture registry. Existing collection unchanged.' renderAssets
  RENDER_ASSETS_ONLY=true env -u RENDER_ASSETS forge script script/DeployRenderModules.s.sol:DeployRenderModulesScript \
    --rpc-url "$RPC_URL" --sender "$SIGNER" --account "$ACCOUNT" --password-file "$PASSWORD_FILE" --broadcast --slow
  record_receipt broadcast/DeployRenderModules.s.sol/11155111/run-latest.json renderAssets
  assets=$(state_get renderAssets)
fi
code_exists "$assets" || { echo "RenderAssets has no code: $assets" >&2; exit 1; }
cast call "$assets" 'tokenDescriptionOf(address)(string)' "$COLLECTION" --rpc-url "$RPC_URL" >/dev/null || {
  echo 'RenderAssets lacks editable text getter' >&2; exit 1;
}

if [[ "$(state_get capturesMigrated)" != true ]]; then
  template=$(cast call "$OLD_ASSETS" 'templateOf(address)(string)' "$COLLECTION" --rpc-url "$RPC_URL")
  bound=$(cast call "$OLD_ASSETS" 'templateMaxTokenIdOf(address)(uint256)' "$COLLECTION" --rpc-url "$RPC_URL" | cut -d' ' -f1)
  confirm "CALL RenderAssets.setCaptureTemplate(collection=$COLLECTION, template=$template, maxTokenId=$bound). Preserves existing token images." capturesMigrated
  ANTON_COLLECTION="$COLLECTION" ANTON_OLD_RENDER_ASSETS="$OLD_ASSETS" RENDER_ASSETS="$assets" \
    run_forge script/MigrateAntonCaptures.s.sol:MigrateAntonCaptures
  record_receipt broadcast/MigrateAntonCaptures.s.sol/11155111/run-latest.json capturesMigrated true
fi
[[ "$(cast call "$assets" 'templateOf(address)(string)' "$COLLECTION" --rpc-url "$RPC_URL")" == "$(cast call "$OLD_ASSETS" 'templateOf(address)(string)' "$COLLECTION" --rpc-url "$RPC_URL")" ]] || {
  echo 'Capture template readback mismatch' >&2; exit 1;
}
[[ "$(cast call "$assets" 'templateMaxTokenIdOf(address)(uint256)' "$COLLECTION" --rpc-url "$RPC_URL" | cut -d' ' -f1)" == "$(cast call "$OLD_ASSETS" 'templateMaxTokenIdOf(address)(uint256)' "$COLLECTION" --rpc-url "$RPC_URL" | cut -d' ' -f1)" ]] || {
  echo 'Capture bound readback mismatch' >&2; exit 1;
}

store=$(state_get store)
if [[ -z "$store" ]]; then
  confirm 'CREATE AntonScriptStore: the reviewed v3 gzipped artwork. Existing collection unchanged.' store
  run_forge script/DeployAntonStore.s.sol:DeployAntonStore
  record_receipt broadcast/DeployAntonStore.s.sol/11155111/run-latest.json store
  store=$(state_get store)
fi
code_exists "$store" || { echo "AntonScriptStore has no code: $store" >&2; exit 1; }

renderer=$(state_get renderer)
if [[ -z "$renderer" ]]; then
  confirm "CREATE AntonRenderer(store=$store, renderAssets=$assets, builder=0xD7587F110E08F4D120A231bA97d3B577A81Df022, gunzipStore=0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245, injectionVersion=1). Existing collection unchanged." renderer
  ANTON_STORE="$store" RENDER_ASSETS="$assets" run_forge script/DeployAntonRenderer.s.sol:DeployAntonRenderer
  record_receipt broadcast/DeployAntonRenderer.s.sol/11155111/run-latest.json renderer
  renderer=$(state_get renderer)
fi
code_exists "$renderer" || { echo "AntonRenderer has no code: $renderer" >&2; exit 1; }

current=$(cast call "$COLLECTION" 'renderer()(address)' --rpc-url "$RPC_URL")
if [[ "$(printf '%s' "$current" | lower)" != "$(printf '%s' "$renderer" | lower)" ]]; then
  [[ "$(printf '%s' "$current" | lower)" == "$(printf '%s' "$OLD_RENDERER" | lower)" ]] || { echo "Unknown current renderer: $current" >&2; exit 1; }
  [[ "$(cast call "$COLLECTION" 'isRendererLocked()(bool)' --rpc-url "$RPC_URL")" == false ]] || { echo 'Renderer is locked' >&2; exit 1; }
  confirm "CALL collection.setRenderer($renderer) on $COLLECTION. Updates metadata and animation for all existing tokens; mint price and ownership unchanged. Keep capture writes paused until the swap receipt." rendererSwap defer
  # Captures may have changed in the old registry while this run was paused.
  # Check after approval, as close to the broadcast as this interface permits.
  minted_now=$(config | tail -1)
  for ((id=1; id<=minted_now; id++)); do
    old_image=$(cast call "$OLD_ASSETS" 'imageFor(address,uint256)(string)' "$COLLECTION" "$id" --rpc-url "$RPC_URL")
    new_image=$(cast call "$assets" 'imageFor(address,uint256)(string)' "$COLLECTION" "$id" --rpc-url "$RPC_URL")
    [[ "$old_image" == "$new_image" ]] || { echo "Capture mismatch at token $id; stop before renderer swap" >&2; exit 1; }
  done
  [[ "$(config | tail -1)" == "$minted_now" ]] || { echo 'Minted count changed during capture check; retry' >&2; exit 1; }
  [[ "$(cast nonce "$SIGNER" --rpc-url "$RPC_URL")" == "$CONFIRMED_NONCE" ]] || { echo 'Signer nonce changed during capture check; retry' >&2; exit 1; }
  printf 'Capture images match for %s minted tokens.\n' "$minted_now"
  state_set pending "rendererSwap (nonce $CONFIRMED_NONCE)"
  ANTON_COLLECTION="$COLLECTION" ANTON_RENDERER="$renderer" ANTON_STORE="$store" RENDER_ASSETS="$assets" \
    run_forge script/SwapAntonRenderer.s.sol:SwapAntonRenderer
  record_receipt broadcast/SwapAntonRenderer.s.sol/11155111/run-latest.json rendererSwap "$renderer"
fi
[[ "$(printf '%s' "$renderer" | lower)" == "$(cast call "$COLLECTION" 'renderer()(address)' --rpc-url "$RPC_URL" | lower)" ]] || {
  echo 'Renderer readback mismatch' >&2; exit 1;
}

current_cap=$(cap)
if [[ "$current_cap" != 256 ]]; then
  [[ "$(cast call "$COLLECTION" 'isSupplyLocked()(bool)' --rpc-url "$RPC_URL")" == false ]] || { echo 'Supply is locked' >&2; exit 1; }
  confirm "CALL collection.setSupplyCap(256) on $COLLECTION; current cap=$current_cap. Existing tokens remain minted." supplyCap
  hash=$(cast send "$COLLECTION" 'setSupplyCap(uint256)' 256 --rpc-url "$RPC_URL" --from "$SIGNER" \
    --account "$ACCOUNT" --password-file "$PASSWORD_FILE" --json | jq -r '.transactionHash')
  [[ -n "$hash" && "$hash" != null ]] || { echo 'Missing cap transaction hash; reconcile before resuming' >&2; exit 1; }
  cap_status=$(cast receipt "$hash" status --rpc-url "$RPC_URL")
  [[ "$cap_status" == 1 || "$cap_status" == 0x1 ]] || { echo 'Cap transaction failed' >&2; exit 1; }
  [[ "$(cap)" == 256 ]] || { echo 'Cap readback mismatch' >&2; exit 1; }
  state_set supplyCapTx "$hash"
  state_set pending ''
  printf 'Confirmed supply cap: %s\n' "$hash"
fi

echo 'Sepolia update complete. Send these addresses and transaction hashes back for preview link and metadata verification:'
jq . "$STATE"
