#!/usr/bin/env bash
# One deploy path for the Surface v2 system: anvil, sepolia, mainnet. The
# environment is a values file (script/env/<name>.env), never a separate
# script; every guard and every step below runs identically regardless of
# target, gated only by the values that file sets.
#
# Usage:
#   script/deploy.sh <anvil|sepolia|mainnet> [--resume]
#
# Env file values (script/env/<name>.env): CHAIN_ID, FOUNDRY_PROFILE,
# RPC_URL, VERIFY (0/1), REQUIRE_MAIN_BRANCH (0/1), WALLET_MODE
# (keystore|anvil), DEPLOYER, DEFAULT_REFERRER, LAND_PAUSED. No secrets
# live in these files.
#
# Overrides:
#   RPC_URL              overrides the env file's default RPC endpoint.
#   FOUNDRY_PROFILE       overrides the env file's default profile.
#   DEPLOYER_ACCOUNT      keystore account name (~/.foundry/keystores/<name>).
#                         Required when WALLET_MODE=keystore. Shell env only.
#   DEPLOYER_PASSWORD_FILE  path to the keystore password (chmod 600),
#                         instead of an interactive prompt. Shell env only.
#   ETHERSCAN_API_KEY     required when VERIFY=1 and DRY_RUN is not set.
#   DRY_RUN=1             simulate only: REQUIRE_MAIN_BRANCH git guards still
#                         run but only warn on failure (a real broadcast would
#                         refuse); every other guard still hard-fails. No
#                         wallet flags, no --broadcast, no --verify. Nothing
#                         is written.
#
# The deploy record is written by this wrapper, never by the forge script.
# After a real broadcast (or --resume) it takes only the creation tx hashes
# from the broadcast file, re-fetches every receipt from the chain, requires
# exactly the six expected contracts from one signer, re-asserts every value
# the script's postflight checks (a resume skips that simulation), and only
# then merges the addresses, first deploy block and tx hashes into the
# record. A simulation has no receipts, so it can never produce a record.
#   --resume              passthrough to `forge script --resume`, for
#                         recovering a broadcast that stopped part way
#                         (an EIP-7702 delegated signer allows only one
#                         in-flight transaction; --slow is always passed to
#                         avoid this, but a dropped RPC connection mid-run can
#                         still leave a broadcast half-sent).
set -euo pipefail

# The record step below uses associative arrays (bash 4+). Refuse here, before
# anything broadcasts, rather than after (macOS ships bash 3.2 as /bin/bash).
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  echo "refusing: bash ${BASH_VERSION:-unknown} is too old; run with bash 4 or newer (e.g. brew install bash)" >&2
  exit 1
fi
for tool in forge cast jq; do
  command -v "$tool" >/dev/null || { echo "refusing: $tool is not on PATH" >&2; exit 1; }
done

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  anvil | sepolia | mainnet) ;;
  *)
    echo "usage: script/deploy.sh <anvil|sepolia|mainnet> [--resume]" >&2
    exit 1
    ;;
esac

RESUME_FLAG=0
if [ "${2:-}" = "--resume" ]; then
  RESUME_FLAG=1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="script/env/${ENV_NAME}.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

DRY_RUN="${DRY_RUN:-0}"
# A caller-exported RPC_URL/FOUNDRY_PROFILE wins over the env file's default;
# snapshot before sourcing, which would otherwise overwrite it.
RPC_URL_OVERRIDE="${RPC_URL:-}"
FOUNDRY_PROFILE_OVERRIDE="${FOUNDRY_PROFILE:-}"

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

[ -z "$RPC_URL_OVERRIDE" ] || RPC_URL="$RPC_URL_OVERRIDE"
[ -z "$FOUNDRY_PROFILE_OVERRIDE" ] || FOUNDRY_PROFILE="$FOUNDRY_PROFILE_OVERRIDE"
export FOUNDRY_PROFILE

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# mainnet.env ships DEPLOYER and DEFAULT_REFERRER empty until they are
# decided; refuse before touching any RPC, DRY_RUN included.
if [ "$ENV_NAME" = "mainnet" ]; then
  for var in DEPLOYER DEFAULT_REFERRER; do
    [ -n "${!var:-}" ] || {
      echo "refusing: $ENV_FILE has no $var set. Fill in the mainnet env file first." >&2
      exit 1
    }
  done
