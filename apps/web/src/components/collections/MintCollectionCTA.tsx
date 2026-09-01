"use client"

/**
 * Live mint CTA for a Surface. Honest pricing: for a fixed-price
 * collection the collector pays exactly price * quantity, shown up front.
 * The shared direct provider owns validation, the 12s mutable-state refresh,
 * quotes, and transaction preparation. Every click re-quotes at the latest
 * block and requires another confirmation if the displayed value moved.
 *
 * The fixed Referral Share is shown explicitly as a split out of the price,
 * paid to whoever hosts this mint (PND here, the artist on their own site). A
 * 0 ETH price is "Gas only", never "free".
 *
 * Minting itself always goes through the collection's canonical
 * FixedPriceMinter clone (thin-token rearchitecture — the token has no paid
 * mint path of its own). When there's no canonical minter on record (a
 * bring-your-own minter, or a pooled collection — createPooledSurface never
 * wires one, see sellsViaMinterOnly), this component renders a quiet notice
 * instead of a buy flow.
 */

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { formatEther, parseEventLogs } from "viem"
import {
  useAccount,
  useBalance,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { surfaceAbi } from "@pin/abi"
import { useMintQuote, useReleaseState, useValidatedRelease } from "@pin/surface-react"
import {
  createDirectChainSurfaceProvider,
  releaseAvailability,
  type IdMode,
  type ReleaseState,
  type ValidatedRelease,
} from "@pin/surface-kit"
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
  ZERO_ADDRESS,
  evmNowTxUrl,
  formatBps,
  hasPriceStrategy,
  isGasOnly,
  pndReferrerAddress,
} from "@/lib/collection"
import type { WorkConfig } from "@/lib/collection"

/** Serializable mirror of the collection's canonical minter sale config
 *  (lib/collection.ts's MinterSaleConfig), plus the token-level cap/minted
 *  state the derived status also needs. */
export type MintCollectionSnapshot = {
  owner: `0x${string}`
  renderer: `0x${string}`
  idMode: IdMode
  observedAtBlock: string
  price: string
  priceStrategy: `0x${string}`
  mintStart: string
  mintEnd: string
  payout: `0x${string}`
  allowlistRoot: `0x${string}`
  walletCap: string
  supplyCap: string
  /** The minter's own sale ceiling. Bounds availability just as the
   *  collection's cap does, and on an open-supply release it is the only
   *  thing that does. */
  maxMints: string
  saleMinted: string
  minted: string
  referralShareBps: number
}

const ZERO_ROOT = ("0x" + "0".repeat(64)) as `0x${string}`

