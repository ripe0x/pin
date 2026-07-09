"use client"

/**
 * Live mint CTA for a Sovereign Collection. Honest pricing: for a fixed-price
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

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatEther } from "viem"
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
import { sovereignCollectionAbi } from "@pin/abi"
import {
  Countdown,
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  TxSuccessBanner,
  formatWriteError,
  useChainNowSec,
} from "@/components/tx/tx-ui"
import {
  CollectionStatus,
  COLLECTION_STATUS_LABEL,
  REFERRAL_SHARE_BPS,
  ZERO_ADDRESS,
  formatBps,
  hasPriceStrategy,
  isGasOnly,
  isMintable,
  lifecycleStatus,
  pndReferrerAddress,
  sellsViaMinterOnly,
  shortAddress,
  type IdMode,
} from "@/lib/sovereign-collection"

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

export function MintCollectionCTA({
  collection,
  snapshot,
  referrer,
}: {
  collection: `0x${string}`
  snapshot: MintCollectionSnapshot
  /** Override the mint referrer (a self-hosted page passes the artist's own
   *  address). Defaults to PND's configured referrer. */
  referrer?: `0x${string}`
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
  const { data: liveQuote } = useReadContract({
    address: collection,
    abi: sovereignCollectionAbi,
    functionName: "currentPrice",
    args: [address ?? ZERO_ADDRESS, BigInt(amountValid ? amount : 1), "0x"],
    query: {
      enabled: strategy,
      refetchInterval: 12_000,
    },
  })

  const remaining = supplyCap > 0n ? supplyCap - minted : null
  const capReached = remaining !== null && remaining <= 0n

  const status = lifecycleStatus(
    { mintEnd, supplyCap },
    minted,
    snapshot.status === CollectionStatus.Closing,
    nowSec,
  )
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
  const { isLoading: isTxPending, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  const isPending = isWritePending || isTxPending

  function handleMint() {
    if (!amountValid) return
    writeContract({
      address: collection,
      abi: sovereignCollectionAbi,
      functionName: "mintWithReferral",
      args: [BigInt(amount), referrerAddr, "0x"],
      value: total,
    })
  }

  const mintOrderFrom = Number(minted) + 1
  const mintOrderTo = Number(minted) + amount
  const isFirstEver = minted === 0n

  const statusDot =
    status === CollectionStatus.Open
      ? "bg-emerald-500 animate-pulse"
      : status === CollectionStatus.Closing
        ? "bg-amber-500"
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
                {COLLECTION_STATUS_LABEL[status]}
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
            {mintEnd > 0n && status !== CollectionStatus.Closed && (
              <div className="text-right space-y-1">
                <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Closes in
                </p>
                <p className="text-sm font-mono tabular-nums leading-none">
                  <Countdown endTime={mintEnd} nowSec={nowSec} />
                </p>
              </div>
            )}
          </div>

          {isSuccess && txHash && (
            <TxSuccessBanner
              txHash={txHash}
              chainId={PREFERRED_CHAIN.id}
              message="Minted. Your Mint Mark is recorded onchain."
              onDismiss={() => {
                reset()
                router.refresh()
              }}
            />
          )}

          {mintable && !(isSuccess && txHash) && (
            <>
              <label className="block">
                <span className="sr-only">Number of tokens to mint</span>
                <div className="flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors">
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
                    className="flex-1 px-3 py-3 text-sm font-mono tabular-nums outline-none disabled:opacity-40"
                  />
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
                  <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
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
                <button
                  onClick={handleMint}
                  disabled={isPending || !amountValid || (strategy && liveQuote === undefined)}
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isWritePending
                    ? "Confirm in wallet…"
                    : isTxPending
                      ? "Minting…"
                      : isGasOnly(total)
                        ? "Mint (gas only)"
                        : `Mint for ${formatEther(total)} ETH`}
                </button>
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
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              {notStarted
                ? "This collection has not opened yet."
                : capReached
                  ? "This collection has reached its cap."
                  : "This collection is closed."}
            </p>
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
