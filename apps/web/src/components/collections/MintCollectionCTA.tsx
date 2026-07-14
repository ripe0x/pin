"use client"

/**
 * Live mint CTA for a Surface. Honest pricing: for a fixed-price
 * collection the collector pays exactly price * quantity, shown up front. For
 * a collection with a price strategy (hasPriceStrategy), the price can change
 * block to block (e.g. a basefee-driven strategy), so this reads a live quote
 * via currentPrice on a slow poll (12s — never tighter, this is a paid RPC
 * path) and sends that quoted value as msg.value. The contract accepts
 * `msg.value >= currentPrice` and pull-refunds any excess to the pending
 * withdrawal balance, so a quote that goes slightly stale between read and
 * broadcast still succeeds — it just leaves a small refund claimable via
 * WithdrawPanel instead of reverting.
 *
 * The fixed Referral Share is shown explicitly as a split out of the price,
 * paid to whoever hosts this mint (PND here, the artist on their own site). A
 * 0 ETH price is "Gas only", never "free".
 *
 * Pooled-mode collections (sellsViaMinterOnly) never sell through this direct
 * path — they mint exclusively through an authorized minter extension — so
 * this component renders a quiet notice instead of a buy flow.
 */

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { encodeAbiParameters, formatEther, parseEventLogs } from "viem"
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { surfaceAbi, gateHookAbi } from "@pin/abi"
import {
  AllowlistChecker,
  EligibilityVerdict,
  useEligibility,
} from "@/components/collections/MintGate"
import {
  Countdown,
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  TxSuccessBanner,
  formatWriteError,
  useChainNowSec,
} from "@/components/tx/tx-ui"
import { MintReveal } from "@/components/collections/MintReveal"
import {
  SurfaceStatus,
  COLLECTION_STATUS_LABEL,
  REFERRAL_SHARE_BPS,
  ZERO_ADDRESS,
  evmNowTxUrl,
  formatBps,
  hasPriceStrategy,
  isGasOnly,
  isMintable,
  lifecycleStatus,
  pndReferrerAddress,
  sellsViaMinterOnly,
  shortAddress,
  type IdMode,
  type WorkConfig,
} from "@/lib/collection"

export type MintCollectionSnapshot = {
  price: string
  supplyCap: string
  mintStart: string
  mintEnd: string
  minted: string
  status: number
  priceStrategy: `0x${string}`
  idMode: IdMode
}

/** Serializable mirror of collection-onchain's GateState. */
export type MintGateSnapshot = {
  hook: `0x${string}`
  isGateHook: boolean
  root: `0x${string}`
  cap: string
}

const ZERO_ROOT = ("0x" + "0".repeat(64)) as `0x${string}`

