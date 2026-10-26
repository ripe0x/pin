#!/usr/bin/env bash
# End-to-end test of the Surface v2 deploy path and a full collection
# lifecycle on a throwaway local anvil chain. Runs locally and in CI:
#
#   script/test/e2e-anvil.sh            (from contracts/)
#
# 1. script/deploy.sh anvil: real broadcast, record built from receipts.
# 2. The record's six addresses have code and match on-chain wiring.
# 3. A DRY_RUN leaves the record byte-identical.
# 4. Lifecycle driven with cast: unpause, set the default referrer, launch,
#    mint through both entrypoints, wallet cap, close, withdraw, renounce,
#    and the frozen-after-renounce checks.
# 5. The record step refuses tampered broadcast files (RECORD_ONLY=1, which
#    never broadcasts) and config drift before a resume.
#
# Needs bash 4+, anvil, forge, cast, jq. Uses its own port; never touches a
# public chain. Restores script/env/anvil.env and removes
# deployments.anvil.json on exit.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PORT="${E2E_ANVIL_PORT:-8547}"
export RPC_URL="http://127.0.0.1:${PORT}"
ENV_FILE=script/env/anvil.env
RECORD=deployments.anvil.json
BROADCAST=broadcast/DeploySurfaceV2.s.sol/31337/run-latest.json
WORK="$(mktemp -d)"
ANVIL_PID=""

cleanup() {
  [ -z "$ANVIL_PID" ] || kill "$ANVIL_PID" 2>/dev/null || true
  [ ! -f "$WORK/anvil.env" ] || cp "$WORK/anvil.env" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
  rm -f "$RECORD"
  rm -rf "$WORK"
}
trap cleanup EXIT
cp "$ENV_FILE" "$WORK/anvil.env"

