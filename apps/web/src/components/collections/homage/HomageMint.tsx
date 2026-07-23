"use client"

// Homage to the Punk — the bespoke mint instrument, rendered on the PND collection
// page in place of the generic direct-sale CTA (homage is pooled + minter-driven).
//
// Full phased flow, rebuilt in PND's design system:
//   claim     — punk holders mint the homage for their own punk (SAME escalating fee); routes
//               direct / delegate.xyz / permissionless (see HomageClaim)
//   allowlist — Merkle-gated random draw (SAME escalating per-wallet fee)
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
  CRYPTOPUNKS_MARKET,
  WRAPPED_PUNKS,
  WRAPPED_PUNKS_721,
  homageFlows,
  homageMinterAbi,
  punksMarketAbi,
  quoteMint,
  wrappedPunksAbi,
  type MintQuote,
} from "@/lib/homage/contracts"
import {WINDOW_LABEL, type Phase, type Schedule, claimOpen, currentPhase, nextTransition, reservationOpenAt} from "@/lib/homage/phase"
import {allowlistProofIn, useAllowlist, useAllowlistMembership} from "@/lib/homage/allowlist"
import {HomageReveal} from "./HomageReveal"
import {HomageBatchReveal} from "./HomageBatchReveal"
import {HomageClaim} from "./HomageClaim"
import {HomageReserve} from "./HomageReserve"
import {HomageSchedule} from "./HomageSchedule"
import {ALLOWLIST_SNAPSHOT_CAPTION, HomageAllowlistLookup} from "./HomageAllowlistLookup"
import {HomageMintLog} from "./HomageMintLog"
import type {HomageMintEntry} from "@/lib/homage/collection.server"

const SUPPLY = 10_000
const QUOTE_POLL_MS = 30_000 // paid RPC path in prod — never tighten below this
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const ZERO = "0x0000000000000000000000000000000000000000" as const
// Re-confirm the mint if the live $111 swap leg has moved more than this since the
// price the collector last saw. Small drift is absorbed by the swap's own headroom +
// refund, so only a material move interrupts with a second click. In bps of the swap leg.
const PRICE_RECONFIRM_BPS = 500n // 5%

