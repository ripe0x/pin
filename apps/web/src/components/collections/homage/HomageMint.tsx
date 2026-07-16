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
  EXIT_FEE,
  homageFlows,
  homageMinterAbi,
  quoteMint,
  type MintQuote,
} from "@/lib/homage/contracts"
import {type Phase, type Schedule, currentPhase, nextTransition} from "@/lib/homage/phase"
import {allowlistProofFor} from "@/lib/homage/allowlist"
import {HomageReveal} from "./HomageReveal"
import {HomageClaim} from "./HomageClaim"
import {HomageRedeem} from "./HomageRedeem"

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
  const exitFee = cfg.data?.[6]?.status === "success" ? (cfg.data[6].result as bigint) : EXIT_FEE

  const minted = totalMinted.data !== undefined ? Number(totalMinted.data as bigint) : null
  const left = remaining.data !== undefined ? Number(remaining.data as bigint) : null
  const soldOut = left === 0

  // Phase from the real schedule; a fork-only dev toggle overrides the DISPLAYED phase so
  // every window is previewable locally (the contract still enforces the true window).
  const realPhase: Phase = schedule ? currentPhase(schedule, nowSec) : "closed"
  const [devPhase, setDevPhase] = useState<Phase | null>(null)
  const phase: Phase = devPhase ?? realPhase
  const next = schedule ? nextTransition(schedule, nowSec) : null

  // ── the caller's public-mint fee (escalates per wallet); claim/allowlist pay baseFee ──
  const feeRead = useReadContract({
    address: minter, abi: homageMinterAbi, functionName: "mintFeeOf", args: [address ?? ZERO],
    chainId: PREFERRED_CHAIN.id, query: {enabled: !!address},
  })
  const publicFee = (feeRead.data as bigint | undefined) ?? baseFee
  // The fee folded into the quote depends on the phase (claim/allowlist are flat baseFee).
  const activeFee = phase === "public" ? publicFee : baseFee

  // allowlist eligibility (build-time Merkle proof, vendored from the homage repo)
  const allowlistProof = address ? allowlistProofFor(address) : null
  const isAllowlisted = !!allowlistProof
  const allowlistRemaining = maxPerAllowlisted !== undefined ? Math.max(maxPerAllowlisted - allowlistUsed, 0) : undefined

  // ── live quote ───────────────────────────────────────────────────────────────
  const [quote, setQuote] = useState<MintQuote | null>(null)
  const [quoteErr, setQuoteErr] = useState<string | null>(null)
  // Batch: 1..MAX_BATCH tokens per public mint. Claim/allowlist stay single.
  const [qty, setQty] = useState(1)
  const maxBatchRead = useReadContract({
    address: minter, abi: homageMinterAbi, functionName: "MAX_BATCH", chainId: PREFERRED_CHAIN.id,
  })
  const maxBatch = maxBatchRead.data !== undefined ? Number(maxBatchRead.data as bigint) : 20
  const batchQty = phase === "public" ? qty : 1
  // The exact summed fee for the next `batchQty` public mints — escalates per token
  // (baseFee * 1.1^n), so the on-screen total rises faster than linear, matching what
  // the contract actually charges. quoteBatchFee(you, 1) == mintFeeOf(you).
  const batchFeeRead = useReadContract({
    address: minter,
    abi: homageMinterAbi,
    functionName: "quoteBatchFee",
    args: [address ?? ZERO, BigInt(batchQty)],
    chainId: PREFERRED_CHAIN.id,
    query: {enabled: !!address && phase === "public"},
  })
  const batchFee = batchFeeRead.data as bigint | undefined
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

  // The drawn/claimed punk id for the reveal — from Minted (public/allowlist) or Claimed.
  const revealPunkId = useMemo(() => {
    if (!receipt) return null
    try {
      const minted = parseEventLogs({abi: homageMinterAbi, logs: receipt.logs, eventName: "Minted"})
      const m = minted.find((l) => l.address.toLowerCase() === minter.toLowerCase())
      if (m) return m.args.punkId as bigint
      const claimed = parseEventLogs({abi: homageMinterAbi, logs: receipt.logs, eventName: "Claimed"})
      const c = claimed.find((l) => l.address.toLowerCase() === minter.toLowerCase())
      return c ? (c.args.punkId as bigint) : null
    } catch {
      return null
    }
  }, [receipt, minter])

  const total = quote?.totalValue
  const claimTotal = quote ? quote.ethForSwap + baseFee : undefined // claim/allowlist flat fee
  const {data: balance} = useBalance({address, chainId: PREFERRED_CHAIN.id, query: {enabled: !!address && !wrongNetwork}})
  // The true all-in cost for the selected quantity: the swap leg (≈ linear per token) +
  // the EXACT escalating fee leg from the contract. Rises faster than linear, so the
  // number on screen matches the throttle. Fall back to the flat estimate before the
  // quoteBatchFee read lands.
  const batchTotal =
    quote && batchFee !== undefined
      ? BigInt(batchQty) * quote.ethForSwap + batchFee
      : total !== undefined
        ? total * BigInt(batchQty)
        : undefined
  const insufficient = !!balance && batchTotal !== undefined && !wrongNetwork && balance.value < batchTotal
  // The headline price: the escalating batch total for the chosen quantity in public,
  // the flat claim fee otherwise.
  const priceValue = phase === "public" ? (batchQty > 1 ? batchTotal : total) : claimTotal

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

  const showRedeem = !!address && !wrongNetwork

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

          {/* window countdown — time left in the current claim / allowlist window */}
          {(phase === "claim" || phase === "allowlist") && next && (
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
              {phase === "claim" ? "Claim" : "Allowlist"} closes in{" "}
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
            {phase === "public" && batchQty > 1 && (
              <p className="text-[10px] font-mono text-gray-400">
                The mint fee rises 10% per token — later mints in the batch cost more.
              </p>
            )}
          </div>

          {/* reveal / success */}
          {isSuccess && txHash && (
            revealPunkId !== null ? (
              <HomageReveal
                collection={collection}
                punkId={revealPunkId}
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
                          onClick={() => setQty((q) => Math.max(1, q - 1))}
                          disabled={qty <= 1 || isPending}
                          className="px-3 py-1.5 text-sm font-mono text-gray-500 transition-colors hover:text-fg disabled:opacity-30"
                          aria-label="decrease quantity"
                        >
                          −
                        </button>
                        <span className="w-10 text-center text-sm font-mono tabular-nums">{qty}</span>
                        <button
                          onClick={() => setQty((q) => Math.min(maxBatch, q + 1))}
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
                    disabled={isPending || soldOut || total === undefined || insufficient}
                    className={btnPrimary}
                  >
                    {soldOut
                      ? "Sold out"
                      : isPending
                        ? "Minting…"
                        : insufficient
                          ? "Insufficient balance"
                          : qty > 1
                            ? `Mint ${qty} homages`
                            : "Mint a homage"}
                  </button>
                </div>
              ) : phase === "allowlist" ? (
                isAllowlisted && (allowlistRemaining ?? 0) > 0 ? (
                  <button onClick={doAllowlistMint} disabled={isPending || soldOut || claimTotal === undefined} className={btnPrimary}>
                    {isPending ? "Minting…" : `Allowlist mint${allowlistRemaining !== undefined ? ` · ${allowlistRemaining} left` : ""}`}
                  </button>
                ) : (
                  <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                    {isAllowlisted ? "Your allowlist allocation is used up." : "This wallet isn’t on the allowlist. The public mint opens next."}
                  </p>
                )
              ) : phase === "claim" ? (
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
              ) : (
                <p className="text-[11px] font-mono text-gray-500">Minting isn’t open yet.</p>
              )}

              {writeError && (
                <p className="text-[10px] font-mono text-status-sold leading-relaxed">{formatWriteError(writeError, "mint")}</p>
              )}
            </div>
          )}

          {/* fork-only phase preview toggle */}
          {FORK_MODE && (
            <div className="pt-2 mt-1 border-t border-gray-100 flex items-center gap-2 flex-wrap">
              <span className="text-[9px] font-mono uppercase tracking-wider text-gray-400">Dev phase</span>
              {(["claim", "allowlist", "public", null] as const).map((p) => (
                <button
                  key={p ?? "live"}
                  onClick={() => setDevPhase(p)}
                  className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${
                    devPhase === p ? "bg-fg text-bg" : "text-gray-400 hover:text-fg"
                  }`}
                >
                  {p ?? "live"}
                </button>
              ))}
              <span className="text-[9px] font-mono text-gray-400">(real: {realPhase})</span>
            </div>
          )}
        </div>
      </div>

      {/* redeem — available to homage holders regardless of phase */}
      {showRedeem && (
        <HomageRedeem minter={minter} collection={collection} address={address!} exitFee={exitFee} refreshKey={refreshKey} onRedeemed={() => setRefreshKey((k) => k + 1)} />
      )}
    </section>
  )
}

const btnPrimary =
  "block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"

// ETH display: at most 4 decimal places, trailing zeros trimmed (0.0090 → 0.009).
function fmtEth(wei: bigint): string {
  const [int, frac = ""] = formatEther(wei).split(".")
  const trimmed = frac.slice(0, 4).replace(/0+$/, "")
  return trimmed ? `${int}.${trimmed}` : int
}