PASS=0
pass() { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { echo "  FAIL $1" >&2; exit 1; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
assert_eq() { [ "$(lower "$2")" = "$(lower "$3")" ] && pass "$1" || fail "$1: got $2, expected $3"; }
call() { cast call "$@" --rpc-url "$RPC_URL"; }
num() { cast call "$@" --rpc-url "$RPC_URL" | awk '{print $1}'; }
send() { local from="$1"; shift; cast send --unlocked --from "$from" "$@" --rpc-url "$RPC_URL" --json; }
reverts() { local label="$1" from="$2"; shift 2
  if cast send --unlocked --from "$from" "$@" --rpc-url "$RPC_URL" >/dev/null 2>&1; then fail "$label should revert"; else pass "$label reverts"; fi
}
balance() { cast balance "$1" --rpc-url "$RPC_URL"; }
# ETH balances overflow bash arithmetic (int64); add them exactly.
add() { python3 -c "import sys; print(int(sys.argv[1]) + int(sys.argv[2]))" "$1" "$2"; }

# anvil's default unlocked accounts.
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ARTIST=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
COLLECTOR=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
HOST=0x90F79bf6EB2c4f870365E785982E1f101E93b906
PND=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
ZERO=0x0000000000000000000000000000000000000000
PRICE=10000000000000000 # 0.01 ETH

echo "== e2e-anvil: starting anvil on $PORT"
anvil --port "$PORT" --silent &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep 0.2; done
cast chain-id --rpc-url "$RPC_URL" >/dev/null || fail "anvil did not start"
rm -f "$RECORD"

echo "== 1-3. deploy, record, dry run"
script/deploy.sh anvil > "$WORK/deploy.log" 2>&1 || { tail -30 "$WORK/deploy.log"; fail "deploy.sh anvil"; }
pass "deploy.sh anvil broadcast"
for key in surfaceImplV2 saleImplV2 allowlistGate surfaceFactoryV2 saleFactoryV2 launcherV2; do
  addr="$(jq -r ".$key" "$RECORD")"
  [ "$(cast code "$addr" --rpc-url "$RPC_URL")" != "0x" ] || fail "$key $addr has no code"
  [ "$(jq -r ".txHashes.$key" "$RECORD")" != "null" ] || fail "$key has no tx hash"
done
pass "record: six addresses with code and tx hashes"
TOKEN_FACTORY="$(jq -r .surfaceFactoryV2 "$RECORD")"
SALE_FACTORY="$(jq -r .saleFactoryV2 "$RECORD")"
LAUNCHER="$(jq -r .launcherV2 "$RECORD")"
GATE="$(jq -r .allowlistGate "$RECORD")"
assert_eq "launcher.tokenFactory" "$(call "$LAUNCHER" 'tokenFactory()(address)')" "$TOKEN_FACTORY"
assert_eq "launcher.saleFactory" "$(call "$LAUNCHER" 'saleFactory()(address)')" "$SALE_FACTORY"
assert_eq "tokenFactory.implementation" "$(call "$TOKEN_FACTORY" 'implementation()(address)')" "$(jq -r .surfaceImplV2 "$RECORD")"
assert_eq "saleFactory.implementation" "$(call "$SALE_FACTORY" 'implementation()(address)')" "$(jq -r .saleImplV2 "$RECORD")"
assert_eq "factories land paused" "$(call "$TOKEN_FACTORY" 'paused()(bool)')" true

cp "$RECORD" "$WORK/record.json"
DRY_RUN=1 script/deploy.sh anvil > "$WORK/dry.log" 2>&1 || { tail -20 "$WORK/dry.log"; fail "DRY_RUN"; }
cmp -s "$RECORD" "$WORK/record.json" && pass "DRY_RUN leaves the record unchanged" || fail "DRY_RUN changed the record"
cp "$BROADCAST" "$WORK/run1.json"

echo "== 4. lifecycle"
reverts "launch while paused" "$ARTIST" "$LAUNCHER" \
  'launch((string,string,address,address,uint256,uint16,address),(uint256,uint64,uint64,uint256,uint256,address,address))' \
  "(E2E,E2E,$ARTIST,$GATE,0,500,$ZERO)" "($PRICE,0,0,0,0,$ZERO,$ZERO)"
send "$DEPLOYER" "$TOKEN_FACTORY" 'setPaused(bool)' false >/dev/null
send "$DEPLOYER" "$SALE_FACTORY" 'setPaused(bool)' false >/dev/null
send "$DEPLOYER" "$LAUNCHER" 'setDefaultReferrer(address)' "$PND" >/dev/null
assert_eq "launcher.defaultReferrer set" "$(call "$LAUNCHER" 'defaultReferrer()(address)')" "$PND"
reverts "setDefaultReferrer by non-owner" "$ARTIST" "$LAUNCHER" 'setDefaultReferrer(address)' "$ARTIST"

RENDERER="$(forge create script/mocks/MockRenderer.sol:MockRenderer --unlocked --from "$DEPLOYER" \
  --rpc-url "$RPC_URL" --broadcast --json --constructor-args E2E "#123456" | jq -r .deployedTo)"
[ "$(cast code "$RENDERER" --rpc-url "$RPC_URL")" != "0x" ] || fail "renderer deploy"

RCPT="$(send "$ARTIST" "$LAUNCHER" \
  'launch((string,string,address,address,uint256,uint16,address),(uint256,uint64,uint64,uint256,uint256,address,address))' \
  "(E2E,E2E,$ARTIST,$RENDERER,5,500,$ZERO)" "($PRICE,0,0,0,0,$ZERO,$ZERO)")"
LAUNCHED_TOPIC="$(cast keccak 'Launched(address,address,address)')"
LOG="$(jq -c --arg t "$LAUNCHED_TOPIC" '.logs[] | select(.topics[0] == $t)' <<< "$RCPT")"
[ "$(printf '%s\n' "$LOG" | grep -c .)" = "1" ] || fail "exactly one Launched event"
TOKEN="$(cast parse-bytes32-address "$(jq -r '.topics[2]' <<< "$LOG")")"
SALE="$(cast parse-bytes32-address "$(jq -r '.topics[3]' <<< "$LOG")")"
pass "launch emitted one Launched event"
assert_eq "token.minter is the sale" "$(call "$TOKEN" 'minter()(address)')" "$SALE"
assert_eq "token.owner is the artist" "$(call "$TOKEN" 'owner()(address)')" "$ARTIST"
assert_eq "royalty receiver defaults to owner" "$(call "$TOKEN" 'royaltyReceiver()(address)')" "$ARTIST"
assert_eq "payout defaults to owner" "$(call "$SALE" 'payoutRecipient()(address)')" "$ARTIST"
assert_eq "sale copied the default referrer" "$(call "$SALE" 'defaultReferrer()(address)')" "$PND"
assert_eq "tokenFactory.isInstance(token)" "$(call "$TOKEN_FACTORY" 'isInstance(address)(bool)' "$TOKEN")" true
assert_eq "saleFactory.isInstance(sale)" "$(call "$SALE_FACTORY" 'isInstance(address)(bool)' "$SALE")" true

# mint(quantity): 5% to PND.
send "$COLLECTOR" "$SALE" 'mint(uint256)' 2 --value "$((2 * PRICE))" >/dev/null
assert_eq "mint: collector owns token 1" "$(call "$TOKEN" 'ownerOf(uint256)(address)' 1)" "$COLLECTOR"
assert_eq "mint: PND referral 5%" "$(num "$SALE" 'pendingWithdrawal(address)(uint256)' "$PND")" "$((2 * PRICE / 10000 * 500))"
reverts "mint with wrong payment" "$COLLECTOR" "$SALE" 'mint(uint256)' 1 --value 1

# mintWithReferral: a host referrer, then the artist's own site (100% artist).
send "$COLLECTOR" "$SALE" 'mintWithReferral(address,uint256,address,bytes)' "$COLLECTOR" 1 "$HOST" 0x --value "$PRICE" >/dev/null
assert_eq "mintWithReferral: host referral 5%" "$(num "$SALE" 'pendingWithdrawal(address)(uint256)' "$HOST")" "$((PRICE / 10000 * 500))"
ARTIST_BEFORE="$(num "$SALE" 'pendingWithdrawal(address)(uint256)' "$ARTIST")"
send "$COLLECTOR" "$SALE" 'mintWithReferral(address,uint256,address,bytes)' "$COLLECTOR" 1 "$ARTIST" 0x --value "$PRICE" >/dev/null
assert_eq "artist as referrer keeps 100%" "$(num "$SALE" 'pendingWithdrawal(address)(uint256)' "$ARTIST")" "$((ARTIST_BEFORE + PRICE))"

# Wallet cap applied mid-sale counts the earlier uncapped mints (4 so far).
send "$ARTIST" "$SALE" 'setWalletCap(uint256)' 4 >/dev/null
reverts "wallet cap counts earlier mints" "$COLLECTOR" "$SALE" 'mint(uint256)' 1 --value "$PRICE"
send "$ARTIST" "$SALE" 'setWalletCap(uint256)' 0 >/dev/null

# Supply cap 5: one left, then exhausted.
send "$HOST" "$SALE" 'mint(uint256)' 1 --value "$PRICE" >/dev/null
reverts "supply cap reached" "$HOST" "$SALE" 'mint(uint256)' 1 --value "$PRICE"
assert_eq "totalSupply at cap" "$(num "$TOKEN" 'totalSupply()(uint256)')" 5

# Burn never frees cap.
send "$COLLECTOR" "$TOKEN" 'burn(uint256)' 1 >/dev/null
assert_eq "burn lowers totalSupply" "$(num "$TOKEN" 'totalSupply()(uint256)')" 4
reverts "burn does not free cap" "$HOST" "$SALE" 'mint(uint256)' 1 --value "$PRICE"

# Pull payments.
SALE_BAL="$(balance "$SALE")"
OWED_TOTAL=0
for who in "$ARTIST" "$PND" "$HOST"; do OWED_TOTAL=$((OWED_TOTAL + $(num "$SALE" 'pendingWithdrawal(address)(uint256)' "$who"))); done
assert_eq "sale balance equals pending" "$SALE_BAL" "$OWED_TOTAL"
ARTIST_ETH="$(balance "$ARTIST")"
OWED="$(num "$SALE" 'pendingWithdrawal(address)(uint256)' "$ARTIST")"
send "$COLLECTOR" "$SALE" 'withdraw(address)' "$ARTIST" >/dev/null
assert_eq "withdraw by anyone pays the account" "$(balance "$ARTIST")" "$(add "$ARTIST_ETH" "$OWED")"
DEST=0x000000000000000000000000000000000000bEEF
PND_OWED="$(num "$SALE" 'pendingWithdrawal(address)(uint256)' "$PND")"
send "$PND" "$SALE" 'withdrawTo(address)' "$DEST" >/dev/null
assert_eq "withdrawTo sends the caller's balance" "$(balance "$DEST")" "$PND_OWED"

# Close is one-way; renounce freezes token, sale and gate config, payouts flow.
send "$ARTIST" "$SALE" 'close()' >/dev/null
assert_eq "sale closed" "$(call "$SALE" 'closed()(bool)')" true
send "$ARTIST" "$TOKEN" 'renounceOwnership()' >/dev/null
assert_eq "owner is zero after renounce" "$(call "$TOKEN" 'owner()(address)')" "$ZERO"
reverts "token setMinter after renounce" "$ARTIST" "$TOKEN" 'setMinter(address)' "$ARTIST"
reverts "token setName after renounce" "$ARTIST" "$TOKEN" 'setName(string,string)' x y
reverts "sale setPrice after renounce" "$ARTIST" "$SALE" 'setPrice(uint256)' 1
reverts "gate setRoot after renounce" "$ARTIST" "$GATE" 'setRoot(address,bytes32)' "$TOKEN" 0x01
HOST_OWED="$(num "$SALE" 'pendingWithdrawal(address)(uint256)' "$HOST")"
HOST_ETH="$(balance "$HOST")"
send "$COLLECTOR" "$SALE" 'withdraw(address)' "$HOST" >/dev/null
assert_eq "payouts flow after renounce" "$(balance "$HOST")" "$(add "$HOST_ETH" "$HOST_OWED")"
assert_eq "sale balance drained" "$(balance "$SALE")" 0

echo "== 5. record step refuses tampering (RECORD_ONLY=1, no broadcast)"
record_only() { # <label> <broadcast file> <expect: ok|refuse>
  cp "$2" "$BROADCAST"
  if RECORD_ONLY=1 script/deploy.sh anvil > "$WORK/rec.log" 2>&1; then
    [ "$3" = "ok" ] && pass "$1" || { tail -5 "$WORK/rec.log"; fail "$1 should be refused"; }
  else
    [ "$3" = "refuse" ] && grep -q "refusing" "$WORK/rec.log" && pass "$1 refused" \
      || { tail -5 "$WORK/rec.log"; fail "$1"; }
  fi
}
# A fresh second deployment is the baseline (run 1 was reconfigured by the
# lifecycle above, so it no longer matches the env); run 1 supplies hashes
# of a real but different deployment to splice in.
script/deploy.sh anvil > "$WORK/deploy2.log" 2>&1 || fail "second deploy"
cp "$BROADCAST" "$WORK/run2.json"
record_only "untouched broadcast re-records" "$WORK/run2.json" ok
hash_of() { jq -r --arg n "$2" '.transactions[] | select(.contractName == $n) | .hash' "$1" | head -1; }
swap_hash() { jq --arg a "$2" --arg b "$3" '(.transactions[] | select(.hash == $a) | .hash) |= $b' "$1"; }

PAUSE_TX="$(jq -r '.transactions[] | select(.transactionType == "CALL") | .hash' "$WORK/run2.json" | head -1)"
swap_hash "$WORK/run2.json" "$(hash_of "$WORK/run2.json" Launcher)" "$PAUSE_TX" > "$WORK/t1.json"
record_only "Launcher hash swapped for a non-CREATE tx" "$WORK/t1.json" refuse
swap_hash "$WORK/run2.json" "$(hash_of "$WORK/run2.json" Surface)" "$(hash_of "$WORK/run1.json" Surface)" > "$WORK/t2.json"
record_only "implementation hash from another deployment" "$WORK/t2.json" refuse
swap_hash "$WORK/run2.json" "$(hash_of "$WORK/run2.json" Launcher)" "$(hash_of "$WORK/run1.json" Launcher)" > "$WORK/t3.json"
record_only "launcher hash from another deployment" "$WORK/t3.json" refuse
jq '.transactions += [.transactions[0]]' "$WORK/run2.json" > "$WORK/t4.json"
record_only "an extra CREATE" "$WORK/t4.json" refuse
jq '(.transactions[] | select(.contractName == "AllowlistGate") | .contractName) |= "Surface"' "$WORK/run2.json" > "$WORK/t5.json"
record_only "a relabelled contract" "$WORK/t5.json" refuse
jq '(.transactions[] | select(.contractName == "Launcher") | .contractAddress) |= "0x0000000000000000000000000000000000000001"' \
  "$WORK/run2.json" > "$WORK/t6.json"
record_only "a lying file address is ignored" "$WORK/t6.json" ok
REAL_LAUNCHER="$(jq -r '.transactions[] | select(.contractName == "Launcher") | .contractAddress' "$WORK/run2.json")"
assert_eq "record keeps the chain's launcher address" "$(jq -r .launcherV2 "$RECORD")" "$REAL_LAUNCHER"

# Config drift before a resume: the on-chain state no longer matches the env.
sed -i.bak 's/^DEFAULT_REFERRER=.*/DEFAULT_REFERRER=0x000000000000000000000000000000000000dEaD/' "$ENV_FILE"
record_only "DEFAULT_REFERRER drift" "$WORK/run2.json" refuse
cp "$WORK/anvil.env" "$ENV_FILE"
sed -i.bak 's/^LAND_PAUSED=.*/LAND_PAUSED=false/' "$ENV_FILE"
record_only "LAND_PAUSED drift" "$WORK/run2.json" refuse
cp "$WORK/anvil.env" "$ENV_FILE"
rm -f "$ENV_FILE.bak"
reverts_wrapper() { if DRY_RUN=1 RECORD_ONLY=1 script/deploy.sh anvil >/dev/null 2>&1; then fail "$1"; else pass "$1"; fi; }
reverts_wrapper "DRY_RUN with RECORD_ONLY is refused"

echo "== e2e-anvil: $PASS checks passed"