fi

[ -n "${RPC_URL:-}" ] || { echo "refusing: no RPC_URL configured for $ENV_NAME" >&2; exit 1; }
[ -n "${CHAIN_ID:-}" ] || { echo "refusing: $ENV_FILE has no CHAIN_ID set" >&2; exit 1; }

# The repo's canonical per-chain record (see contracts/README.md):
# deployments.mainnet.json and deployments.sepolia.json already carry the v1
# protocol's addresses, deployments.anvil.json is the local-chain equivalent
# and is gitignored.
case "$ENV_NAME" in
  mainnet) RECORD_FILE="deployments.mainnet.json" ;;
  sepolia) RECORD_FILE="deployments.sepolia.json" ;;
  anvil) RECORD_FILE="deployments.anvil.json" ;;
esac

echo "== deploy.sh $ENV_NAME =="
echo "  rpc      $RPC_URL"
echo "  profile  $FOUNDRY_PROFILE"
echo "  dry run  $DRY_RUN"
echo "  resume   $RESUME_FLAG"

# --- guards: identical code path for every target, switched only by the env
#     file's values ------------------------------------------------------

ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
[ "$ACTUAL_CHAIN_ID" = "$CHAIN_ID" ] \
  || { echo "refusing: $RPC_URL reports chain id $ACTUAL_CHAIN_ID, expected $CHAIN_ID" >&2; exit 1; }
echo "  ok: chain id $ACTUAL_CHAIN_ID"

if [ "${REQUIRE_MAIN_BRANCH:-0}" = "1" ]; then
  # A real broadcast refuses on any failure here. Under DRY_RUN=1 the same
  # checks still run, but a failure only warns what a real broadcast would
  # refuse: DRY_RUN broadcasts nothing.
  git_guard_fail() {
    if [ "$DRY_RUN" = "1" ]; then
      echo "  warn: a real broadcast would refuse: $1" >&2
    else
      echo "refusing: $1" >&2
      exit 1
    fi
  }

  DEPLOY_BRANCH="$(git branch --show-current)"
  [ "$DEPLOY_BRANCH" = "main" ] || git_guard_fail "deployments must run from main (currently on $DEPLOY_BRANCH)"
  git fetch --quiet origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
    || git_guard_fail "local main is not the fetched origin/main commit"
  git diff --quiet && git diff --cached --quiet \
    || git_guard_fail "tracked files are dirty; deployment commit is not exact"
  # deployments.anvil.json is gitignored and never appears here; a real
  # sepolia/mainnet broadcast rewrites the already-tracked record in place,
  # which the dirty-tree check above catches on the next run, not this one.
  [ -z "$(git ls-files --others --exclude-standard)" ] \
    || git_guard_fail "untracked files exist; deployment commit is not exact"
  [ "$DRY_RUN" = "1" ] || echo "  ok: clean, exact, fetched main"
fi

if [ "$VERIFY" = "1" ] && [ "$DRY_RUN" != "1" ]; then
  : "${ETHERSCAN_API_KEY:?VERIFY=1 for $ENV_NAME requires ETHERSCAN_API_KEY}"
  echo "  ok: ETHERSCAN_API_KEY set"
fi

# --- wallet ---------------------------------------------------------------

