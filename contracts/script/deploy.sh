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
# The deploy record is written by this wrapper, never by the forge script:
# after a real broadcast it reads the broadcast receipts, checks each
# receipt succeeded and each address has code on chain, and only then merges
# the addresses, deploy block and tx hashes into the record. A simulation
# has no receipts, so it can never produce a record.
#   --resume              passthrough to `forge script --resume`, for
#                         recovering a broadcast that stopped part way
#                         (an EIP-7702 delegated signer allows only one
#                         in-flight transaction; --slow is always passed to
#                         avoid this, but a dropped RPC connection mid-run can
#                         still leave a broadcast half-sent).
set -euo pipefail

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

# --- post-broadcast: build the record from the broadcast receipts ---------

[ -f "$BROADCAST_FILE" ] || { echo "no broadcast file at $BROADCAST_FILE" >&2; exit 1; }

# CREATE transactions in deploy order, joined to their receipts:
# "<contractName> <address> <txHash> <blockNumber> <status>" per line.
CREATES="$(jq -r '
  (.receipts | map({key: .transactionHash, value: .}) | from_entries) as $r
  | .transactions[]
  | select(.transactionType == "CREATE")
  | [.contractName, .contractAddress, .hash, $r[.hash].blockNumber, $r[.hash].status]
  | @tsv' "$BROADCAST_FILE")"

declare -A ADDR TX
FACTORIES=()
FIRST_BLOCK=""
while IFS=$'\t' read -r name addr tx block status; do
  [ -n "$name" ] || continue
  [ "$status" = "0x1" ] || { echo "refusing to record: $name creation tx $tx has status $status" >&2; exit 1; }
  addr="$(cast to-check-sum-address "$addr")"
  code="$(cast code "$addr" --rpc-url "$RPC_URL")"
  [ "$code" != "0x" ] && [ -n "$code" ] || { echo "refusing to record: $name at $addr has no code on chain" >&2; exit 1; }
  dec_block="$(cast to-dec "$block")"
  { [ -z "$FIRST_BLOCK" ] || [ "$dec_block" -lt "$FIRST_BLOCK" ]; } && FIRST_BLOCK="$dec_block"
  case "$name" in
    Surface) ADDR[surfaceImplV2]="$addr"; TX[surfaceImplV2]="$tx" ;;
    FixedPriceSale) ADDR[saleImplV2]="$addr"; TX[saleImplV2]="$tx" ;;
    AllowlistGate) ADDR[allowlistGate]="$addr"; TX[allowlistGate]="$tx" ;;
    CloneFactory) FACTORIES+=("$addr $tx") ;;
    Launcher) ADDR[launcherV2]="$addr"; TX[launcherV2]="$tx" ;;
    *) echo "refusing to record: unexpected contract $name in $BROADCAST_FILE" >&2; exit 1 ;;
  esac
done <<< "$CREATES"

# The two factories share a contract name; tell them apart by what each one
# clones, read back on chain.
for entry in "${FACTORIES[@]}"; do
  read -r addr tx <<< "$entry"
  impl="$(cast call "$addr" 'implementation()(address)' --rpc-url "$RPC_URL")"
  if [ "$(lower "$impl")" = "$(lower "${ADDR[surfaceImplV2]:-}")" ]; then
    ADDR[surfaceFactoryV2]="$addr"; TX[surfaceFactoryV2]="$tx"
  elif [ "$(lower "$impl")" = "$(lower "${ADDR[saleImplV2]:-}")" ]; then
    ADDR[saleFactoryV2]="$addr"; TX[saleFactoryV2]="$tx"
  else
    echo "refusing to record: CloneFactory $addr clones unknown implementation $impl" >&2; exit 1
  fi
done

KEYS=(surfaceImplV2 saleImplV2 allowlistGate surfaceFactoryV2 saleFactoryV2 launcherV2)
for key in "${KEYS[@]}"; do
  [ -n "${ADDR[$key]:-}" ] || { echo "refusing to record: no $key in $BROADCAST_FILE" >&2; exit 1; }
done

# The launcher must point at exactly the factories this broadcast deployed.
for pair in "tokenFactory:surfaceFactoryV2" "saleFactory:saleFactoryV2"; do
  fn="${pair%%:*}"; key="${pair#*:}"
  got="$(cast call "${ADDR[launcherV2]}" "${fn}()(address)" --rpc-url "$RPC_URL")"
  [ "$(lower "$got")" = "$(lower "${ADDR[$key]}")" ] \
    || { echo "refusing to record: launcher $fn() is $got, expected ${ADDR[$key]}" >&2; exit 1; }
done

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

echo "Readback:"
for key in surfaceFactoryV2 saleFactoryV2; do
  cast call "${ADDR[$key]}" 'implementation()(address)' --rpc-url "$RPC_URL" | sed "s/^/  $key.implementation  /"
  cast call "${ADDR[$key]}" 'paused()(bool)' --rpc-url "$RPC_URL" | sed "s/^/  $key.paused          /"
done
cast call "${ADDR[launcherV2]}" 'owner()(address)' --rpc-url "$RPC_URL" | sed 's/^/  launcherV2.owner            /'
cast call "${ADDR[launcherV2]}" 'defaultReferrer()(address)' --rpc-url "$RPC_URL" | sed 's/^/  launcherV2.defaultReferrer  /'

case "$ENV_NAME" in
  mainnet) echo "  explorer  https://evm.now/address/${ADDR[launcherV2]}?chainId=1" ;;
  sepolia) echo "  explorer  https://sepolia.etherscan.io/address/${ADDR[launcherV2]}" ;;
  anvil) : ;;
esac

echo "deploy complete for $ENV_NAME: $RECORD_FILE"
