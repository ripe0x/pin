import { ponder } from "ponder:registry"
import { homageActivity, homageConfig, homageTokens } from "ponder:schema"

/**
 * Homage ("Homage to the Punk") singleton handlers — DEPLOY-GATED.
 *
 * These `ponder.on("Homage:*")` registrations only fire when the Homage
 * contract is wired into ponder.config.ts (HOMAGE_ADDRESS + HOMAGE_START_BLOCK
 * set). Ponder tolerates handlers for a contract that isn't registered — they
 * simply never run — so this file is safe to ship before deploy.
 *
 * Data model:
 *   homage_tokens    — per-punkId current state (holder, outstanding, current
 *                      mint phase/economics, first/last mint time, redeemCount).
 *                      Ids CHURN: redeem returns an id to the pool, so a punkId
 *                      can be minted → redeemed → re-minted. One row per punkId
 *                      ever seen; `outstanding` + `holder` track the live state.
 *   homage_activity  — append-only mint/claim/redeem/transfer log (provenance).
 *   homage_config    — single row (keyed by contract) mirroring the on-chain
 *                      owner-set schedule + fee knobs, so web reads the phase
 *                      schedule from Postgres instead of RPC (indexer-first).
 *
 * Mint-phase attribution:
 *   Claimed  → always the "claim" window (the contract only accepts claim()
 *              inside [claimStart, allowlistStart)).
 *   Minted   → "allowlist" vs "public", disambiguated by the mint's block
 *              timestamp vs the indexed schedule in homage_config:
 *                ts >= publicStart (set)      → "public"
 *                ts >= allowlistStart (set)   → "allowlist"
 *                else                         → null (only if a Minted somehow
 *                                               fires before ScheduleSet was
 *                                               indexed; not expected — owner
 *                                               sets the schedule before mints).
 *   We deliberately do NOT read the contract per event: the schedule is fully
 *   carried by ScheduleSet, so attribution is a cheap in-memory compare (no
 *   extra RPC, unlike MURI's getArtwork reads).
 *
 * Transfer handling: the mint Transfer (from=0) and burn Transfer (to=0) fire
 * in the same tx as Minted/Claimed/Redeemed and are already captured by those
 * handlers, so this file SKIPS them to avoid double-counting. Only secondary
 * transfers (from != 0 && to != 0) update `holder` and append a "transfer" row.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

type Ctx = Parameters<Parameters<typeof ponder.on>[1]>[0]["context"]
type Hex = `0x${string}`

// Because Homage is deploy-gated (omitted from ponder.config.ts until the
// HOMAGE_ADDRESS env is set), it isn't in the generated `ponder:registry`,
// so `event.args` on these handlers is `unknown`. We type each event's args
// explicitly from the (hand-synced) ABI. Re-check these shapes against the
// audited ABI at freeze (they mirror abis/Homage.ts).
type MintArgs = {
  to: Hex
  punkId: bigint
  ethSwapped: bigint
  received111: bigint
}
type RedeemArgs = { from: Hex; punkId: bigint; amount111: bigint }
type TransferArgs = { from: Hex; to: Hex; tokenId: bigint }
type ScheduleArgs = {
  claimStart: bigint
  allowlistStart: bigint
  publicStart: bigint
}
type AllowlistRootArgs = { root: Hex }
type MaxPerAllowlistedArgs = { max: bigint }
type FeeScheduleArgs = { baseFee: bigint; feeGrowthBps: bigint }
type ExitFeeArgs = { exitFee: bigint }

/** Read (or lazily seed) the config row for the Homage contract. */
async function loadConfig(context: Ctx, contract: `0x${string}`) {
  return context.db.find(homageConfig, { contract })
}

/**
 * Ensure a homage_config row exists so we can .update() it from any setter
 * event regardless of which one fired first. Seeds all-null fields.
 */
async function ensureConfig(
  context: Ctx,
  contract: `0x${string}`,
  blockNumber: bigint,
  blockTime: bigint,
) {
  await context.db
    .insert(homageConfig)
    .values({
      contract,
      claimStart: null,
      allowlistStart: null,
      publicStart: null,
      allowlistRoot: null,
      maxPerAllowlisted: null,
      baseFee: null,
      feeGrowthBps: null,
      exitFee: null,
      updatedAtBlock: blockNumber,
      updatedAtTime: blockTime,
    })
    .onConflictDoNothing()
}

/** Resolve which window a Minted event fell into, from the indexed schedule. */
function mintPhaseFor(
  ts: bigint,
  config: { allowlistStart: bigint | null; publicStart: bigint | null } | null,
): "allowlist" | "public" | null {
  if (!config) return null
  const { allowlistStart, publicStart } = config
  if (publicStart != null && publicStart !== 0n && ts >= publicStart) return "public"
  if (allowlistStart != null && allowlistStart !== 0n && ts >= allowlistStart) return "allowlist"
  return null
}

// ─── Mint / Claim (a new homage enters the outstanding set) ──────────────

