"use client"

// Homage to the Punk — the bespoke mint instrument, rendered on the PND collection
// page in place of the generic direct-sale CTA (homage is pooled + minter-driven).
//
// Full phased flow, rebuilt in PND's design system:
//   claim     — punk holders mint the homage for their own punk (flat baseFee); routes
//               direct / delegate.xyz / permissionless (see HomageClaim)
//   allowlist — Merkle-gated random draw (flat baseFee)
//   public    — anyone, random draw, escalating per-wallet fee
// Every path swaps ETH→$111 and escrows THRESHOLD inside the piece. A redeem panel
// (burn → unescrow) shows whenever the connected wallet holds homages.

import {useCallback, useEffect, useMemo, useState} from "react"
import {useRouter} from "next/navigation"
import {formatEther, parseEventLogs, type Address} from "viem"
import {
  useAccount,
  useBalance,
  useChainId,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import {ConnectButton} from "@rainbow-me/rainbowkit"
import {
  Countdown,
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  TxSuccessBanner,
  formatWriteError,
  useChainNowSec,
} from "@/components/tx/tx-ui"
import {
  BASE_FEE,
  homageFlows,
  homageMinterAbi,
  quoteMint,
  type MintQuote,
} from "@/lib/homage/contracts"
import {type Phase, type Schedule, claimOpen, currentPhase, nextTransition, reservationOpenAt} from "@/lib/homage/phase"
import {allowlistProofIn, useAllowlist} from "@/lib/homage/allowlist"
import {HomageReveal} from "./HomageReveal"
import {HomageBatchReveal} from "./HomageBatchReveal"
import {HomageClaim} from "./HomageClaim"
import {HomageReserve} from "./HomageReserve"
import {HomageAllowlistLookup} from "./HomageAllowlistLookup"

const SUPPLY = 10_000
const QUOTE_POLL_MS = 30_000 // paid RPC path in prod — never tighten below this
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const ZERO = "0x0000000000000000000000000000000000000000" as const

export function HomageMint({collection, minter}: {collection: Address; minter: Address}) {
  const {address} = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient({chainId: PREFERRED_CHAIN.id})
  const {switchChain, isPending: isSwitchPending} = useSwitchChain()
  const router = useRouter()
  const nowSec = useChainNowSec()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  // ── supply + schedule/fee/allowlist config (one multicall) ───────────────────
  const remaining = useReadContract({address: minter, abi: homageMinterAbi, functionName: "remaining", chainId: PREFERRED_CHAIN.id})
  const totalMinted = useReadContract({address: minter, abi: homageMinterAbi, functionName: "totalMinted", chainId: PREFERRED_CHAIN.id})
  const cfg = useReadContracts({
    contracts: [
      {address: minter, abi: homageMinterAbi, functionName: "claimStart", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "allowlistStart", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "publicStart", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "baseFee", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "maxPerAllowlisted", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "allowlistMinted", args: [address ?? ZERO], chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "exitFee", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "feeGrowthBps", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "publicMints", args: [address ?? ZERO], chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "reservedRemaining", chainId: PREFERRED_CHAIN.id},
    ],
  })
  const schedule: Schedule | null =
    cfg.data && cfg.data[0]?.status === "success"
      ? {
          claimStart: Number(cfg.data[0].result as bigint),
          allowlistStart: Number(cfg.data[1].result as bigint),
          publicStart: Number(cfg.data[2].result as bigint),
        }
      : null
  const baseFee = cfg.data?.[3]?.status === "success" ? (cfg.data[3].result as bigint) : BASE_FEE
  const maxPerAllowlisted = cfg.data?.[4]?.status === "success" ? Number(cfg.data[4].result as bigint) : undefined
  const allowlistUsed = cfg.data?.[5]?.status === "success" ? Number(cfg.data[5].result as bigint) : 0
  const feeGrowthBps = cfg.data?.[7]?.status === "success" ? (cfg.data[7].result as bigint) : 0n
  const publicMintCount = cfg.data?.[8]?.status === "success" ? (cfg.data[8].result as bigint) : 0n
  const reservedRemaining = cfg.data?.[9]?.status === "success" ? Number(cfg.data[9].result as bigint) : undefined

  const minted = totalMinted.data !== undefined ? Number(totalMinted.data as bigint) : null
  const left = remaining.data !== undefined ? Number(remaining.data as bigint) : null
  // Sold out = every punk has an homage (the collection itself is exhausted). The draw
  // POOL can separately run dry (drawExhausted) while claims — which mint a specific,
  // already-reserved punkId rather than drawing from the pool — remain possible.
  const soldOut = minted !== null && minted >= SUPPLY
  const drawExhausted = left === 0

  // Phase from the real schedule — the ONLY source of truth. The fork-only dev toggle
  // below moves the actual on-chain schedule (the dev wallet owns the minter on the
  // fork), so every surface on the page — masthead, chip, schedule, this instrument,
  // and the contract's own gating — follows the same state instead of a local override.
  // `currentPhase` still names the single exclusive random-draw window (closed /
  // allowlist / public — "claim" only for an unmerged schedule, or the fork dev toggle's
  // "claim" preset). `claimIsOpen` / `reservationIsOpen` are independent, LAYERED reads
  // off the same schedule — a punk owner's claim overlay stays live open-ended once
  // claimStart passes, through allowlist AND public, rather than closing at
  // allowlistStart. No separate dev-mode override is needed: the dev toggle rewrites the
  // REAL on-chain schedule, so these functions already agree with it (e.g. the "claim"
  // preset sets claimStart <= now, which claimOpen reads as open the same as production).
  const phase: Phase = schedule ? currentPhase(schedule, nowSec) : "closed"
  const next = schedule ? nextTransition(schedule, nowSec) : null
  const claimIsOpen = schedule ? claimOpen(schedule, nowSec) : false
  const reservationIsOpen = schedule ? reservationOpenAt(schedule, nowSec) : false
  // The boundary specifically into "public" — used for the claim/allowlist-window
  // countdown, which always counts toward public open (not the raw `next` boundary,
  // which could target an unmerged claim window instead).
  const nextPublic = schedule && schedule.publicStart !== 0 && nowSec < schedule.publicStart ? schedule.publicStart : null

  // ── the caller's public-mint fee (escalates per wallet); claim/allowlist pay baseFee ──
  const feeRead = useReadContract({
    address: minter, abi: homageMinterAbi, functionName: "mintFeeOf", args: [address ?? ZERO],
    chainId: PREFERRED_CHAIN.id, query: {enabled: !!address},
  })
  const publicFee = (feeRead.data as bigint | undefined) ?? baseFee
  // The fee folded into the quote depends on the phase (claim/allowlist are flat baseFee).
  const activeFee = phase === "public" ? publicFee : baseFee

  // allowlist eligibility — the proof file (~3.6MB with every punk holder on it) loads
  // lazily once a wallet is connected outside public; null = still loading (UNKNOWN).
  const allowlist = useAllowlist(!!address && phase !== "public")
  const allowlistProof = address && allowlist ? allowlistProofIn(allowlist, address) : null
  const isAllowlisted = !!allowlistProof
  const allowlistRemaining = maxPerAllowlisted !== undefined ? Math.max(maxPerAllowlisted - allowlistUsed, 0) : undefined

  // ── live quote ───────────────────────────────────────────────────────────────
  const [quote, setQuote] = useState<MintQuote | null>(null)
  const [quoteErr, setQuoteErr] = useState<string | null>(null)
  // Batch: 1..MAX_BATCH tokens per public mint. Claim/allowlist stay single.
  // qty is the committed value the math runs on; qtyText is what the input shows, so
  // typing can pass through transient states ("", leading digit of a larger number)
  // without the quote math ever seeing 0 or NaN.
  const [qty, setQty] = useState(1)
  const [qtyText, setQtyText] = useState("1")
  const commitQty = useCallback((n: number, max: number) => {
    const clamped = Math.min(Math.max(n, 1), max)
    setQty(clamped)
    setQtyText(String(clamped))
  }, [])
  const maxBatchRead = useReadContract({
    address: minter, abi: homageMinterAbi, functionName: "MAX_BATCH", chainId: PREFERRED_CHAIN.id,
  })
  const maxBatch = maxBatchRead.data !== undefined ? Number(maxBatchRead.data as bigint) : 20
  const batchQty = phase === "public" ? qty : 1
  const refreshQuote = useCallback(async () => {
    if (!publicClient) return
    try {
      setQuote(await quoteMint(publicClient, activeFee))
      setQuoteErr(null)
    } catch (e) {
      setQuoteErr(e instanceof Error ? e.message : "quote failed")
    }
  }, [publicClient, activeFee])

  useEffect(() => {
    if (phase === "closed") return
    void refreshQuote()
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void refreshQuote()
    }, QUOTE_POLL_MS)
    return () => clearInterval(t)
  }, [phase, refreshQuote])

  // ── write / receipt (mint family: mint | allowlistMint | claim) ────────────────
  const {writeContract, data: txHash, isPending: isWritePending, error: writeError, reset} = useWriteContract()
  const {isLoading: isTxPending, isSuccess, data: receipt} = useWaitForTransactionReceipt({hash: txHash})
  const isPending = isWritePending || isTxPending
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (isSuccess) {
      setRefreshKey((k) => k + 1)
      router.refresh()
    }
  }, [isSuccess, router])

  // Every drawn/claimed punk id from the receipt — from Minted (public/allowlist/batch) or
  // Claimed. A batch emits one per token, so this is the full set the reveal shows.
  const revealPunkIds = useMemo<bigint[]>(() => {
    if (!receipt) return []
    try {
      const mine = (name: "Minted" | "Claimed") =>
        parseEventLogs({abi: homageMinterAbi, logs: receipt.logs, eventName: name})
          .filter((l) => l.address.toLowerCase() === minter.toLowerCase())
          .map((l) => l.args.punkId as bigint)
      return [...mine("Minted"), ...mine("Claimed")]
    } catch {
      return []
    }
  }, [receipt, minter])

  const total = quote?.totalValue
  const claimTotal = quote ? quote.ethForSwap + baseFee : undefined // claim/allowlist flat fee
  const {data: balance} = useBalance({address, chainId: PREFERRED_CHAIN.id, query: {enabled: !!address && !wrongNetwork}})
  // Per-mint cost for the selected quantity: each token = the swap leg (≈ constant) + its
  // OWN escalating fee at counts publicMintCount, +1, +2, … (feeForCount mirrors the
  // contract to the wei). One source for the itemized rows, the total, and the headline —
  // so the list always sums to its total. The tx itself uses the on-chain quoteBatchFee.
  const batchItems = useMemo(() => {
    if (phase !== "public" || !quote) return null
    return Array.from({length: batchQty}, (_, i) => ({
      cost: quote.ethForSwap + feeForCount(baseFee, feeGrowthBps, publicMintCount + BigInt(i)),
    }))
  }, [phase, batchQty, quote, baseFee, feeGrowthBps, publicMintCount])
  const batchTotal = batchItems ? batchItems.reduce((s, it) => s + it.cost, 0n) : undefined
  const insufficient = !!balance && batchTotal !== undefined && !wrongNetwork && balance.value < batchTotal
  // Headline price: the escalating batch total in public, the flat claim fee otherwise.
  const priceValue = phase === "public" ? batchTotal : claimTotal

  const doMint = useCallback(async () => {
    if (!publicClient) return
    let q = quote
    try {
      q = await quoteMint(publicClient, publicFee)
      setQuote(q)
    } catch {
      /* fall back to last shown quote */
    }
    if (!q) return
    if (batchQty <= 1) {
      writeContract({...homageFlows(minter).mint(q.totalValue), chainId: PREFERRED_CHAIN.id})
      return
    }
    // Batch: exact fee leg from the contract + a per-swap budget with headroom for the
    // price impact that accrues across the batch (the contract refunds what it doesn't spend).
    const batchFee = (await publicClient.readContract({
      address: minter,
      abi: homageMinterAbi,
      functionName: "quoteBatchFee",
      args: [address ?? ZERO, BigInt(batchQty)],
    })) as bigint
    const swapBudget = (BigInt(batchQty) * q.ethForSwap * 112n) / 100n
    writeContract({
      ...homageFlows(minter).mintBatch(BigInt(batchQty), batchFee + swapBudget),
      chainId: PREFERRED_CHAIN.id,
    })
  }, [publicClient, quote, publicFee, minter, writeContract, batchQty, address])

  const doAllowlistMint = useCallback(async () => {
    if (!publicClient || !allowlistProof) return
    let q = quote
    try {
      q = await quoteMint(publicClient, baseFee)
      setQuote(q)
    } catch {
      /* fall back */
    }
    if (!q) return
    writeContract({...homageFlows(minter).allowlistMint(allowlistProof, q.ethForSwap + baseFee), chainId: PREFERRED_CHAIN.id})
  }, [publicClient, quote, baseFee, allowlistProof, minter, writeContract])

  // claim routes are driven from HomageClaim, which needs a fresh quote value.
  const claimValue = useCallback(async (): Promise<bigint | null> => {
    if (!publicClient) return quote ? quote.ethForSwap + baseFee : null
    try {
      const q = await quoteMint(publicClient, baseFee)
      setQuote(q)
      return q.ethForSwap + baseFee
    } catch {
      return quote ? quote.ethForSwap + baseFee : null
    }
  }, [publicClient, quote, baseFee])

  // ── render helpers ─────────────────────────────────────────────────────────────
  const statusDot = soldOut ? "bg-status-sold" : phase !== "closed" ? "bg-status-available animate-pulse" : "bg-status-upcoming"
  const statusLabel = soldOut
    ? "Sold out"
    : phase === "public"
      ? "Public mint open"
      : phase === "claim"
        ? "Punk-owner claim open"
        : phase === "allowlist"
          ? "Allowlist mint open"
          : "Not yet open"


  return (
    <section className="py-5 border-b border-gray-100 space-y-3">
      <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
        <div className="p-5 space-y-4">
          {/* status row */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot}`} />
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">{statusLabel}</span>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
              {minted !== null ? `${minted} / ${SUPPLY} minted` : "…"}
            </span>
          </div>

          {/* reservation pool status — quiet, only while there's something to report */}
          {reservedRemaining !== undefined && reservedRemaining > 0 && (
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
              {reservedRemaining} reserved for punk owners · {left !== null ? left : "…"} in the draw pool
            </p>
          )}

          {/* claim/allowlist window countdown — always counts toward public open, since
              claim is open-ended (no "closes" of its own) and unclaimed reservations
              release into the draw pool at public start. */}
          {(phase === "allowlist" || (claimIsOpen && phase !== "public")) && nextPublic !== null && (
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
              Public opens in{" "}
              <span className="text-fg">
                <Countdown endTime={BigInt(nextPublic)} nowSec={nowSec} />
              </span>{" "}
              · unclaimed reservations release then
            </p>
          )}

          {/* price */}
          <div className="space-y-1">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              {phase === "public"
                ? batchQty > 1
                  ? `Total · ${batchQty} mints`
                  : "Price"
                : phase === "closed"
                  ? "Opens"
                  : "Price · flat claim fee"}
            </p>
            <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
              {phase === "closed" ? (
                <span className="text-sm font-mono text-gray-500">
                  {next ? <>Opens in <Countdown endTime={BigInt(next.at)} nowSec={nowSec} /></> : "Not scheduled"}
                </span>
              ) : priceValue !== undefined ? (
                <>
                  {fmtEth(priceValue)} <span className="text-sm font-mono text-gray-500">ETH</span>
                </>
              ) : quoteErr ? (
                <span className="text-sm font-mono text-gray-500">quote unavailable</span>
              ) : (
                <span className="text-sm font-mono text-gray-500">quoting…</span>
              )}
            </p>
          </div>

          {/* reveal / success — a grid for a batch, the full reveal for one */}
          {isSuccess && txHash && (
            revealPunkIds.length > 1 ? (
              <HomageBatchReveal
                collection={collection}
                punkIds={revealPunkIds}
                txHash={txHash}
                onDismiss={() => {
                  reset()
                  router.refresh()
                }}
              />
            ) : revealPunkIds.length === 1 ? (
              <HomageReveal
                collection={collection}
                punkId={revealPunkIds[0]}
                txHash={txHash}
                onDismiss={() => {
                  reset()
                  router.refresh()
                }}
              />
            ) : (
              <TxSuccessBanner
                txHash={txHash}
                chainId={PREFERRED_CHAIN.id}
                message="Minted. Your homage is recorded onchain."
                onDismiss={() => {
                  reset()
                  router.refresh()
                }}
              />
            )
          )}

          {/* action — per phase */}
          {!(isSuccess && txHash) && (
            <div className="pt-1 space-y-3">
              {!address ? (
                <ConnectButton.Custom>
                  {({openConnectModal}) => (
                    <button onClick={openConnectModal} className={btnPrimary}>
                      Connect wallet to mint
                    </button>
                  )}
                </ConnectButton.Custom>
              ) : wrongNetwork ? (
                <button onClick={() => switchChain({chainId: PREFERRED_CHAIN.id})} disabled={isSwitchPending} className={btnPrimary}>
                  {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
                </button>
              ) : phase === "public" ? (
                <div className="space-y-3">
                  {maxBatch > 1 && (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                        Quantity
                      </span>
                      <div className="flex items-center rounded border border-gray-200">
                        <button
                          onClick={() => commitQty(qty - 1, maxBatch)}
                          disabled={qty <= 1 || isPending}
                          className="px-3 py-1.5 text-sm font-mono text-gray-500 transition-colors hover:text-fg disabled:opacity-30"
                          aria-label="decrease quantity"
                        >
                          −
                        </button>
                        <input
                          value={qtyText}
                          onChange={(e) => {
                            // digits only (strips paste junk, e/+/-/. included), capped at
                            // 2 chars (MAX_BATCH is 20); empty is a valid TYPING state, and
                            // an over-max entry snaps to max immediately (not on blur).
                            const raw = e.target.value.replace(/[^\d]/g, "").slice(0, 2)
                            const n = parseInt(raw, 10)
                            if (!Number.isFinite(n)) {
                              setQtyText("")
                              return
                            }
                            if (n < 1) {
                              setQtyText(raw) // "0" while typing e.g. "05" — commit on blur
                              return
                            }
                            commitQty(n, maxBatch)
                          }}
                          onBlur={() => commitQty(qty, maxBatch)}
                          disabled={isPending}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          aria-label="quantity"
                          className="w-10 bg-transparent text-center text-sm font-mono tabular-nums outline-none disabled:opacity-30"
                        />
                        <button
                          onClick={() => commitQty(qty + 1, maxBatch)}
                          disabled={qty >= maxBatch || isPending}
                          className="px-3 py-1.5 text-sm font-mono text-gray-500 transition-colors hover:text-fg disabled:opacity-30"
                          aria-label="increase quantity"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )}
                  <button
                    onClick={doMint}
                    disabled={isPending || soldOut || drawExhausted || total === undefined || insufficient}
                    className={btnPrimary}
                  >
                    {soldOut
                      ? "Sold out"
                      : drawExhausted
                        ? "Draw pool empty"
                        : isPending
                          ? "Minting…"
                          : insufficient
                            ? "Insufficient balance"
                            : qty > 1
                              ? `Mint ${qty} homages`
                              : "Mint a homage"}
                  </button>
                  {/* Itemized per-mint cost — each token's own escalating fee, so the
                      +10%/mint climb is explicit. */}
                  {batchItems && batchQty > 1 && (
                    <ul className="space-y-1 pt-1">
                      {batchItems.map((it, i) => (
                        <li
                          key={i}
                          className="flex items-baseline justify-between gap-3 text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums"
                        >
                          <span>Mint {i + 1}</span>
                          <span className="text-fg">{fmtEth(it.cost)} ETH</span>
                        </li>
                      ))}
                      <li className="flex items-baseline justify-between gap-3 border-t border-gray-200 pt-1 text-[10px] font-mono uppercase tracking-wider text-gray-500 tabular-nums">
                        <span>Total</span>
                        <span className="text-fg">{batchTotal !== undefined ? fmtEth(batchTotal) : "…"} ETH</span>
                      </li>
                    </ul>
                  )}
                  {batchQty > 1 && (
                    <p className="text-[10px] font-mono leading-relaxed text-gray-400">
                      The mint fee rises 10% with each mint from your wallet, so each is a little more than the last.
                    </p>
                  )}
                </div>
              ) : phase === "allowlist" ? (
                isAllowlisted && (allowlistRemaining ?? 0) > 0 ? (
                  <button
                    onClick={doAllowlistMint}
                    disabled={isPending || soldOut || drawExhausted || claimTotal === undefined}
                    className={btnPrimary}
                  >
                    {isPending
                      ? "Minting…"
                      : drawExhausted
                        ? "Draw pool empty"
                        : `Allowlist mint${allowlistRemaining !== undefined ? ` · ${allowlistRemaining} left` : ""}`}
                  </button>
                ) : (
                  <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                    {isAllowlisted
                      ? "Your allowlist allocation is used up."
                      : !allowlist
                        ? "Checking the allowlist…"
                        : "This wallet isn’t on the allowlist. The public mint opens next."}
                  </p>
                )
              ) : phase === "closed" && reservationIsOpen ? (
                <div className="space-y-3">
                  {next && (
                    <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
                      Claiming and allowlist open in{" "}
                      <span className="text-fg">
                        <Countdown endTime={BigInt(next.at)} nowSec={nowSec} />
                      </span>
                    </p>
                  )}
                  <HomageReserve minter={minter} />
                </div>
              ) : (
                <p className="text-[11px] font-mono text-gray-500">Minting isn’t open yet.</p>
              )}

              {/* claim overlay — an independent, open-ended capability once claimStart
                  passes, so it renders alongside the allowlist/public draw UI above
                  rather than as its own exclusive phase branch. Gated on address +
                  network directly (not nested in the ternary above) since it's a
                  sibling to that phase-driven block, not one of its branches. */}
              {address && !wrongNetwork && claimIsOpen && (
                <div className="border-t border-gray-100 pt-3 space-y-3">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Your punks · claim</p>
                  <HomageClaim
                    minter={minter}
                    collection={collection}
                    address={address}
                    refreshKey={refreshKey}
                    disabled={isPending || soldOut}
                    getClaimValue={claimValue}
                    onClaim={(args) =>
                      // The claim routes are a union of payable write configs; wagmi's writeContract
                      // param can't unify the union, so cast through unknown (valid at runtime).
                      writeContract({...args, chainId: PREFERRED_CHAIN.id} as unknown as Parameters<typeof writeContract>[0])
                    }
                  />
                </div>
              )}

              {writeError && (
                <p className="text-[10px] font-mono text-status-sold leading-relaxed">{formatWriteError(writeError, "mint")}</p>
              )}
            </div>
          )}

          {/* fork-only phase toggle — sends a REAL setSchedule (the dev wallet owns the
              minter on the fork), so the whole page follows, not just this card. */}
          {FORK_MODE && (
            <DevPhaseControls minter={minter} nowSec={nowSec} phase={phase} disabled={isPending} />
          )}
        </div>
      </div>

      {/* Pre-public: anyone can check any address against the allowlist, below the
          instrument (the mint itself proves against the same vendored tree). */}
      {phase !== "public" && !soldOut && (
        <div className="rounded-lg border border-gray-200 bg-surface p-5">
          <HomageAllowlistLookup />
        </div>
      )}
    </section>
  )
}

const btnPrimary =
  "block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"

// Fork-only: rewrite the minter's REAL schedule so a chosen window is live right now
// (pre-mint = everything ahead). One tx, then every read on the page refetches — the
// masthead countdown, chip, schedule section, field, and the contract's own gating all
// move together. Owner-only on-chain; the fork's dev wallet is the owner.
const DEV_WINDOW = 3600
function DevPhaseControls({
  minter,
  nowSec,
  phase,
  disabled,
}: {
  minter: Address
  nowSec: number
  phase: Phase
  disabled: boolean
}) {
  const {writeContract, data: txHash, isPending: writing, error} = useWriteContract()
  const {isSuccess} = useWaitForTransactionReceipt({hash: txHash})

  useEffect(() => {
    if (!isSuccess) return
    // Full reload, not a soft refresh: this tx's block jumped the chain clock forward
    // (see the anchor note below), and useChainNowSec samples the chain/wall offset ONCE
    // per mount — invalidating queries alone would leave every countdown and phase check
    // reading from a stale clock, showing a window the contract disagrees with.
    window.location.reload()
  }, [isSuccess])

  const setPhase = (target: Phase) => {
    // Anvil stamps each mined block with REAL wall time, but `nowSec` projects the chain
    // clock from the LAST block — on a fork that has sat idle, that clock lags wall time
    // by the whole idle stretch. Anchoring windows to the lagging clock puts them in the
    // past the instant the tx mines (idle > DEV_WINDOW → "pre-mint" lands inside claim).
    // Anchor on whichever clock is ahead: that's the timestamp the new block will carry.
    const n = BigInt(Math.max(nowSec, Math.floor(Date.now() / 1000)))
    const w = BigInt(DEV_WINDOW)
    const s: Record<Phase, [bigint, bigint, bigint]> = {
      closed: [n + w, n + 2n * w, n + 3n * w],
      claim: [n, n + w, n + 2n * w],
      allowlist: [n - w, n, n + w],
      public: [n - 2n * w, n - w, n],
    }
    writeContract({
      address: minter,
      abi: homageMinterAbi,
      functionName: "setSchedule",
      args: s[target],
      chainId: PREFERRED_CHAIN.id,
    })
  }

  return (
    <div className="pt-2 mt-1 border-t border-gray-100 flex items-center gap-2 flex-wrap">
      <span className="text-[9px] font-mono uppercase tracking-wider text-gray-400">Dev phase</span>
      {(["closed", "claim", "allowlist", "public"] as const).map((p) => (
        <button
          key={p}
          onClick={() => setPhase(p)}
          disabled={disabled || writing}
          className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded disabled:opacity-40 ${
            phase === p ? "bg-fg text-bg" : "text-gray-400 hover:text-fg"
          }`}
        >
          {p === "closed" ? "pre-mint" : p}
        </button>
      ))}
      {writing && <span className="text-[9px] font-mono text-gray-400">setting…</span>}
      {error && (
        <span className="text-[9px] font-mono text-status-sold">{formatWriteError(error, "set phase")}</span>
      )}
    </div>
  )
}

