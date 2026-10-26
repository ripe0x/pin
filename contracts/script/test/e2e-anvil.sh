#!/usr/bin/env bash
# Local deploy wrapper and receipt-record integration test. Never points at a
# public RPC and uses Anvil's unlocked accounts, so no key enters argv.
set -euo pipefail

cd "$(dirname "$0")/../.."
for tool in anvil cast forge jq python3; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done

PORT="${ANVIL_PORT:-18546}"
RPC="http://127.0.0.1:$PORT"
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
COLLECTOR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
ZERO=0x0000000000000000000000000000000000000000
PRICE=10000000000000000
RECORD=deployments.anvil.json
TMP="$(mktemp -d)"
HAD_RECORD=0
if [ -f "$RECORD" ]; then
  HAD_RECORD=1
  cp "$RECORD" "$TMP/original-record.json"
fi
ANVIL_PID=""
cleanup() {
  if [ -n "$ANVIL_PID" ]; then kill "$ANVIL_PID" 2>/dev/null || true; fi
  if [ "$HAD_RECORD" = "1" ]; then cp "$TMP/original-record.json" "$RECORD"; else rm -f "$RECORD"; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "e2e-anvil: $*" >&2; exit 1; }
eq() { [ "$1" = "$2" ] || fail "$3: got $1, expected $2"; }
chain_call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" | cut -d ' ' -f 1; }
send() {
  local receipt
  receipt="$(cast send "$@" --unlocked --from "$DEPLOYER" --rpc-url "$RPC" --json)"
  eq "$(printf '%s\n' "$receipt" | jq -r '.status')" 0x1 "transaction status"
}
record_only() {
  RPC_URL="$RPC" RECORD_ONLY=1 RECORD_BROADCAST_FILE="$1" script/deploy.sh anvil
}
refuses() {
  local label="$1" reason="$2" file="$3"
  if record_only "$file" >"$TMP/refusal.log" 2>&1; then fail "$label was accepted"; fi
  grep -Eq "$reason" "$TMP/refusal.log" || fail "$label failed for the wrong reason: $(tail -1 "$TMP/refusal.log")"
  cmp -s "$TMP/record.json" "$RECORD" || fail "$label changed the record"
}

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then fail "port $PORT already has an RPC server"; fi
anvil --host 127.0.0.1 --port "$PORT" --chain-id 31337 --silent >"$TMP/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 40); do
  kill -0 "$ANVIL_PID" 2>/dev/null || fail 'Anvil exited before becoming ready'
  if [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" = 31337 ]; then break; fi
  sleep 0.25
done
eq "$(cast chain-id --rpc-url "$RPC")" 31337 "Anvil chain"

RPC_URL="$RPC" script/deploy.sh anvil >"$TMP/deploy.log"
cp "$RECORD" "$TMP/record.json"
cp broadcast/DeploySurfaceV2.s.sol/31337/run-latest.json "$TMP/first-broadcast.json"

SURFACE_IMPL="$(jq -r '.surfaceImplV2' "$RECORD")"
SALE_IMPL="$(jq -r '.saleImplV2' "$RECORD")"
GATE="$(jq -r '.allowlistGate' "$RECORD")"
TOKEN_FACTORY="$(jq -r '.surfaceFactoryV2' "$RECORD")"
SALE_FACTORY="$(jq -r '.saleFactoryV2' "$RECORD")"
LAUNCHER="$(jq -r '.launcherV2' "$RECORD")"
for address in "$SURFACE_IMPL" "$SALE_IMPL" "$GATE" "$TOKEN_FACTORY" "$SALE_FACTORY" "$LAUNCHER"; do
  [ "$(cast code "$address" --rpc-url "$RPC")" != 0x ] || fail "$address has no code"
done
eq "$(chain_call "$TOKEN_FACTORY" 'implementation()(address)')" "$SURFACE_IMPL" "token factory implementation"
eq "$(chain_call "$SALE_FACTORY" 'implementation()(address)')" "$SALE_IMPL" "sale factory implementation"
eq "$(chain_call "$LAUNCHER" 'tokenFactory()(address)')" "$TOKEN_FACTORY" "launcher token factory"
eq "$(chain_call "$LAUNCHER" 'saleFactory()(address)')" "$SALE_FACTORY" "launcher sale factory"
eq "$(chain_call "$LAUNCHER" 'owner()(address)')" "$DEPLOYER" "launcher owner"
eq "$(chain_call "$LAUNCHER" 'defaultReferrer()(address)')" "$ZERO" "launcher default referrer"
eq "$(chain_call "$TOKEN_FACTORY" 'paused()(bool)')" true "token factory paused"
eq "$(chain_call "$SALE_FACTORY" 'paused()(bool)')" true "sale factory paused"

# The record step uses transaction hashes and the chain, never the JSON's
# address field. Check every refusal without rerunning a broadcast.
FIRST="$(jq -r '.transactions[0].hash' "$TMP/first-broadcast.json")"
SECOND="$(jq -r '.transactions[1].hash' "$TMP/first-broadcast.json")"
jq --arg a "$FIRST" --arg b "$SECOND" '.transactions[0].hash = $b | .transactions[1].hash = $a' "$TMP/first-broadcast.json" >"$TMP/swapped.json"
refuses 'swapped tx hashes' 'CREATE 0|nonce' "$TMP/swapped.json"
jq '.transactions += [.transactions[2]]' "$TMP/first-broadcast.json" >"$TMP/extra.json"
refuses 'extra CREATE' 'expected exactly 6 CREATE' "$TMP/extra.json"
jq '.transactions[0].contractName = "AllowlistGate"' "$TMP/first-broadcast.json" >"$TMP/relabelled.json"
refuses 'relabelled contract' 'CREATE 0 is AllowlistGate' "$TMP/relabelled.json"
jq '(.transactions[] | select(.transactionType == "CREATE") | .contractAddress) = "0x0000000000000000000000000000000000000001"' "$TMP/first-broadcast.json" >"$TMP/wrong-address.json"
record_only "$TMP/wrong-address.json" >"$TMP/record-only.log"
cmp -s "$TMP/record.json" "$RECORD" || fail 'JSON address field affected the record'

# A second complete local deployment exercises readConfig's explicit values.
# Its gate receipt must still be rejected when spliced into the first run.
DEFAULT_REFERRER="$COLLECTOR" LAND_PAUSED=false DEPLOYER="$DEPLOYER" \
  forge script script/DeploySurfaceV2.s.sol --tc DeploySurfaceV2 --rpc-url "$RPC" \
  --unlocked --sender "$DEPLOYER" --slow --broadcast >"$TMP/second-deploy.log"
SECOND_BROADCAST=broadcast/DeploySurfaceV2.s.sol/31337/run-latest.json
SECOND_LAUNCHER="$(jq -r '.transactions[] | select(.transactionType == "CREATE" and .contractName == "Launcher") | .contractAddress' "$SECOND_BROADCAST")"
SECOND_TOKEN_FACTORY="$(jq -r '.transactions[] | select(.transactionType == "CREATE" and .contractName == "CloneFactory") | .contractAddress' "$SECOND_BROADCAST" | head -1)"
SECOND_SALE_FACTORY="$(jq -r '.transactions[] | select(.transactionType == "CREATE" and .contractName == "CloneFactory") | .contractAddress' "$SECOND_BROADCAST" | tail -1)"
eq "$(chain_call "$SECOND_LAUNCHER" 'defaultReferrer()(address)')" "$COLLECTOR" 'explicit default referrer'
eq "$(chain_call "$SECOND_TOKEN_FACTORY" 'paused()(bool)')" false 'explicit token factory unpaused'
eq "$(chain_call "$SECOND_SALE_FACTORY" 'paused()(bool)')" false 'explicit sale factory unpaused'
SECOND_GATE_HASH="$(jq -r '.transactions[] | select(.transactionType == "CREATE" and .contractName == "AllowlistGate") | .hash' broadcast/DeploySurfaceV2.s.sol/31337/run-latest.json)"
jq --arg hash "$SECOND_GATE_HASH" '.transactions[2].hash = $hash' "$TMP/first-broadcast.json" >"$TMP/second-gate.json"
refuses 'second deployment gate hash' 'nonce' "$TMP/second-gate.json"

# Resume must compare the saved transaction plan with today's config before
# forge can send anything. Run an isolated wrapper copy so tracked env values
# and the live checkout are never edited.
mkdir -p "$TMP/resume/script/env" "$TMP/resume/broadcast/DeploySurfaceV2.s.sol/31337"
cp script/deploy.sh "$TMP/resume/script/deploy.sh"
cp "$TMP/first-broadcast.json" "$TMP/resume/broadcast/DeploySurfaceV2.s.sol/31337/run-latest.json"
cp script/env/anvil.env "$TMP/resume/script/env/anvil.env"
printf '\nDEFAULT_REFERRER=%s\n' "$COLLECTOR" >>"$TMP/resume/script/env/anvil.env"
BLOCK_BEFORE="$(cast block-number --rpc-url "$RPC")"
if RPC_URL="$RPC" "$TMP/resume/script/deploy.sh" anvil --resume >"$TMP/resume-referrer.log" 2>&1; then fail 'referrer drift allowed resume'; fi
grep -q 'DEFAULT_REFERRER differs' "$TMP/resume-referrer.log" || fail 'referrer drift failed for the wrong reason'
cp script/env/anvil.env "$TMP/resume/script/env/anvil.env"
printf '\nLAND_PAUSED=false\n' >>"$TMP/resume/script/env/anvil.env"
if RPC_URL="$RPC" "$TMP/resume/script/deploy.sh" anvil --resume >"$TMP/resume-pause.log" 2>&1; then fail 'pause drift allowed resume'; fi
grep -q 'LAND_PAUSED differs' "$TMP/resume-pause.log" || fail 'pause drift failed for the wrong reason'
eq "$(cast block-number --rpc-url "$RPC")" "$BLOCK_BEFORE" "drift checks broadcasted"
cmp -s "$TMP/record.json" "$RECORD" || fail 'drift checks changed record'

send "$TOKEN_FACTORY" 'setPaused(bool)' false
send "$SALE_FACTORY" 'setPaused(bool)' false
LAUNCH_SIG='launch((string,string,address,address,uint256,uint16,address),(uint256,uint64,uint64,uint256,uint256,address,address))'
TOKEN_ARGS="(Shell,SHL,$DEPLOYER,$GATE,10,500,$ZERO)"
SALE_ARGS="($PRICE,0,0,0,0,$ZERO,$ZERO)"
LAUNCHED_TOPIC="$(cast sig-event 'Launched(address,address,address)')"
launch_fields="$(cast send "$LAUNCHER" "$LAUNCH_SIG" "$TOKEN_ARGS" "$SALE_ARGS" \
  --unlocked --from "$DEPLOYER" --rpc-url "$RPC" --json \
  | jq -r --arg topic "$LAUNCHED_TOPIC" --arg launcher "${LAUNCHER,,}" \
    '[.status, ([.logs[] | select((.address | ascii_downcase) == $launcher and .topics[0] == $topic)][0].topics[2]), ([.logs[] | select((.address | ascii_downcase) == $launcher and .topics[0] == $topic)][0].topics[3])] | join("|")')"
IFS='|' read -r launch_status token_topic sale_topic <<<"$launch_fields"
eq "$launch_status" 0x1 'launch status'
COLLECTION="$(cast to-check-sum-address "0x${token_topic: -40}")"
SALE="$(cast to-check-sum-address "0x${sale_topic: -40}")"
eq "$(chain_call "$COLLECTION" 'minter()(address)')" "$SALE" 'collection minter'
eq "$(chain_call "$SALE" 'collection()(address)')" "$COLLECTION" 'sale collection'
eq "$(chain_call "$COLLECTION" 'owner()(address)')" "$DEPLOYER" 'collection owner'
eq "$(chain_call "$TOKEN_FACTORY" 'isInstance(address)(bool)' "$COLLECTION")" true 'token registry'
eq "$(chain_call "$SALE_FACTORY" 'isInstance(address)(bool)' "$SALE")" true 'sale registry'

mint_receipt="$(cast send "$SALE" 'mint(uint256)' 1 --value "$PRICE" \
  --unlocked --from "$COLLECTOR" --rpc-url "$RPC" --json)"
eq "$(printf '%s\n' "$mint_receipt" | jq -r '.status')" 0x1 'mint status'
eq "$(chain_call "$COLLECTION" 'ownerOf(uint256)(address)' 1)" "$COLLECTOR" 'minted owner'
eq "$(chain_call "$SALE" 'pendingWithdrawal(address)(uint256)' "$DEPLOYER")" "$PRICE" 'pending payout'
eq "$(cast balance "$SALE" --rpc-url "$RPC")" "$PRICE" 'sale balance'
OWNER_BEFORE="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
withdraw_receipt="$(cast send "$SALE" 'withdraw(address)' "$DEPLOYER" \
  --unlocked --from "$COLLECTOR" --rpc-url "$RPC" --json)"
eq "$(printf '%s\n' "$withdraw_receipt" | jq -r '.status')" 0x1 'withdraw status'
OWNER_AFTER="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
python3 - "$OWNER_BEFORE" "$OWNER_AFTER" "$PRICE" <<'PY' || fail 'withdraw amount'
import sys
sys.exit(0 if int(sys.argv[2]) - int(sys.argv[1]) == int(sys.argv[3]) else 1)
PY
eq "$(cast balance "$SALE" --rpc-url "$RPC")" 0 'sale after withdraw'

send "$COLLECTION" 'renounceOwnership()'
eq "$(chain_call "$COLLECTION" 'owner()(address)')" "$ZERO" 'renounced owner'
if cast send "$SALE" 'setPrice(uint256)' 1 --unlocked --from "$DEPLOYER" --rpc-url "$RPC" >"$TMP/renounced-setter.log" 2>&1; then
  fail 'sale setter succeeded after renounce'
fi
mint_receipt="$(cast send "$SALE" 'mint(uint256)' 1 --value "$PRICE" \
  --unlocked --from "$COLLECTOR" --rpc-url "$RPC" --json)"
eq "$(printf '%s\n' "$mint_receipt" | jq -r '.status')" 0x1 'mint after renounce'
eq "$(chain_call "$SALE" 'pendingWithdrawal(address)(uint256)' "$DEPLOYER")" "$PRICE" 'post-renounce pending'
send "$SALE" 'withdraw(address)' "$DEPLOYER"
eq "$(cast balance "$SALE" --rpc-url "$RPC")" 0 'post-renounce payout'

BLOCK_BEFORE="$(cast block-number --rpc-url "$RPC")"
RPC_URL="$RPC" DRY_RUN=1 script/deploy.sh anvil >"$TMP/dry-run.log"
eq "$(cast block-number --rpc-url "$RPC")" "$BLOCK_BEFORE" 'dry run broadcasted'
cmp -s "$TMP/record.json" "$RECORD" || fail 'dry run changed record'
echo 'e2e-anvil: deploy, receipt record, refusals, resume guards, lifecycle, and dry run passed'