export function HomageMint({
  collection,
  minter,
  mintFeed = [],
}: {
  collection: Address
  minter: Address
  /** Server-fetched mint rows, forwarded to the sidebar HomageMintLog. */
  mintFeed?: HomageMintEntry[]
}) {
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
      {address: minter, abi: homageMinterAbi, functionName: "feeGrowthBps", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "mintCount", args: [address ?? ZERO], chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "reservedRemaining", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "feeGraceMints", chainId: PREFERRED_CHAIN.id},
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
  // Positional, in the order the contracts array above lists them. Keep the two in step.
  const baseFee = cfg.data?.[3]?.status === "success" ? (cfg.data[3].result as bigint) : BASE_FEE
  const feeGrowthBps = cfg.data?.[4]?.status === "success" ? (cfg.data[4].result as bigint) : 0n
  const walletMintCount = cfg.data?.[5]?.status === "success" ? (cfg.data[5].result as bigint) : 0n
  const reservedRemaining = cfg.data?.[6]?.status === "success" ? Number(cfg.data[6].result as bigint) : undefined
  const feeGraceMints = cfg.data?.[7]?.status === "success" ? (cfg.data[7].result as bigint) : 0n

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

  // ── the connected wallet's escalating mint fee (ALL windows now escalate on this counter) ──
  const feeRead = useReadContract({
    address: minter, abi: homageMinterAbi, functionName: "mintFeeOf", args: [address ?? ZERO],
    chainId: PREFERRED_CHAIN.id, query: {enabled: !!address},
  })
  const publicFee = (feeRead.data as bigint | undefined) ?? baseFee
  // Every window escalates on the connected wallet's counter, so the display quote always
  // folds in that wallet's live escalating fee (claimFor/claimTo re-resolve the recipient at send).
  const activeFee = publicFee

  // allowlist eligibility — resolve from the lightweight ~1MB membership list, not the ~31MB
  // proof file: a connected wallet outside public loads only the address set. null = still
  // loading (UNKNOWN — never render a negative from it).
  const members = useAllowlistMembership(!!address && phase !== "public")
  const isAllowlisted = !!address && !!members && members.has(address.toLowerCase())
  // The heavy proof file is fetched only once an eligible wallet is actually in the allowlist
  // window (i.e. about to mint); the proof itself is what the allowlistMint tx needs.
  const allowlist = useAllowlist(phase === "allowlist" && isAllowlisted)
  const allowlistProof = address && allowlist ? allowlistProofIn(allowlist, address) : null

  // ── live quote ───────────────────────────────────────────────────────────────
  const [quote, setQuote] = useState<MintQuote | null>(null)
  const [quoteErr, setQuoteErr] = useState<string | null>(null)
  // Set when a click's fresh re-quote moved the swap leg past PRICE_RECONFIRM_BPS from
  // what was on screen: the fresh price is shown and a second click is required before
  // sending. Cleared once a send goes through (or when the shown price catches up).
  const [priceConfirmPending, setPriceConfirmPending] = useState(false)
  // Batch: 1..MAX_BATCH tokens per public OR allowlist mint. Claim stays single.
  // qty is the committed value the math runs on; qtyText is what the input shows, so
  // typing can pass through transient states ("", leading digit of a larger number)
  // without the quote math ever seeing 0 or NaN.
  const [qty, setQty] = useState(1)
  const [qtyText, setQtyText] = useState("1")
  const commitQty = useCallback((n: number, max: number) => {
    const clamped = Math.min(Math.max(n, 1), max)
    setQty(clamped)
    setQtyText(String(clamped))
    // Changing quantity restarts the price flow: any pending re-confirm no longer
    // matches what's on screen.
    setPriceConfirmPending(false)
  }, [])
  const maxBatchRead = useReadContract({
    address: minter, abi: homageMinterAbi, functionName: "MAX_BATCH", chainId: PREFERRED_CHAIN.id,
  })
  const maxBatch = maxBatchRead.data !== undefined ? Number(maxBatchRead.data as bigint) : 20
  // Batch is available in public AND allowlist (the contract exposes both
  // mintBatch and allowlistMintBatch). Claim stays single (one punk id per call).
  const batchQty = phase === "public" || phase === "allowlist" ? qty : 1
  const refreshQuote = useCallback(async () => {
    if (!publicClient) return
    try {
      setQuote(await quoteMint(publicClient, minter, activeFee))
      setQuoteErr(null)
    } catch (e) {
      setQuoteErr(e instanceof Error ? e.message : "quote failed")
    }
  }, [publicClient, minter, activeFee])

  useEffect(() => {
    // Pre-open: one fetch (no poll) so the price card can show an expected cost
    // ahead of the window opening. Open phases additionally poll at QUOTE_POLL_MS.
    void refreshQuote()
    if (phase === "closed") return
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
  const claimTotal = quote ? quote.ethForSwap + publicFee : undefined // claim/allowlist now escalate too
  const {data: balance} = useBalance({address, chainId: PREFERRED_CHAIN.id, query: {enabled: !!address && !wrongNetwork}})
  // Per-mint cost for the selected quantity: each token = the swap leg (≈ constant) + its
  // OWN escalating fee at counts publicMintCount, +1, +2, … (feeForCount mirrors the
  // contract to the wei). One source for the itemized rows, the total, and the headline —
  // so the list always sums to its total. The tx itself uses the on-chain quoteBatchFee.
  const batchItems = useMemo(() => {
    if ((phase !== "public" && phase !== "allowlist") || !quote) return null
    return Array.from({length: batchQty}, (_, i) => ({
      cost: quote.ethForSwap + feeForCount(baseFee, feeGrowthBps, feeGraceMints, walletMintCount + BigInt(i)),
    }))
  }, [phase, batchQty, quote, baseFee, feeGrowthBps, feeGraceMints, walletMintCount])
  const batchTotal = batchItems ? batchItems.reduce((s, it) => s + it.cost, 0n) : undefined
  const insufficient = !!balance && batchTotal !== undefined && !wrongNetwork && balance.value < batchTotal
  // Headline price: the escalating batch total in public/allowlist, the flat claim fee otherwise.
  const priceValue = phase === "public" || phase === "allowlist" ? batchTotal : claimTotal
  // Before a wallet connects the fee leg defaults to baseFee (the first-mint floor);
  // once connected it reads the wallet's live mintFeeOf, which is higher for a wallet
  // that has already minted (the +10%/mint escalator). So the pre-connect figure is a
  // "from" floor, not a firm quote — label it that way so connecting doesn't look like
  // a surprise price bump.
  const priceIsFloor = !address && phase !== "closed" && priceValue !== undefined

  // True when the fresh swap leg has moved more than PRICE_RECONFIRM_BPS from what the
  // collector last saw. The caller shows the fresh price and waits for a second click.
  const priceMovedTooMuch = useCallback((shownSwap: bigint | undefined, freshSwap: bigint): boolean => {
    if (shownSwap === undefined || shownSwap === 0n) return false
    const diff = shownSwap > freshSwap ? shownSwap - freshSwap : freshSwap - shownSwap
    return (diff * 10_000n) / shownSwap > PRICE_RECONFIRM_BPS
  }, [])

  const doMint = useCallback(async () => {
    if (!publicClient) return
    const shownSwap = quote?.ethForSwap
    let q = quote
    try {
      q = await quoteMint(publicClient, minter, publicFee)
      setQuote(q)
    } catch {
      /* fall back to last shown quote */
    }
    if (!q) return
    // Re-confirm on a material price move: the fresh quote is already on screen (setQuote
    // above), so require a second click at that price. Small drift is absorbed by the
    // swap headroom + refund and passes straight through.
    if (!priceConfirmPending && priceMovedTooMuch(shownSwap, q.ethForSwap)) {
      setPriceConfirmPending(true)
      return
    }
    setPriceConfirmPending(false)
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
  }, [publicClient, quote, publicFee, minter, writeContract, batchQty, address, priceConfirmPending, priceMovedTooMuch])

  const doAllowlistMint = useCallback(async () => {
    if (!publicClient || !allowlistProof) return
    const shownSwap = quote?.ethForSwap
    let q = quote
    try {
      q = await quoteMint(publicClient, minter, publicFee)
      setQuote(q)
    } catch {
      /* fall back */
    }
    if (!q) return
    if (!priceConfirmPending && priceMovedTooMuch(shownSwap, q.ethForSwap)) {
      setPriceConfirmPending(true)
      return
    }
    setPriceConfirmPending(false)
    if (batchQty <= 1) {
      writeContract({...homageFlows(minter).allowlistMint(allowlistProof, q.ethForSwap + publicFee), chainId: PREFERRED_CHAIN.id})
      return
    }
    // Allowlist batch: same escalating fee leg as the public batch (quoteBatchFee
    // covers any qty) plus a per-swap budget with headroom; the contract refunds
    // whatever it doesn't spend.
    const batchFee = (await publicClient.readContract({
      address: minter,
      abi: homageMinterAbi,
      functionName: "quoteBatchFee",
      args: [address ?? ZERO, BigInt(batchQty)],
    })) as bigint
    const swapBudget = (BigInt(batchQty) * q.ethForSwap * 112n) / 100n
    writeContract({
      ...homageFlows(minter).allowlistMintBatch(BigInt(batchQty), allowlistProof, batchFee + swapBudget),
      chainId: PREFERRED_CHAIN.id,
    })
  }, [publicClient, quote, publicFee, allowlistProof, minter, writeContract, batchQty, address, priceConfirmPending, priceMovedTooMuch])

  // claim routes are driven from HomageClaim. The escalating fee is keyed on the RECIPIENT
  // (the wallet the homage mints to): the connected wallet for a direct claim, the vault for
  // claimFor, the punk's holder for claimTo. Resolve that wallet's live mintFeeOf so we never
  // under-send. Over-sending is safe (the swap refunds unspent ETH); under-sending reverts.
  const claimValue = useCallback(
    async (recipient?: Address, punkIdForHolder?: bigint): Promise<bigint | null> => {
      if (!publicClient) return null
      let target = recipient
      if (!target && punkIdForHolder !== undefined) {
        try {
          let h = (await publicClient.readContract({
            address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi,
            functionName: "punkIndexToAddress", args: [punkIdForHolder],
          })) as Address
          const wrapper =
            h.toLowerCase() === WRAPPED_PUNKS.toLowerCase()
              ? WRAPPED_PUNKS
              : h.toLowerCase() === WRAPPED_PUNKS_721.toLowerCase()
                ? WRAPPED_PUNKS_721
                : undefined
          if (wrapper) {
            h = (await publicClient.readContract({
              address: wrapper, abi: wrappedPunksAbi, functionName: "ownerOf", args: [punkIdForHolder],
            })) as Address
          }
          target = h
        } catch {
          /* fall through to the connected wallet */
        }
      }
      target ??= address
      // Reuse the connected wallet's already-read fee when it IS the recipient; else read live.
      let fee = publicFee
      if (target && address && target.toLowerCase() !== address.toLowerCase()) {
        try {
          fee = (await publicClient.readContract({
            address: minter, abi: homageMinterAbi, functionName: "mintFeeOf", args: [target],
          })) as bigint
        } catch {
          /* keep publicFee */
        }
      }
      try {
        const q = await quoteMint(publicClient, minter, fee)
        setQuote(q)
        return q.ethForSwap + fee
      } catch {
        return quote ? quote.ethForSwap + fee : null
      }
    },
    [publicClient, quote, publicFee, address, minter],
  )

  // ── render helpers ─────────────────────────────────────────────────────────────
  const statusDot = soldOut ? "bg-status-sold" : phase !== "closed" ? "bg-status-available animate-pulse" : "bg-status-upcoming"
  const statusLabel = soldOut
    ? "Sold out"
    : phase === "public"
      ? "Public mint open"
      : phase === "claim"
        ? "Punk mint claim open"
        : phase === "allowlist"
          ? "Allowlist mint open"
          : "Not yet open"

  // Batch controls shared by the public and allowlist phases (the contract
  // exposes mintBatch and allowlistMintBatch; only the write path differs).
  const qtyStepper = maxBatch > 1 && (phase === "public" || phase === "allowlist") ? (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Quantity</span>
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
            const raw = e.target.value.replace(/[^\d]/g, "").slice(0, 2)
            const n = parseInt(raw, 10)
            if (!Number.isFinite(n)) {
              setQtyText("")
              return
            }
            if (n < 1) {
              setQtyText(raw)
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
  ) : null

  const batchBreakdown =
    batchItems && batchQty > 1 ? (
      <>
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
        <p className="text-[10px] font-mono leading-relaxed text-gray-400">
          The mint fee rises 10% with each mint from your wallet, so each is a little more than the last.
        </p>
      </>
    ) : null

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

          {/* Counts to the window that opens next, stepping claim to allowlist to
              public as each arrives. Unclaimed reservations release at public start,
              so that note rides only on the public leg. */}
          {(phase === "allowlist" || (claimIsOpen && phase !== "public")) && next !== null && (
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
              {WINDOW_LABEL[next.to]} opens in{" "}
              <span className="text-fg">
                <Countdown endTime={BigInt(next.at)} nowSec={nowSec} />
              </span>
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
                  : phase === "allowlist"
                    ? "Allowlist price"
                    : "Price"}
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
            {/* Cost breakdown: the flat/escalating fee leg plus the fixed $111 amount every
                mint escrows, so the price isn't just one opaque ETH figure. */}
            {phase !== "closed" && quote && (
              <p className="text-[10px] font-mono text-gray-400 tabular-nums">
                {fmtEth(quote.fee)} ETH + {compactTokens(quote.threshold)} $111
              </p>
            )}
            {priceIsFloor && (
              <p className="text-[10px] font-mono leading-relaxed text-gray-400">
                Starting price. The fee rises 10% with each mint from a wallet — connect to see yours.
              </p>
            )}
            {/* Pre-open: base fee + the live $111 swap quote, so a wallet can plan around
                the expected cost before the window opens (the fee itself may still change
                per-wallet once minting starts escalating). */}
            {phase === "closed" && (
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
                {claimTotal !== undefined
                  ? <>Expected cost · {fmtEth(claimTotal)} <span className="text-gray-500">ETH</span></>
                  : quoteErr
                    ? "Expected cost unavailable"
                    : "Estimating expected cost…"}
              </p>
            )}
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
              {/* During the reservation window the reserve panel renders without a
                  wallet (it carries its own connect CTA), so holders can see the
                  flow exists before connecting. */}
              {!address && !(phase === "closed" && reservationIsOpen) ? (
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
                  {qtyStepper}
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
                            : priceConfirmPending
                              ? "Price updated · confirm"
                              : qty > 1
                                ? `Mint ${qty} homages`
                                : "Mint a homage"}
                  </button>
                  {priceConfirmPending && (
                    <p className="text-[10px] font-mono leading-relaxed text-gray-400">
                      The $111 price moved since you opened this. Confirm to mint at the updated price above.
                    </p>
                  )}
                  {batchBreakdown}
                </div>
              ) : phase === "allowlist" ? (
                // Allowlist mints are uncapped: the contract keeps no per-wallet count
                // and throttles only through the fee escalator, so membership is the
                // whole test. Batch is allowed here too (allowlistMintBatch).
                isAllowlisted ? (
                  <div className="space-y-3">
                    {qtyStepper}
                    <button
                      onClick={doAllowlistMint}
                      disabled={isPending || soldOut || drawExhausted || priceValue === undefined || insufficient}
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
                              : priceConfirmPending
                                ? "Price updated · confirm"
                                : qty > 1
                                  ? `Allowlist mint ${qty} homages`
                                  : "Allowlist mint"}
                    </button>
                    {priceConfirmPending && (
                      <p className="text-[10px] font-mono leading-relaxed text-gray-400">
                        The $111 price moved since you opened this. Confirm to mint at the updated price above.
                      </p>
                    )}
                    {batchBreakdown}
                  </div>
                ) : (
                  <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                    {!allowlist
                      ? "Checking the allowlist…"
                      : "This wallet isn’t on the allowlist. The public mint opens next."}
                  </p>
                )
              ) : phase === "closed" && reservationIsOpen ? (
                <div className="space-y-3">
                  {next && (
                    <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
                      {/* Name the window that actually opens next: claim, allowlist
                          and public open at their own times. */}
                      {WINDOW_LABEL[next.to]} opens in{" "}
                      <span className="text-fg">
                        <Countdown endTime={BigInt(next.at)} nowSec={nowSec} />
                      </span>
                    </p>
                  )}
                  <HomageReserve minter={minter} />
                </div>
              ) : claimIsOpen ? (
                // The punk mint claim is live but the random draw is not: the claim
                // overlay below is the way in, so say that rather than reporting the
                // whole mint shut.
                <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                  The punk mint claim is open. Punk owners mint their own id below. The
                  random draw opens with the allowlist window.
                </p>
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
                  <HomageClaim
                    minter={minter}
                    collection={collection}
                    address={address}
                    refreshKey={refreshKey}
                    disabled={isPending || soldOut}
                    // In allowlist/public a no-punk wallet collapses the claim chrome to
                    // just the mint-by-id link (the header lives inside HomageClaim now).
                    hidePunksWhenEmpty={phase === "allowlist" || phase === "public"}
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

      {/* The schedule sits between the instrument and the checker: the card's countdown
          names one window, this names all three and when each opens. */}
      <HomageSchedule minter={minter} />

      {/* Pre-public: anyone can check any address against the allowlist, below the
          instrument (the mint itself proves against the same vendored tree). */}
      {phase !== "public" && !soldOut && (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-surface p-5">
          <HomageAllowlistLookup />
          <p className="text-[10px] font-mono leading-relaxed text-gray-500">{ALLOWLIST_SNAPSHOT_CAPTION}</p>
        </div>
      )}

      {/* Mint history lives here (end of the sidebar stack) only at the lg breakpoint,
          where the sidebar is a real right-hand column; below that it stays in its
          original spot in the page's record section (see collections/[address]/page.tsx). */}
      <div className="hidden border-t border-gray-100 pt-4 lg:block">
        <HomageMintLog collection={collection} chainId={PREFERRED_CHAIN.id} mints={mintFeed} variant="desktop" />
      </div>
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

// $111 token count display: 20,000 (1e18-scaled) → "20K".
function compactTokens(wei: bigint): string {
  const whole = wei / 10n ** 18n
  return whole >= 1000n ? `${whole / 1000n}K` : whole.toString()
}

// The public-mint fee for a wallet that has already done `n` public mints — a faithful
// bigint replica of HomageMinter._feeForCount: flat `baseFee` for the first `grace` mints,
// then `baseFee * (1+g/1e4)^(n-grace+1)` clamped at MAX_MINT_FEE via exponentiation-by-
// squaring, so the itemized breakdown matches the chain to the wei without a per-item RPC
// read. `grace == 0` reproduces the pre-grace curve (exponent `n` unshifted).
const MAX_MINT_FEE = 10n ** 18n // 1 ether, the fee ceiling
// The squaring loop's running multiplier is 1e4 fixed point, not a wei amount, so it
// clamps against its own ceiling. Clamping it at MAX_MINT_FEE instead caps the
// multiplier four orders of magnitude below the contract's and diverges from the chain
// at high mint counts. This mirrors HomageMinter's MAX_FEE_MULTIPLIER, the same
// magnitude-versus-multiplier distinction audit finding L-01 fixed onchain.
const MAX_FEE_MULTIPLIER = MAX_MINT_FEE * 10_000n
function feeForCount(baseFee: bigint, g: bigint, grace: bigint, n: bigint): bigint {
  if (n < grace) return baseFee // inside the flat grace window
  // Shift so `n == grace` (first post-grace mint) lands on the curve's first step; `grace == 0`
  // leaves the exponent as `n` unshifted (the `n < grace` check never trips).
  let e = grace === 0n ? n : n - grace + 1n
  let fee = baseFee
  if (g === 0n || fee === 0n) return fee
  let m = 10_000n + g
  while (e !== 0n) {
    if (e & 1n) {
      fee = (fee * m) / 10_000n
      if (fee >= MAX_MINT_FEE) return MAX_MINT_FEE
    }
    e >>= 1n
    if (e !== 0n) {
      m = (m * m) / 10_000n
      if (m > MAX_FEE_MULTIPLIER) m = MAX_FEE_MULTIPLIER
    }
  }
  return fee
}