// ETH display: at most 4 decimal places, trailing zeros trimmed (0.0090 → 0.009).
function fmtEth(wei: bigint): string {
  const [int, frac = ""] = formatEther(wei).split(".")
  const trimmed = frac.slice(0, 4).replace(/0+$/, "")
  return trimmed ? `${int}.${trimmed}` : int
}

// The public-mint fee for a wallet that has already done `n` public mints — a faithful
// bigint replica of HomageMinter._feeForCount (baseFee * (1+g/1e4)^n, clamped at
// MAX_MINT_FEE, exponentiation-by-squaring), so the itemized breakdown matches the chain
// to the wei without a per-item RPC read.
const MAX_MINT_FEE = 10n ** 18n // 1 ether
function feeForCount(baseFee: bigint, g: bigint, n: bigint): bigint {
  let fee = baseFee
  if (g === 0n || fee === 0n) return fee
  let m = 10_000n + g
  while (n !== 0n) {
    if (n & 1n) {
      fee = (fee * m) / 10_000n
      if (fee >= MAX_MINT_FEE) return MAX_MINT_FEE
    }
    n >>= 1n
    if (n !== 0n) {
      m = (m * m) / 10_000n
      if (m > MAX_MINT_FEE) m = MAX_MINT_FEE
    }
  }
  return fee
}