export function MintCollectionCTA({
  collection,
  snapshot,
  referrer,
  work,
  gate,
}: {
  collection: `0x${string}`
  snapshot: MintCollectionSnapshot
  /** Override the mint referrer (a self-hosted page passes the artist's own
   *  address). Defaults to PND's configured referrer. */
  referrer?: `0x${string}`
  /** The collection's work config when generative — enables the live reveal
   *  after a successful mint. Omit/null for edition presets. */
  work?: WorkConfig | null
  /** The collection's mint gate, when a hook is attached (server-read). */
  gate?: MintGateSnapshot | null
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
  const nowSec = useChainNowSec()
  const router = useRouter()

  const storedPrice = BigInt(snapshot.price)
  const supplyCap = BigInt(snapshot.supplyCap)
  const minted = BigInt(snapshot.minted)
  const mintEnd = BigInt(snapshot.mintEnd)
  const mintStart = BigInt(snapshot.mintStart)
  const referrerAddr = referrer ?? pndReferrerAddress()
  const strategy = hasPriceStrategy(snapshot.priceStrategy)
  const pooled = sellsViaMinterOnly(snapshot.idMode)

  const [amount, setAmount] = useState(1)
  const amountValid = Number.isInteger(amount) && amount >= 1

  // Live price quote for strategy collections. 12s poll — this is a paid RPC
  // read (currentPrice), never tighten below this without checking the RPC
  // budget. Fixed-price collections skip the read entirely (query.enabled).
  const {
    data: liveQuote,
    refetch: refetchLiveQuote,
  } = useReadContract({
    address: collection,
    abi: surfaceAbi,
    functionName: "currentPrice",
    args: [address ?? ZERO_ADDRESS, BigInt(amountValid ? amount : 1), "0x"],
    query: {
      enabled: strategy,
      refetchInterval: 12_000,
    },
  })

  // Stale-price defense (exact-payment semantics, §6.3): a click on a
  // strategy collection first re-reads the quote; if it moved since what's
  // on screen, we show the new total and require a second click rather than
  // ever sending a value the collector hasn't seen confirmed.
  const [priceConfirmPending, setPriceConfirmPending] = useState(false)
  useEffect(() => {
    setPriceConfirmPending(false)
  }, [amount])

  // ── mint gate (GateHook: merkle allowlist + per-wallet cap) ─────────────
  const allowlisted = !!gate && gate.isGateHook && gate.root !== ZERO_ROOT
  const walletCap = gate && gate.isGateHook ? BigInt(gate.cap) : 0n
  const unknownHook = !!gate && !gate.isGateHook
  // Eligibility of the connected wallet (one API lookup per wallet; the
  // proof rides back with it and goes into hookData at mint time).
  const eligibility = useEligibility(collection, allowlisted ? address : undefined)
  const proof = eligibility && eligibility.eligible === true ? eligibility.proof ?? [] : null
  // Per-wallet remaining allowance: one eth_call per connected wallet, only
  // when a cap is actually set — this is mint-time correctness, not polling.
  const { data: walletRemainingRaw } = useReadContract({
    address: gate?.hook,
    abi: gateHookAbi,
    functionName: "remainingFor",
    args: [collection, address ?? ZERO_ADDRESS],
    query: { enabled: !!address && !!gate && gate.isGateHook && walletCap > 0n, staleTime: 15_000 },
  })
  const walletRemaining =
    walletCap > 0n && walletRemainingRaw !== undefined ? (walletRemainingRaw as bigint) : null
  const walletCapReached = walletRemaining !== null && walletRemaining <= 0n

  const remaining = supplyCap > 0n ? supplyCap - minted : null
  const capReached = remaining !== null && remaining <= 0n

  const status = lifecycleStatus({ mintStart, mintEnd, supplyCap }, minted, nowSec)
  const ready = nowSec > 0 || (mintEnd === 0n && mintStart === 0n)
  const notStarted = mintStart > 0n && nowSec > 0 && BigInt(nowSec) < mintStart
  const mintable =
    ready &&
    !notStarted &&
    isMintable({ mintStart, mintEnd, supplyCap }, minted, nowSec || Number(mintStart))

  // For a strategy collection, `total` is the live quote for the current
  // quantity (already scaled by quantity by currentPrice itself). For a
  // fixed-price collection it's simply price * quantity.
  const total = strategy
    ? (liveQuote as bigint | undefined) ?? 0n
    : amountValid
      ? storedPrice * BigInt(amount)
      : storedPrice
  const perTokenPrice = strategy ? (amountValid && amount > 0 ? total / BigInt(amount) : total) : storedPrice
  const { referralCut, artistCut } = splitOutOfPrice(total, referrerAddr)
  const showSplit = !isGasOnly(total) && referrerAddr !== ZERO_ADDRESS

  const { data: balance } = useBalance({
    address,
    chainId: PREFERRED_CHAIN.id,
    query: { enabled: !!address && !wrongNetwork },
  })

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract()
  const {
    isLoading: isTxPending,
    isSuccess,
    data: receipt,
  } = useWaitForTransactionReceipt({ hash: txHash })
  const isPending = isWritePending || isTxPending

  // Reveal polish (§7): the moment the receipt lands, refresh the server
  // component tree so the minted-count header stops showing the pre-mint
  // number — don't wait for the collector to dismiss the reveal to fix that.
  useEffect(() => {
    if (isSuccess) router.refresh()
  }, [isSuccess, router])

  // The reveal's inputs come straight from the receipt's Minted event —
  // no extra reads, no indexer round trip.
  const mintedEvent = useMemo(() => {
    if (!receipt) return null
    try {
      const logs = parseEventLogs({ abi: surfaceAbi, logs: receipt.logs, eventName: "Minted" })
      const log = logs.find((l) => l.address.toLowerCase() === collection.toLowerCase())
      if (!log) return null
      return {
        firstTokenId: log.args.firstTokenId as bigint,
        quantity: log.args.quantity as bigint,
      }
    } catch {
      return null
    }
  }, [receipt, collection])

  async function handleMint() {
    if (!amountValid) return
    // Allowlist gates verify a merkle proof from hookData; without one the
    // tx is doomed, so the button never enables in that state (belt) and we
    // bail here too (suspenders).
    if (allowlisted && !proof) return
    let sendValue = total
    if (strategy) {
      // Re-quote immediately before writing. `total` here is a closed-over
      // value from the render that produced this click handler — i.e. what
      // the collector actually saw on screen.
      const { data: fresh } = await refetchLiveQuote()
      if (fresh !== undefined && fresh !== total) {
        // The refetch above already updated the cached quote, so the next
        // render shows the new total — require one more click at that price
        // instead of sending the stale one.
        setPriceConfirmPending(true)
        return
      }
      sendValue = fresh ?? total
    }
    setPriceConfirmPending(false)
    const hookData =
      allowlisted && proof
        ? encodeAbiParameters([{ type: "bytes32[]" }], [proof])
        : "0x"
    writeContract({
      address: collection,
      abi: surfaceAbi,
      functionName: "mintWithReferral",
      args: [BigInt(amount), referrerAddr, hookData],
      value: sendValue,
    })
  }

  // Balance pre-check (§6.3): the balance hook already exists and is already
  // fetching (no new RPC read); use it to disable a doomed mint before the
  // collector signs it.
  const insufficientBalance = !!balance && !wrongNetwork && balance.value < total

  const mintOrderFrom = Number(minted) + 1
  const mintOrderTo = Number(minted) + amount
  const isFirstEver = minted === 0n

  // Sold out and window-closed are both Closed onchain but read very
  // differently: one is the collection completing, the other is a window
  // that may reopen (settings are live until lockSupply/lockRenderer).
  const soldOut = status === SurfaceStatus.Closed && capReached
  const statusLabel = soldOut ? "Sold out" : COLLECTION_STATUS_LABEL[status]
  const statusDot =
    status === SurfaceStatus.Open
      ? "bg-status-available animate-pulse"
      : status === SurfaceStatus.Scheduled
        ? "bg-status-upcoming"
        : soldOut
          ? "bg-status-sold"
          : "bg-gray-400"

  if (pooled) {
    return (
      <section className="py-5 border-b border-gray-100">
        <div className="rounded-lg border border-gray-200 bg-surface p-5">
          <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
            This collection mints through its minter. It does not sell directly
            through this page.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="py-5 border-b border-gray-100">
      <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot}`} />
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                {statusLabel}
              </span>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
              {supplyCap > 0n
                ? `${Number(minted)} / ${Number(supplyCap)} minted`
                : `${Number(minted)} minted · open`}
            </span>
          </div>

          <div className="flex items-end justify-between gap-6">
            <div className="space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Price</p>
              <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
                {isGasOnly(perTokenPrice) && !strategy ? (
                  <>
                    Gas only{" "}
                    <span className="text-sm font-mono text-gray-500">· you pay network gas</span>
                  </>
                ) : (
                  <>
                    {formatEther(perTokenPrice)}{" "}
                    <span className="text-sm font-mono text-gray-500">ETH</span>
                  </>
                )}
              </p>
              {strategy && (
                <p className="text-[10px] font-mono text-gray-400">
                  Live quote, updates automatically. The final amount may
                  include an automatic refund if the price moves between quote
                  and confirmation.
                </p>
              )}
            </div>
            {notStarted ? (
              <div className="text-right space-y-1">
                <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Opens in
                </p>
                <p className="text-sm font-mono tabular-nums leading-none">
                  <Countdown endTime={mintStart} nowSec={nowSec} />
                </p>
              </div>
            ) : (
              mintEnd > 0n &&
              status === SurfaceStatus.Open && (
                <div className="text-right space-y-1">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    Closes in
                  </p>
                  <p className="text-sm font-mono tabular-nums leading-none">
                    <Countdown endTime={mintEnd} nowSec={nowSec} />
                  </p>
                </div>
              )
            )}
          </div>

          {isSuccess &&
            txHash &&
            (mintedEvent ? (
              <MintReveal
                collection={collection}
                work={work && work.code.length > 0 ? work : null}
                firstTokenId={mintedEvent.firstTokenId}
                quantity={mintedEvent.quantity}
                txHash={txHash}
                chainId={PREFERRED_CHAIN.id}
                onDismiss={() => {
                  reset()
                  router.refresh()
                }}
              />
            ) : (
              <TxSuccessBanner
                txHash={txHash}
                chainId={PREFERRED_CHAIN.id}
                message="Minted. Your Mint Mark is recorded onchain."
                onDismiss={() => {
                  reset()
                  router.refresh()
                }}
              />
            ))}

          {/* Mint gate: eligibility answered before anyone signs (§5). */}
          {allowlisted && !(isSuccess && txHash) && (
            <div className="rounded border border-gray-200 bg-surface-muted/40 px-3 py-2.5 space-y-2">
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Allowlist mint
                {walletCap > 0n && (
                  <span className="normal-case"> · limit {walletCap.toString()} per wallet</span>
                )}
              </p>
              {address ? (
                <EligibilityVerdict eligibility={eligibility} />
              ) : (
                <AllowlistChecker collection={collection} />
              )}
            </div>
          )}
          {!allowlisted && walletCap > 0n && !(isSuccess && txHash) && (
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              Limit {walletCap.toString()} per wallet
              {walletRemaining !== null && (
                <span className="normal-case">
                  {" "}
                  · you can mint {walletRemaining.toString()} more
                </span>
              )}
            </p>
          )}
          {unknownHook && !(isSuccess && txHash) && (
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              This mint has additional onchain conditions set by its artist
              (hook {shortAddress(gate!.hook)}). If they are not met, the
              transaction reverts.
            </p>
          )}

          {mintable && !(isSuccess && txHash) && (
            <>
              <label className="block">
                <span className="sr-only">Number of tokens to mint</span>
                <div className="flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors">
                  <button
                    type="button"
                    aria-label="One fewer"
                    onClick={() => setAmount((a) => Math.max(1, a - 1))}
                    disabled={isPending || amount <= 1}
                    className="px-4 text-sm font-mono text-gray-500 hover:text-fg border-r border-gray-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10)
                      setAmount(Number.isNaN(n) ? 0 : n)
                    }}
                    disabled={isPending}
                    className="w-0 flex-1 px-3 py-3 text-center text-sm font-mono tabular-nums outline-none disabled:opacity-40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <button
                    type="button"
                    aria-label="One more"
                    onClick={() =>
                      setAmount((a) => {
                        let max = Number.MAX_SAFE_INTEGER
                        if (remaining !== null) max = Math.min(max, Number(remaining))
                        if (walletRemaining !== null && walletRemaining < BigInt(Number.MAX_SAFE_INTEGER)) {
                          max = Math.min(max, Number(walletRemaining))
                        }
                        return Math.min(a + 1, max)
                      })
                    }
                    disabled={
                      isPending ||
                      (remaining !== null && amount >= Number(remaining)) ||
                      (walletRemaining !== null &&
                        walletRemaining < BigInt(Number.MAX_SAFE_INTEGER) &&
                        amount >= Number(walletRemaining))
                    }
                    className="px-4 text-sm font-mono text-gray-500 hover:text-fg border-l border-gray-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    +
                  </button>
                  <span className="flex items-center px-3 text-[11px] font-mono uppercase tracking-wider text-gray-400 border-l border-gray-200">
                    {amount === 1 ? "token" : "tokens"}
                  </span>
                </div>
              </label>

              <div className="rounded border border-gray-200 bg-surface-muted/40 px-3 py-2.5">
                <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-1">
                  Your Mint Mark
                </p>
                <p className="text-[11px] font-mono text-gray-600 leading-relaxed">
                  {amount === 1
                    ? `Mint #${mintOrderFrom} of this collection`
                    : `Mints #${mintOrderFrom}–#${mintOrderTo} of this collection`}
                  {isFirstEver && <span className="text-fg"> · you would hold the first token</span>}
                </p>
              </div>

              {!isGasOnly(total) && (
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                      You pay
                    </span>
                    <span className="text-sm font-mono tabular-nums">{formatEther(total)} ETH</span>
                  </div>
                  {showSplit ? (
                    <div className="space-y-1.5">
                      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                        <div className="bg-fg" style={{ width: `${100 - REFERRAL_SHARE_BPS / 100}%` }} />
                        <div
                          className="bg-status-live"
                          style={{ width: `${REFERRAL_SHARE_BPS / 100}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] font-mono text-gray-500 tabular-nums">
                        <span>{formatEther(artistCut)} ETH to artist</span>
                        <span>
                          {formatEther(referralCut)} ETH to referrer ({formatBps(REFERRAL_SHARE_BPS)})
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[10px] font-mono text-gray-500">
                      100% to the artist (no referrer).
                    </p>
                  )}
                </div>
              )}

              {balance && (
                <div className="flex justify-end">
                  <span
                    className={`text-[10px] font-mono uppercase tracking-wider tabular-nums ${
                      insufficientBalance ? "text-red-500" : "text-gray-400"
                    }`}
                  >
                    Balance: {Number(formatEther(balance.value)).toFixed(3)} ETH
                  </span>
                </div>
              )}

              {!address ? (
                <ConnectButton.Custom>
                  {({ openConnectModal }) => (
                    <button
                      onClick={openConnectModal}
                      className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
                    >
                      Connect wallet to mint
                    </button>
                  )}
                </ConnectButton.Custom>
              ) : wrongNetwork ? (
                <button
                  type="button"
                  onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
                  disabled={isSwitchPending}
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40"
                >
                  {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
                </button>
              ) : (
                <>
                  <button
                    onClick={handleMint}
                    disabled={
                      isPending ||
                      !amountValid ||
                      (strategy && liveQuote === undefined) ||
                      insufficientBalance ||
                      (allowlisted && !proof) ||
                      walletCapReached
                    }
                    className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isWritePending
                      ? "Confirm in wallet…"
                      : isTxPending
                        ? "Minting…"
                        : walletCapReached
                          ? "You have minted your maximum"
                          : allowlisted && eligibility === undefined
                            ? "Checking the allowlist…"
                            : allowlisted && eligibility?.eligible === false
                              ? "Not on the allowlist"
                              : allowlisted && !proof
                                ? "Allowlist unavailable"
                                : insufficientBalance
                                  ? "Insufficient balance"
                                  : priceConfirmPending
                                    ? "Price updated, confirm again"
                                    : isGasOnly(total)
                                      ? "Mint (gas only)"
                                      : `Mint for ${formatEther(total)} ETH`}
                  </button>
                  {isTxPending && txHash && (
                    <a
                      href={evmNowTxUrl(txHash, PREFERRED_CHAIN.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-center text-[10px] font-mono text-gray-400 underline hover:text-fg"
                    >
                      View transaction ↗
                    </a>
                  )}
                </>
              )}

              {writeError && (
                <p className="text-[11px] font-mono text-red-500 break-words">
                  {formatWriteError(writeError, "Mint")}
                </p>
              )}

              <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
                Minting on{" "}
                {referrerAddr === ZERO_ADDRESS ? "directly" : `via referrer ${shortAddress(referrerAddr)}`}.
                You receive a distinct ERC721 token with its own onchain Mint Mark.
              </p>
            </>
          )}

          {!mintable && !(isSuccess && txHash) && ready && (
            <>
              {notStarted ? (
                <>
                  <div className="rounded border border-gray-200 bg-surface-muted/40 px-3 py-2.5">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-1">
                      Your Mint Mark
                    </p>
                    <p className="text-[11px] font-mono text-gray-600 leading-relaxed">
                      {`Mint #${mintOrderFrom} of this collection`}
                      {isFirstEver && (
                        <span className="text-fg"> · the first mint is still open</span>
                      )}
                    </p>
                  </div>
                  <div className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 border border-gray-200 text-gray-400 tabular-nums select-none">
                    Opens in <Countdown endTime={mintStart} nowSec={nowSec} />
                  </div>
                  <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
                    This page goes live automatically when the window opens. No
                    refresh needed.
                  </p>
                </>
              ) : soldOut ? (
                <p className="text-[11px] font-mono text-gray-600 leading-relaxed">
                  All {Number(supplyCap)} pieces are minted.
                  {work && work.code.length > 0
                    ? " The full collection lives on this page, every token rendering live from its onchain seed."
                    : " The full collection lives on this page."}
                </p>
              ) : (
                <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                  The mint window has closed with {Number(minted)}
                  {supplyCap > 0n ? ` of ${Number(supplyCap)}` : ""} minted.
                  Sale settings stay live until locked, so the artist can
                  reopen it.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/** The fixed Referral Share split of `total`, out of the price. */
function splitOutOfPrice(
  total: bigint,
  referrer: `0x${string}`,
): { referralCut: bigint; artistCut: bigint } {
  const referralCut = referrer === ZERO_ADDRESS ? 0n : (total * BigInt(REFERRAL_SHARE_BPS)) / 10_000n
  return { referralCut, artistCut: total - referralCut }
}