WALLET_ARGS=()
SLOW_ARGS=()
if [ "$DRY_RUN" != "1" ]; then
  case "$WALLET_MODE" in
    keystore)
      : "${DEPLOYER_ACCOUNT:?WALLET_MODE=keystore requires DEPLOYER_ACCOUNT}"
      if [ -n "${DEPLOYER_PASSWORD_FILE:-}" ]; then
        [ -r "$DEPLOYER_PASSWORD_FILE" ] \
          || { echo "refusing: DEPLOYER_PASSWORD_FILE is not readable" >&2; exit 1; }
        WALLET_ARGS=(--account "$DEPLOYER_ACCOUNT" --password-file "$DEPLOYER_PASSWORD_FILE")
      else
        WALLET_ARGS=(--account "$DEPLOYER_ACCOUNT")
      fi
      ;;
    anvil)
      WALLET_ARGS=(--unlocked --sender "$DEPLOYER")
      ;;
    *)
      echo "refusing: unknown WALLET_MODE=$WALLET_MODE in $ENV_FILE" >&2
      exit 1
      ;;
  esac

  # An EIP-7702 delegated account (code prefix 0xef0100) accepts only one
  # in-flight transaction; a node rejects the rest as gapped-nonce. --slow
  # sends one transaction at a time and waits for its receipt, so it is
  # always passed regardless of delegation, but a delegated deployer is
  # flagged here since a dropped --slow elsewhere would otherwise fail late.
  if [ -n "${DEPLOYER:-}" ]; then
    DEPLOYER_CODE="$(cast code "$DEPLOYER" --rpc-url "$RPC_URL")"
    case "$DEPLOYER_CODE" in
      0xef0100*) echo "  warn: $DEPLOYER is EIP-7702 delegated; broadcasting with --slow" >&2 ;;
    esac
  fi
  SLOW_ARGS=(--slow)
fi

# --- run --------------------------------------------------------------

# DEFAULT_REFERRER/DEPLOYER are already exported by
# `set -a` when the env file was sourced above, blank or not: forge's typed
# env cheatcodes (vm.envAddress/envBool via vm.envOr) fall through to the
# script's default on a variable that is set but empty, same as when it is
# unset entirely (verified against forge 1.8.1).
export LAND_PAUSED="${LAND_PAUSED:-true}"
BROADCAST_FILE="broadcast/DeploySurfaceV2.s.sol/${CHAIN_ID}/run-latest.json"

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN=1: simulating only, nothing will be broadcast or written"
  # --sender resolves the script's deployer-address checks even without a
  # wallet: no private key is needed to simulate as a given address.
  DRY_RUN_SENDER_ARGS=()
  [ -z "${DEPLOYER:-}" ] || DRY_RUN_SENDER_ARGS=(--sender "$DEPLOYER")
  forge script script/DeploySurfaceV2.s.sol --tc DeploySurfaceV2 --rpc-url "$RPC_URL" "${DRY_RUN_SENDER_ARGS[@]}"
  echo "dry run complete for $ENV_NAME"
  exit 0
fi

FORGE_ARGS=(script script/DeploySurfaceV2.s.sol --tc DeploySurfaceV2 --rpc-url "$RPC_URL" "${WALLET_ARGS[@]}" "${SLOW_ARGS[@]}" --broadcast)
[ "$RESUME_FLAG" = "1" ] && FORGE_ARGS+=(--resume)
if [ "$VERIFY" = "1" ]; then
  # forge reads ETHERSCAN_API_KEY from the environment; the key stays out of argv.
  FORGE_ARGS+=(--verify)
fi
forge "${FORGE_ARGS[@]}"

# --- post-broadcast: build the record from on-chain receipts --------------

[ -f "$BROADCAST_FILE" ] || { echo "no broadcast file at $BROADCAST_FILE" >&2; exit 1; }

refuse() { echo "refusing to record: $1" >&2; exit 1; }
ZERO_ADDRESS=0x0000000000000000000000000000000000000000
MAINNET_DEPLOYER=0xCB43078C32423F5348Cab5885911C3B5faE217F9
call() { cast call "$1" "$2" --rpc-url "$RPC_URL"; }

