"use client"

/**
 * Live mint CTA for a PND Edition. Honest pricing: the collector pays exactly
 * price * quantity. The fixed Surface Share is shown explicitly as a split out
 * of that price, paid to whoever hosts this mint (PND here, the artist on
 * their own site). A 0 ETH price is "Gas only", never "free".
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatEther } from "viem"
import {
  useAccount,
  useBalance,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { pndEditionsAbi } from "@pin/abi"
import {
  Countdown,
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  TxSuccessBanner,
  formatWriteError,
  useChainNowSec,
} from "@/components/tx/tx-ui"
import {
  EditionStatus,
  EDITION_STATUS_LABEL,
  SURFACE_SHARE_BPS,
  ZERO_ADDRESS,
  formatBps,
  isGasOnly,
  isMintable,
  lifecycleStatus,
  pndSurfaceAddress,
  shortAddress,
  splitOutOfPrice,
} from "@/lib/pnd-editions"

export type MintSnapshot = {
  price: string
  supplyCap: string
  mintStart: string
  mintEnd: string
  minted: string
  status: number
}

export function MintEditionCTA({
  edition,
  snapshot,
  surface,
}: {
  edition: `0x${string}`
  snapshot: MintSnapshot
  /** Override the mint surface (a self-hosted page passes the artist's own
   *  address). Defaults to PND's configured surface. */
  surface?: `0x${string}`
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
  const nowSec = useChainNowSec()
  const router = useRouter()

  const price = BigInt(snapshot.price)
  const supplyCap = BigInt(snapshot.supplyCap)
  const minted = BigInt(snapshot.minted)
  const mintEnd = BigInt(snapshot.mintEnd)
  const mintStart = BigInt(snapshot.mintStart)
  const surfaceAddr = surface ?? pndSurfaceAddress()

  const [amount, setAmount] = useState(1)
  const amountValid = Number.isInteger(amount) && amount >= 1

  const remaining = supplyCap > 0n ? supplyCap - minted : null
  const capReached = remaining !== null && remaining <= 0n

  const status = lifecycleStatus(
    { mintEnd, supplyCap },
    minted,
    snapshot.status === EditionStatus.Closing,
    nowSec,
  )
  const ready = nowSec > 0 || (mintEnd === 0n && mintStart === 0n)
  const notStarted = mintStart > 0n && nowSec > 0 && BigInt(nowSec) < mintStart
  const mintable =
    ready &&
    !notStarted &&
    isMintable({ mintStart, mintEnd, supplyCap }, minted, nowSec || Number(mintStart))

  const total = amountValid ? price * BigInt(amount) : price
  const { surfaceCut, artistCut } = splitOutOfPrice(total, surfaceAddr)
  const showSplit = !isGasOnly(price) && surfaceAddr !== ZERO_ADDRESS

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
      address: edition,
      abi: pndEditionsAbi,
      functionName: "mint",
      args: [BigInt(amount), surfaceAddr, "0x"],
      value: total,
    })
  }

  const mintOrderFrom = Number(minted) + 1
  const mintOrderTo = Number(minted) + amount
  const isFirstEver = minted === 0n

  const statusDot =
    status === EditionStatus.Open
      ? "bg-emerald-500 animate-pulse"
      : status === EditionStatus.Closing
        ? "bg-amber-500"
        : "bg-gray-400"

  return (
    <section className="py-5 border-b border-gray-100">
      <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot}`} />
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                {EDITION_STATUS_LABEL[status]}
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
                {isGasOnly(price) ? (
                  <>
                    Gas only{" "}
                    <span className="text-sm font-mono text-gray-500">· you pay network gas</span>
                  </>
                ) : (
                  <>
                    {formatEther(price)} <span className="text-sm font-mono text-gray-500">ETH</span>
                  </>
                )}
              </p>
            </div>
            {mintEnd > 0n && status !== EditionStatus.Closed && (
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
                    ? `Mint #${mintOrderFrom} of this edition`
                    : `Mints #${mintOrderFrom}–#${mintOrderTo} of this edition`}
                  {isFirstEver && <span className="text-fg"> · you would hold the first token</span>}
                </p>
              </div>

              {!isGasOnly(price) && (
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
                        <div className="bg-fg" style={{ width: `${100 - SURFACE_SHARE_BPS / 100}%` }} />
                        <div
                          className="bg-status-live"
                          style={{ width: `${SURFACE_SHARE_BPS / 100}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] font-mono text-gray-500 tabular-nums">
                        <span>{formatEther(artistCut)} ETH to artist</span>
                        <span>
                          {formatEther(surfaceCut)} ETH to this surface ({formatBps(SURFACE_SHARE_BPS)})
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[10px] font-mono text-gray-500">
                      100% to the artist on this surface.
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
                  disabled={isPending || !amountValid}
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isWritePending
                    ? "Confirm in wallet…"
                    : isTxPending
                      ? "Minting…"
                      : isGasOnly(price)
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
                {surfaceAddr === ZERO_ADDRESS ? "this surface" : `surface ${shortAddress(surfaceAddr)}`}.
                You receive a distinct ERC721 token with its own onchain Mint Mark.
              </p>
            </>
          )}

          {!mintable && !(isSuccess && txHash) && ready && (
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              {notStarted
                ? "This edition has not opened yet."
                : capReached
                  ? "This edition has reached its cap."
                  : "This edition is closed."}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