export function MintCollectionCTA({
  collection,
  minter,
  snapshot,
  referrer,
  work,
}: {
  collection: `0x${string}`
  /** The collection's canonical FixedPriceMinter clone. Null means no
   *  canonical minter is on record (bring-your-own minter, or a pooled
   *  collection that never wires one, or not yet indexed) — renders the
   *  quiet notice instead of a buy flow. */
  minter: `0x${string}` | null
  snapshot: MintCollectionSnapshot
  /** Override the mint referrer (a self-hosted page passes the artist's own
   *  address). Defaults to PND's configured referrer. */
  referrer?: `0x${string}`
  /** The collection's work config when generative — enables the live reveal
   *  after a successful mint. Omit/null for edition presets. */
  work?: WorkConfig | null
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
  const nowSec = useChainNowSec()
  const router = useRouter()
  const referrerAddr = referrer ?? pndReferrerAddress()
  const pooled = !minter
  const [amount, setAmount] = useState(1)
  const amountValid = Number.isInteger(amount) && amount >= 1

  // PND and the artist template deliberately share this provider and React
  // state boundary. The server snapshot gives an immediate, block-tagged
  // first paint; bounded direct reads then refresh mutable protocol truth.
  const publicClient = usePublicClient({ chainId: PREFERRED_CHAIN.id })
  const provider = useMemo(
    () => publicClient ? createDirectChainSurfaceProvider({ client: publicClient, source: "pnd-direct-rpc" }) : null,
    [publicClient],
  )
  const releaseRef = useMemo(
    () => ({ chainId: PREFERRED_CHAIN.id, collection, protocol: "surface@1" as const }),
    [collection],
  )
  const initialRelease = useMemo<ValidatedRelease>(() => ({
    ...releaseRef,
    owner: snapshot.owner,
    renderer: snapshot.renderer,
    idMode: snapshot.idMode,
    primaryMinter: minter,
    validatedAtBlock: BigInt(snapshot.observedAtBlock),
  }), [minter, releaseRef, snapshot.idMode, snapshot.observedAtBlock, snapshot.owner, snapshot.renderer])
  const initialState = useMemo<ReleaseState | null>(() => {
    if (!minter) return null
    const value: ReleaseState = {
      release: initialRelease,
      account: undefined,
      minted: BigInt(snapshot.minted),
      supplyCap: BigInt(snapshot.supplyCap),
      saleMinted: BigInt(snapshot.saleMinted),
      saleSupplyCap: BigInt(snapshot.maxMints),
      mintStart: BigInt(snapshot.mintStart),
      mintEnd: BigInt(snapshot.mintEnd),
      price: BigInt(snapshot.price),
      priceStrategy: snapshot.priceStrategy,
      allowlistRoot: snapshot.allowlistRoot,
      walletCap: BigInt(snapshot.walletCap),
      mintedByAccount: 0n,
      referralShareBps: snapshot.referralShareBps,
      lifecycle: SurfaceStatus.Closed,
      blockNumber: BigInt(snapshot.observedAtBlock),
    }
    value.lifecycle = releaseAvailability(value, Math.floor(Date.now() / 1000)).lifecycle
    return value
  }, [initialRelease, minter, snapshot])
  const validation = useValidatedRelease({
    provider,
    release: releaseRef,
    initialResult: {
      status: "available",
      value: initialRelease,
      evidence: { truth: "protocol", source: "pnd-server-first-paint", blockNumber: snapshot.observedAtBlock },
    },
    refreshMs: 30_000,
  })
  const release = validation.value ?? initialRelease
  const liveState = useReleaseState({
    provider,
    release,
    account: address,
    initialResult: initialState
      ? {
          status: "available",
          value: initialState,
          evidence: { truth: "protocol", source: "pnd-server-first-paint", blockNumber: snapshot.observedAtBlock },
        }
      : null,
    refreshMs: 12_000,
  })
  const stateMatchesRelease = Boolean(
    liveState.value
      && liveState.value.release.collection.toLowerCase() === release.collection.toLowerCase()
      && liveState.value.release.primaryMinter?.toLowerCase() === release.primaryMinter?.toLowerCase(),
  )
  const stateMatchesAccount = liveState.value?.account?.toLowerCase() === address?.toLowerCase()
    || (!liveState.value?.account && !address)
  const state = stateMatchesRelease && stateMatchesAccount ? liveState.value : null
  const mintQuote = useMintQuote({
    provider,
    input: amountValid && state
      ? {
          release,
          account: address,
          quantity: BigInt(amount),
          referrer: referrerAddr,
          selection: undefined,
        }
      : null,
  })

  // Stale-price defense (exact-payment semantics, §6.3): a click on a
  // collection always re-reads the shared quote immediately before writing.
  // If it moved, show the new total and require a second click.
  const [priceConfirmPending, setPriceConfirmPending] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  useEffect(() => {
    setPriceConfirmPending(false)
    setProviderError(null)
  }, [amount])

  // ── mint gate (allowlist + per-wallet cap, built into the minter) ───────
  const allowlisted = !!state && state.allowlistRoot?.toLowerCase() !== ZERO_ROOT
  const walletCap = state?.walletCap ?? 0n
  // Eligibility of the connected wallet (one API lookup per wallet; the
  // proof rides back with it and goes into `data` at mint time).
  const eligibility = useEligibility(collection, allowlisted ? address : undefined)
  const proof = eligibility && eligibility.eligible === true ? eligibility.proof ?? [] : null
  const availability = state
    ? releaseAvailability(state, nowSec, {
        quantity: BigInt(amountValid ? amount : 0),
        allowlistProofAvailable: !allowlisted || Boolean(proof),
      })
    : null
  const minted = state?.minted ?? BigInt(snapshot.minted)
  const mintEnd = state?.mintEnd ?? BigInt(snapshot.mintEnd)
  const mintStart = state?.mintStart ?? BigInt(snapshot.mintStart)
  const remaining = availability?.remaining ?? null
  const walletRemaining = availability?.walletRemaining ?? null
  const walletCapReached = availability?.walletCapped ?? false
  const status = availability?.lifecycle ?? SurfaceStatus.Closed
  const ready = state !== null && (nowSec > 0 || (mintEnd === 0n && mintStart === 0n))
  const notStarted = mintStart > 0n && nowSec > 0 && BigInt(nowSec) < mintStart
  const saleOpen = ready
    && validation.phase !== "blocked"
    && liveState.phase !== "blocked"
    && status === SurfaceStatus.Open
    && !availability?.soldOut
  const mintable = saleOpen && Boolean(availability?.mintable)

  const strategy = hasPriceStrategy(state?.priceStrategy ?? snapshot.priceStrategy)
  const quote = mintQuote.value
  const total = quote?.totalValue ?? 0n
  const perTokenPrice = quote?.unitPrice ?? state?.price ?? BigInt(snapshot.price)
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
    if (isSuccess) {
      router.refresh()
      void validation.refresh()
      void liveState.refresh()
    }
  }, [isSuccess, router]) // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!amountValid || !minter || !address || !provider || !state || !mintable) return
    setProviderError(null)
    // Allowlist gates verify a merkle proof from `data`; without one the
    // tx is doomed, so the button never enables in that state (belt) and we
    // bail here too (suspenders).
    if (allowlisted && !proof) return
    // Re-quote immediately before every write, including nominally fixed
    // releases. The provider owns the block-scoped price boundary.
    const fresh = await mintQuote.refresh()
    if (fresh?.status !== "available" && fresh?.status !== "partial") {
      setProviderError(fresh?.reason ?? "The current mint price could not be confirmed.")
      return
    }
    if (!quote || fresh.value.totalValue !== quote.totalValue) {
      setPriceConfirmPending(true)
      return
    }
    setPriceConfirmPending(false)
    const prepared = await provider.prepareMint({
      release,
      account: address,
      quantity: BigInt(amount),
      referrer: referrerAddr,
      quote: fresh.value,
      selection: allowlisted && proof ? { allowlistProof: proof } : undefined,
    })
    if (prepared.status !== "available" && prepared.status !== "partial") {
      setProviderError(prepared.reason)
      return
    }
    const request = prepared.value
    writeContract({
      address: request.target,
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
      value: request.value,
    })
  }

  // Balance pre-check (§6.3): the balance hook already exists and is already
  // fetching (no new RPC read); use it to disable a doomed mint before the
  // collector signs it.
  const insufficientBalance = !!balance && !wrongNetwork && balance.value < total

  // Sold out and window-closed are both Closed onchain but read very
  // differently: one is the collection completing, the other is a window
  // that may reopen (settings are live until lockSupply/lockRenderer).
  const soldOut = availability?.soldOut ?? false
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
              {minted.toString()} minted
              {remaining !== null && !soldOut ? ` · ${remaining.toString()} available` : ""}
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
                  Live quote from the collection&apos;s minter. The price is
                  confirmed again before your wallet opens.
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

          {(validation.phase === "blocked" || liveState.phase === "blocked") && (
            <div className="rounded border border-gray-200 bg-surface-muted/40 px-3 py-2.5">
              <p className="text-[11px] font-mono leading-relaxed text-gray-500" role="status">
                {validation.message ?? liveState.message ?? "Current release state is unavailable."}
              </p>
              {(validation.retryable || liveState.retryable) && (
                <button
                  type="button"
                  onClick={() => void (validation.phase === "blocked" ? validation.refresh() : liveState.refresh())}
                  className="mt-2 text-[10px] font-mono uppercase tracking-wider underline hover:text-fg"
                >
                  Retry live state
                </button>
              )}
            </div>
          )}

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
                message="Minted."
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
          {providerError && (
            <p className="text-[11px] font-mono text-red-500 break-words" role="alert">
              {providerError}
            </p>
          )}
          {saleOpen && !(isSuccess && txHash) && (
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
                </div>
              </label>

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
                      !mintable ||
                      !amountValid ||
                      !quote ||
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
                                    : !quote
                                      ? "Confirming current price…"
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
            </>
          )}

          {!saleOpen && !(isSuccess && txHash) && ready && (
            <>
              {notStarted ? (
                <>
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
                  This release is sold out.
                  {work && work.code.length > 0
                    ? " The full collection lives on this page, every token rendering live from its onchain seed."
                    : " The full collection lives on this page."}
                </p>
              ) : (
                <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                  The mint window has closed with {minted.toString()} minted.
                  Sale settings stay live until locked, so the artist can
                  reopen it.
                </p>
              )}
            </>
          )}
        </div>
      </div>
      {showSplit && (
        <p className="mt-2 text-[10px] font-mono text-gray-400 leading-relaxed">
          Price includes a {formatBps(snapshot.referralShareBps)} referral fee paid to the referrer.
        </p>
      )}
    </section>
  )
}
