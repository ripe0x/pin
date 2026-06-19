"use client"

/**
 * Generic mint CTA for the `/mint/[contract]` surface. Generalized from the
 * Editions `MintEditionCTA`: it reads everything it needs from the collection
 * descriptor (price/window/gate/mint fn), so a new standard ERC-721 is a
 * registry entry, not a new component.
 *
 * Supports both shapes:
 *   - quantity mints  (`quantity: true`)  → quantity selector, value = price*qty
 *   - single mints     (`quantity: false`) → no selector, value = price
 *     (Vouch: no-arg, one-per-wallet `mint()` gated by `hasMinted`)
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
import {
  Countdown,
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  TxSuccessBanner,
  formatWriteError,
  useChainNowSec,
} from "@/components/tx/tx-ui"
import { resolveMintCollection } from "@/lib/mint-collections"
import type { MintSnapshot } from "@/lib/mint-onchain"

function trimEth(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s
}

export function MintPanel({
  collectionId,
  snapshot,
}: {
  /** Slug or address — resolved against the registry client-side. */
  collectionId: string
  snapshot: MintSnapshot
}) {
  const desc = resolveMintCollection(collectionId)
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const nowSec = useChainNowSec()
  const router = useRouter()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const [amount, setAmount] = useState(1)

  const { data: balance } = useBalance({
    address,
    chainId: PREFERRED_CHAIN.id,
    query: { enabled: !!address && !wrongNetwork },
  })

  const { data: alreadyMintedRaw } = useReadContract({
    address: desc?.address,
    abi: desc?.abi,
    functionName: desc?.alreadyMintedFn ?? "hasMinted",
    args: address ? [address] : undefined,
    chainId: PREFERRED_CHAIN.id,
    query: { enabled: !!address && !!desc?.alreadyMintedFn },
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

  if (!desc) return null

  const price = BigInt(snapshot.priceWei)
  const minted = BigInt(snapshot.minted)
  const cap = BigInt(snapshot.cap)
  const mintStart = BigInt(snapshot.mintStart)
  const mintEnd = BigInt(snapshot.mintEnd)
  const gasOnly = price === 0n

  const qty = desc.quantity ? amount : 1
  const amountValid = !desc.quantity || (Number.isInteger(amount) && amount >= 1)
  const total = price * BigInt(qty)

  const ready = nowSec > 0 || (mintStart === 0n && mintEnd === 0n)
  const notStarted = mintStart > 0n && nowSec > 0 && BigInt(nowSec) < mintStart
  const windowClosed = mintEnd > 0n && nowSec > 0 && BigInt(nowSec) >= mintEnd
  const remaining = cap > 0n ? cap - minted : null
  const soldOut = remaining !== null && remaining <= 0n
  const alreadyMinted = !!desc.alreadyMintedFn && alreadyMintedRaw === true
  const mintable = ready && !notStarted && !windowClosed && !soldOut && !alreadyMinted

  const noun = desc.tokenNoun
  const pct = cap > 0n ? Math.min(100, Math.round((Number(minted) / Number(cap)) * 100)) : null

  const { dot, label } = mintable
    ? { dot: "bg-emerald-500 animate-pulse", label: "Live" }
    : notStarted
      ? { dot: "bg-amber-500", label: "Not open yet" }
      : soldOut
        ? { dot: "bg-gray-400", label: "Fully minted" }
        : alreadyMinted
          ? { dot: "bg-gray-400", label: "You hold one" }
          : { dot: "bg-gray-400", label: "Mint closed" }

  function handleMint() {
    if (!desc || !amountValid) return
    writeContract({
      address: desc.address,
      abi: desc.abi,
      functionName: desc.mintFn,
      args: desc.quantity ? [BigInt(qty)] : [],
      value: total,
    })
  }

  return (
    <section className="py-5 border-b border-gray-100">
      <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                {label}
              </span>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
              {cap > 0n ? `${Number(minted)} / ${Number(cap)} minted` : `${Number(minted)} minted`}
            </span>
          </div>

          {pct !== null && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
              <div className="h-full bg-fg transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}

          <div className="flex items-end justify-between gap-6">
            <div className="space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Price</p>
              <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
                {gasOnly ? (
                  <>
                    Gas only{" "}
                    <span className="text-sm font-mono text-gray-500">· you pay network gas</span>
                  </>
                ) : (
                  <>
                    {trimEth(formatEther(price))}{" "}
                    <span className="text-sm font-mono text-gray-500">ETH</span>
                  </>
                )}
              </p>
            </div>
            {mintEnd > 0n && !windowClosed && (
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
              message={`Minted. Your ${noun} is yours onchain.`}
              onDismiss={() => {
                reset()
                router.refresh()
              }}
            />
          )}

          {mintable && !(isSuccess && txHash) && (
            <>
              {desc.quantity && (
                <label className="block">
                  <span className="sr-only">Number to mint</span>
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
                      {amount === 1 ? noun : `${noun}s`}
                    </span>
                  </div>
                </label>
              )}

              {!gasOnly && (
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    You pay
                  </span>
                  <span className="text-sm font-mono tabular-nums">{trimEth(formatEther(total))} ETH</span>
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
                      : gasOnly
                        ? "Mint (gas only)"
                        : `Mint for ${trimEth(formatEther(total))} ETH`}
                </button>
              )}

              {writeError && (
                <p className="text-[11px] font-mono text-red-500 break-words">
                  {formatWriteError(writeError, "Mint")}
                </p>
              )}
            </>
          )}

          {!mintable && !(isSuccess && txHash) && ready && (
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              {notStarted
                ? "This mint hasn't opened yet."
                : soldOut
                  ? `Every ${noun} has been minted.`
                  : alreadyMinted
                    ? `You already hold a ${noun} from this collection (one per wallet).`
                    : "This mint is closed."}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