# Only the contract name and tx hash are taken from the broadcast file; the
# address, status, block and sender all come from a fresh on-chain receipt.
CREATES="$(jq -r '.transactions[] | select(.transactionType == "CREATE") | [.contractName, .hash] | @tsv' "$BROADCAST_FILE")"
[ "$(printf '%s\n' "$CREATES" | grep -c .)" = "6" ] \
  || refuse "expected exactly 6 CREATE transactions in $BROADCAST_FILE"

declare -A ADDR TX SEEN
FACTORIES=()
FIRST_BLOCK=""
SIGNER=""
while IFS=$'\t' read -r name tx; do
  [[ "$tx" =~ ^0x[0-9a-fA-F]{64}$ ]] || refuse "malformed tx hash $tx for $name"
  receipt="$(cast receipt "$tx" --json --rpc-url "$RPC_URL")" || refuse "no on-chain receipt for $name tx $tx"
  status="$(jq -r '.status' <<< "$receipt")"
  [ "$status" = "0x1" ] || [ "$status" = "1" ] || refuse "$name creation tx $tx has status $status"
  addr="$(jq -r '.contractAddress // empty' <<< "$receipt")"
  [ -n "$addr" ] || refuse "$name tx $tx created no contract"
  addr="$(cast to-check-sum-address "$addr")"
  from="$(cast to-check-sum-address "$(jq -r '.from' <<< "$receipt")")"
  [ -z "$SIGNER" ] && SIGNER="$from"
  [ "$from" = "$SIGNER" ] || refuse "$name was deployed by $from, the rest by $SIGNER"
  [ -z "${SEEN[$addr]:-}" ] || refuse "address $addr appears twice"
  SEEN[$addr]=1
  code="$(cast code "$addr" --rpc-url "$RPC_URL")"
  [ -n "$code" ] && [ "$code" != "0x" ] || refuse "$name at $addr has no code on chain"
  dec_block="$(cast to-dec "$(jq -r '.blockNumber' <<< "$receipt")")"
  { [ -z "$FIRST_BLOCK" ] || [ "$dec_block" -lt "$FIRST_BLOCK" ]; } && FIRST_BLOCK="$dec_block"
  case "$name" in
    Surface) key=surfaceImplV2 ;;
    FixedPriceSale) key=saleImplV2 ;;
    AllowlistGate) key=allowlistGate ;;
    Launcher) key=launcherV2 ;;
    CloneFactory) FACTORIES+=("$addr $tx"); continue ;;
    *) refuse "unexpected contract $name in $BROADCAST_FILE" ;;
  esac
  [ -z "${ADDR[$key]:-}" ] || refuse "$name appears twice in $BROADCAST_FILE"
  ADDR[$key]="$addr"; TX[$key]="$tx"
done <<< "$CREATES"
[ "${#FACTORIES[@]}" = "2" ] || refuse "expected exactly 2 CloneFactory deployments"

# The two factories share a contract name; tell them apart by what each one
# clones, read back on chain.
for entry in "${FACTORIES[@]}"; do
  read -r addr tx <<< "$entry"
  impl="$(cast to-check-sum-address "$(call "$addr" 'implementation()(address)')")"
  if [ "$impl" = "${ADDR[surfaceImplV2]:-}" ]; then key=surfaceFactoryV2
  elif [ "$impl" = "${ADDR[saleImplV2]:-}" ]; then key=saleFactoryV2
  else refuse "CloneFactory $addr clones unknown implementation $impl"
  fi
  [ -z "${ADDR[$key]:-}" ] || refuse "two factories clone $impl"
  ADDR[$key]="$addr"; TX[$key]="$tx"
done

KEYS=(surfaceImplV2 saleImplV2 allowlistGate surfaceFactoryV2 saleFactoryV2 launcherV2)
for key in "${KEYS[@]}"; do
  [ -n "${ADDR[$key]:-}" ] || refuse "no $key in $BROADCAST_FILE"
done

# --- re-assert the script's postflight on chain --------------------------
# A --resume does not re-simulate the Solidity script, so every value its
# postflight checks is checked again here before anything is written.

