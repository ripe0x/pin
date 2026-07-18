#!/usr/bin/env bash
#
# homage-phase.sh — drive the local homage mint through its windows so you can
# watch the FRONTEND phase transitions happen live.
#
# WHY a script (and not just clicking): the mint's phase is gated by the chain
# clock (block.timestamp). Anvil only advances that clock when it mines a block,
# so on an idle fork it lags real time. This script manipulates the clock directly
# with anvil_setTime + evm_mine, so a "phase" is a real, deterministic chain state
# — every surface (masthead countdown, chip, schedule, instrument, and the
# contract's own gating) agrees, because they all read the same clock.
#
# THE FLOW (watch each transition cross the boundary):
#   ./scripts/homage-phase.sh reset       # clean pre-mint: claim opens 2 min out
#   ./scripts/homage-phase.sh claim       # jump to 30s BEFORE claim opens
#   → refresh the browser, watch it tick 30→0 and flip pre-mint → claim
#   ./scripts/homage-phase.sh allowlist   # jump to 30s before allowlist opens
#   → refresh, watch claim → allowlist
#   ./scripts/homage-phase.sh public      # jump to 30s before public opens
#   → refresh, watch allowlist → public
#   ./scripts/homage-phase.sh status      # print the schedule + current phase
#
# IMPORTANT: refresh the page after each command. The frontend samples the
# chain/wall clock offset once per load; the countdown then ticks on its own in
# real seconds and flips at the boundary — but it won't pick up a NEW warp until
# you reload.
#
# ORDER MATTERS: warps only move the clock FORWARD (the EVM requires increasing
# block timestamps). Go reset → claim → allowlist → public. To go back, `reset`.
#
# Overridable via env:
#   RPC        anvil endpoint            (default http://127.0.0.1:8546)
#   MINTER     HomageMinter address      (default: read from the dev env file)
#   OWNER      minter owner / signer     (default: anvil account 0)
#   CLAIM_LEN  claim window seconds      (default 600)
#   ALLOW_LEN  allowlist window seconds  (default 600)
#   LEAD       seconds before a boundary (default 30)
#
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_DEV="apps/web/.env.development.local"
env_get() { [ -f "$ENV_DEV" ] && grep -E "^$1=" "$ENV_DEV" | head -1 | cut -d= -f2- || true; }

RPC="${RPC:-http://127.0.0.1:8546}"
MINTER="${MINTER:-$(env_get NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS)}"
# Anvil account 0 is the deployer, which owns the minter on the dev fork.
OWNER="${OWNER:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
CLAIM_LEN="${CLAIM_LEN:-600}"
ALLOW_LEN="${ALLOW_LEN:-600}"
LEAD="${LEAD:-30}"

die() { echo "error: $*" >&2; exit 1; }
command -v cast >/dev/null || die "cast not found (install Foundry)"
[ -n "$MINTER" ] || die "no minter address — start scripts/dev-collections.sh first, or set MINTER="
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || die "no anvil reachable at $RPC (set RPC=)"

chain_now() { cast block latest --rpc-url "$RPC" --json | python3 -c 'import json,sys;print(int(json.load(sys.stdin)["timestamp"],16))'; }
warp_to()   { cast rpc anvil_setTime "$1" --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null; }
set_sched() { cast send "$MINTER" "setSchedule(uint64,uint64,uint64)" "$1" "$2" "$3" --from "$OWNER" --unlocked --rpc-url "$RPC" >/dev/null; }

read_sched() {
  CS=$(cast call "$MINTER" "claimStart()(uint64)"     --rpc-url "$RPC" | awk '{print $1}')
  AS=$(cast call "$MINTER" "allowlistStart()(uint64)" --rpc-url "$RPC" | awk '{print $1}')
  PS=$(cast call "$MINTER" "publicStart()(uint64)"    --rpc-url "$RPC" | awk '{print $1}')
}
rel() { local d=$(( $1 - $2 )); if [ "$d" -gt 0 ]; then echo "opens in ${d}s"; else echo "OPEN"; fi; }
status() {
  read_sched; local n; n=$(chain_now)
  local ph="public"; [ "$n" -lt "$PS" ] && ph="allowlist"; [ "$n" -lt "$AS" ] && ph="claim"; [ "$n" -lt "$CS" ] && ph="pre-mint"
  echo "  minter    : $MINTER"
  echo "  phase now : $ph   (chain clock $n)"
  echo "  claim     : $CS  $(rel "$CS" "$n")"
  echo "  allowlist : $AS  $(rel "$AS" "$n")"
  echo "  public    : $PS  $(rel "$PS" "$n")"
  echo "  → refresh the browser to resync its clock."
}

warp_before() { # boundary-name absolute-ts
  local target=$(( $2 - LEAD )); local n; n=$(chain_now)
  [ "$target" -gt "$n" ] || die "'$1' boundary is behind the chain clock (${n}); run 'reset' to restart the sequence"
  warp_to "$target"
  echo "warped to ${LEAD}s before $1 opens:"
}

case "${1:-status}" in
  reset)
    warp_to "$(date +%s)"                       # align the chain clock to wall time
    N=$(chain_now); CS=$((N+120)); AS=$((CS+CLAIM_LEN)); PS=$((AS+ALLOW_LEN))
    set_sched "$CS" "$AS" "$PS"
    echo "reset → pre-mint (claim opens in 120s):"; status ;;
  claim)     read_sched; warp_before claim     "$CS"; status ;;
  allowlist) read_sched; warp_before allowlist "$AS"; status ;;
  public)    read_sched; warp_before public    "$PS"; status ;;
  status)    status ;;
  *) echo "usage: $0 [reset|claim|allowlist|public|status]"; exit 1 ;;
esac