async function recordMint(
  context: Ctx,
  args: {
    to: `0x${string}`
    punkId: bigint
    ethSwapped: bigint
    received111: bigint
  },
  phase: "claim" | "allowlist" | "public" | null,
  event: {
    block: { number: bigint; timestamp: bigint }
    log: { logIndex: number }
    transaction: { hash: `0x${string}` }
  },
) {
  const { to, punkId, ethSwapped, received111 } = args
  const blockTime = event.block.timestamp

  const existing = await context.db.find(homageTokens, { punkId })
  if (existing) {
    // Re-mint after a prior redeem: same punkId back in circulation.
    await context.db.update(homageTokens, { punkId }).set({
      holder: to,
      outstanding: true,
      mintPhase: phase,
      ethSwapped,
      received111,
      lastMintedAtTime: blockTime,
      lastMintedAtBlock: event.block.number,
    })
  } else {
    await context.db.insert(homageTokens).values({
      punkId,
      holder: to,
      outstanding: true,
      mintPhase: phase,
      ethSwapped,
      received111,
      firstMintedAtTime: blockTime,
      lastMintedAtTime: blockTime,
      lastMintedAtBlock: event.block.number,
      redeemCount: 0,
    })
  }

  await context.db
    .insert(homageActivity)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      type: phase === "claim" ? "claim" : "mint",
      punkId,
      from: null,
      to,
      ethSwapped,
      received111,
      amount111: null,
      mintPhase: phase,
      blockNumber: event.block.number,
      blockTime,
      logIndex: event.log.logIndex,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
}

ponder.on("Homage:Claimed", async ({ event, context }) => {
  await recordMint(
    context,
    event.args as MintArgs,
    "claim", // Claimed is always the holder-priority claim window.
    event,
  )
})

ponder.on("Homage:Minted", async ({ event, context }) => {
  const config = await loadConfig(context, event.log.address as Hex)
  const phase = mintPhaseFor(event.block.timestamp, config)
  await recordMint(context, event.args as MintArgs, phase, event)
})

// ─── Redeem (homage burned, punkId returns to the pool) ──────────────────

ponder.on("Homage:Redeemed", async ({ event, context }) => {
  const { from, punkId, amount111 } = event.args as RedeemArgs

  const existing = await context.db.find(homageTokens, { punkId })
  if (existing) {
    await context.db.update(homageTokens, { punkId }).set({
      holder: ZERO_ADDRESS,
      outstanding: false,
      redeemCount: existing.redeemCount + 1,
    })
  }

  await context.db
    .insert(homageActivity)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      type: "redeem",
      punkId,
      from,
      to: null,
      ethSwapped: null,
      received111: null,
      amount111,
      mintPhase: null,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      logIndex: event.log.logIndex,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

// ─── Transfer (secondary only — mint/burn skipped) ───────────────────────

ponder.on("Homage:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args as TransferArgs
  // Skip mint (from=0) and burn (to=0): already captured by Minted/Claimed
  // and Redeemed in the same tx. Only track secondary transfers here.
  if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) return

  const existing = await context.db.find(homageTokens, { punkId: tokenId })
  if (existing) {
    await context.db.update(homageTokens, { punkId: tokenId }).set({ holder: to })
  }

  await context.db
    .insert(homageActivity)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      type: "transfer",
      punkId: tokenId,
      from,
      to,
      ethSwapped: null,
      received111: null,
      amount111: null,
      mintPhase: null,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      logIndex: event.log.logIndex,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

// ─── Config (owner-set schedule + fee knobs → homage_config) ─────────────

ponder.on("Homage:ScheduleSet", async ({ event, context }) => {
  const contract = event.log.address as Hex
  const args = event.args as ScheduleArgs
  await ensureConfig(context, contract, event.block.number, event.block.timestamp)
  await context.db.update(homageConfig, { contract }).set({
    claimStart: args.claimStart,
    allowlistStart: args.allowlistStart,
    publicStart: args.publicStart,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})

ponder.on("Homage:AllowlistRootSet", async ({ event, context }) => {
  const contract = event.log.address as Hex
  const args = event.args as AllowlistRootArgs
  await ensureConfig(context, contract, event.block.number, event.block.timestamp)
  await context.db.update(homageConfig, { contract }).set({
    allowlistRoot: args.root,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})

ponder.on("Homage:MaxPerAllowlistedSet", async ({ event, context }) => {
  const contract = event.log.address as Hex
  const args = event.args as MaxPerAllowlistedArgs
  await ensureConfig(context, contract, event.block.number, event.block.timestamp)
  await context.db.update(homageConfig, { contract }).set({
    maxPerAllowlisted: args.max,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})

ponder.on("Homage:FeeScheduleSet", async ({ event, context }) => {
  const contract = event.log.address as Hex
  const args = event.args as FeeScheduleArgs
  await ensureConfig(context, contract, event.block.number, event.block.timestamp)
  await context.db.update(homageConfig, { contract }).set({
    baseFee: args.baseFee,
    feeGrowthBps: args.feeGrowthBps,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})

ponder.on("Homage:ExitFeeSet", async ({ event, context }) => {
  const contract = event.log.address as Hex
  const args = event.args as ExitFeeArgs
  await ensureConfig(context, contract, event.block.number, event.block.timestamp)
  await context.db.update(homageConfig, { contract }).set({
    exitFee: args.exitFee,
    updatedAtBlock: event.block.number,
    updatedAtTime: event.block.timestamp,
  })
})