expect() { # <label> <actual> <expected>
  [ "$(lower "$2")" = "$(lower "$3")" ] || refuse "$1 is $2, expected $3"
}
[ "$ENV_NAME" != "mainnet" ] || expect "mainnet signer" "$SIGNER" "$MAINNET_DEPLOYER"
[ -z "${DEPLOYER:-}" ] || expect "signer" "$SIGNER" "$DEPLOYER"
WANT_REFERRER="${DEFAULT_REFERRER:-}"
[ -n "$WANT_REFERRER" ] || WANT_REFERRER="$ZERO_ADDRESS"
[ "$ENV_NAME" != "mainnet" ] || [ "$WANT_REFERRER" != "$ZERO_ADDRESS" ] || refuse "mainnet requires DEFAULT_REFERRER"

expect "surfaceImplV2.version()" "$(call "${ADDR[surfaceImplV2]}" 'version()(uint256)')" 2
expect "saleImplV2.version()" "$(call "${ADDR[saleImplV2]}" 'version()(uint256)')" 2
SURFACE_INIT="$(cast sig 'initialize(string,string,address,address,uint256,uint16,address,address)')"
SALE_INIT="$(cast sig 'initialize(address,uint256,uint64,uint64,uint256,uint256,address,address,address)')"
for pair in "surfaceFactoryV2:$SURFACE_INIT" "saleFactoryV2:$SALE_INIT"; do
  key="${pair%%:*}"; sel="${pair#*:}"
  expect "$key.initSelector()" "$(call "${ADDR[$key]}" 'initSelector()(bytes4)')" "$sel"
  expect "$key.deployer()" "$(call "${ADDR[$key]}" 'deployer()(address)')" "$SIGNER"
  expect "$key.paused()" "$(call "${ADDR[$key]}" 'paused()(bool)')" "$LAND_PAUSED"
  expect "$key.deprecated()" "$(call "${ADDR[$key]}" 'deprecated()(bool)')" false
done
expect "launcherV2.tokenFactory()" "$(call "${ADDR[launcherV2]}" 'tokenFactory()(address)')" "${ADDR[surfaceFactoryV2]}"
expect "launcherV2.saleFactory()" "$(call "${ADDR[launcherV2]}" 'saleFactory()(address)')" "${ADDR[saleFactoryV2]}"
expect "launcherV2.owner()" "$(call "${ADDR[launcherV2]}" 'owner()(address)')" "$SIGNER"
expect "launcherV2.defaultReferrer()" "$(call "${ADDR[launcherV2]}" 'defaultReferrer()(address)')" "$WANT_REFERRER"
echo "  ok: on-chain wiring matches the deploy config (signer $SIGNER)"

UPDATE='.chainId = ($chainId | tonumber) | .factoryDeployBlock = ($block | tonumber) | .txHashes = {}'
JQ_ARGS=(--arg chainId "$CHAIN_ID" --arg block "$FIRST_BLOCK")
for key in "${KEYS[@]}"; do
  UPDATE+=" | .${key} = \$a_${key} | .txHashes.${key} = \$t_${key}"
  JQ_ARGS+=(--arg "a_${key}" "${ADDR[$key]}" --arg "t_${key}" "${TX[$key]}")
done
[ -f "$RECORD_FILE" ] || echo '{}' > "$RECORD_FILE"
TMP_RECORD="$(mktemp)"
jq "${JQ_ARGS[@]}" "$UPDATE" "$RECORD_FILE" > "$TMP_RECORD"
mv "$TMP_RECORD" "$RECORD_FILE"
echo "  ok: recorded ${#KEYS[@]} contracts from receipts, first block $FIRST_BLOCK"

case "$ENV_NAME" in
  mainnet) echo "  explorer  https://evm.now/address/${ADDR[launcherV2]}?chainId=1" ;;
  sepolia) echo "  explorer  https://sepolia.etherscan.io/address/${ADDR[launcherV2]}" ;;
  anvil) : ;;
esac

echo "deploy complete for $ENV_NAME: $RECORD_FILE"
