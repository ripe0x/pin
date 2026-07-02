"use client"

/**
 * Homage's per-token lifecycle panel: redeem. Burning a homage returns the
 * full 50,000 $111 escrowed inside it and puts its punk id back in the
 * mintable pool; an ETH exit fee (owner-tunable) applies. Registered in
 * mint-slots.tsx under "homage-redeem" (the descriptor's `lifecyclePanel`).
 *
 * Mirrors the Homage site's redeem UX (web/app/redeem/page.tsx): a two-step
 * confirm whose consequence line spells out exactly what the burn does, the
 * LIVE `exitFee()` (read on mount via wagmi, and re-read at click time so the
 * tx sends the exact msg.value the contract requires — `redeem` reverts on
 * anything but equality), and an explicit success state. The wallet's OTHER
 * homages aren't listed here (that needs the Phase-4 indexer; enumerating
 * ownership from the chain would be a log scan) — this panel acts on the
 * token whose page it sits on.
 */

import { useState } from "react"
import Link from "next/link"
import { formatEther } from "viem"
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import {
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  TxSuccessBanner,
  formatWriteError,
} from "@/components/tx/tx-ui"
import { resolveMintCollection } from "@/lib/mint-collections"
import type { LifecyclePanelProps } from "./mint-slots"

function trimEth(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s
}

export function HomageRedeemPanel({ collectionId, tokenId, owner }: LifecyclePanelProps) {
  const desc = resolveMintCollection(collectionId)
  const { address } = useAccount()
  const chainId = useChainId()
  const client = usePublicClient()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const [confirming, setConfirming] = useState(false)
  const [feeError, setFeeError] = useState<string | null>(null)

  // Exit fee is owner-tunable → read it live (once on mount; wagmi caches it
  // for the session — no interval). Display only; the click handler re-reads.
  const { data: exitFeeRaw } = useReadContract({
    address: desc?.address,
    abi: desc?.abi,
    functionName: "exitFee",
    chainId: PREFERRED_CHAIN.id,
    query: { enabled: !!desc },
  })

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract()
  // receipt `error` = tx landed but reverted (wagmi throws on reverted
  // receipts) — surface it instead of sitting silent. retry: false because a
  // reverted receipt is terminal (same rationale as MintPanel).
  const {
    isLoading: isTxPending,
    isSuccess,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash: txHash, query: { retry: false } })
  const isPending = isWritePending || isTxPending

  if (!desc) return null

  const exitFee = typeof exitFeeRaw === "bigint" ? exitFeeRaw : null
  const isOwner = !!address && !!owner && address.toLowerCase() === owner.toLowerCase()

  async function handleRedeem() {
    if (!desc || !client || isPending) return
    setFeeError(null)
    // Re-read the live exit fee at click time: `redeem` requires msg.value to
    // EQUAL exitFee, so a fee change between mount and click must not brick
    // the tx with a stale value.
    let fee: bigint
    try {
      fee = (await client.readContract({
        address: desc.address,
        abi: desc.abi,
        functionName: "exitFee",
      })) as bigint
    } catch {
      setFeeError("Couldn't read the current exit fee. Try again.")
      return
    }
    writeContract({
      address: desc.address,
      abi: desc.abi,
      functionName: "redeem",
      args: [BigInt(tokenId)],
      value: fee,
    })
  }

  return (
    <section className="py-5 border-b border-gray-100">
      <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                Backed by 50,000 $111
              </span>
            </div>
            {exitFee !== null && (
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
                Exit fee: {trimEth(formatEther(exitFee))} ETH
              </span>
            )}
          </div>

          <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
            This homage escrows 50,000 $111. Its holder can redeem at any time: the token is
            burned, the coins are returned in full, and punk #{tokenId} goes back in the mintable
            pool. A small ETH exit fee applies.
          </p>

          {isSuccess && txHash ? (
            <>
              <TxSuccessBanner
                txHash={txHash}
                chainId={PREFERRED_CHAIN.id}
                message={`Redeemed. 50,000 $111 returned to your wallet; punk #${tokenId} is back in the pool.`}
                onDismiss={() => reset()}
              />
              {/* The token no longer exists — offer the way back, don't refresh
                  this page into a 404 under the success banner. */}
              <Link
                href={`/mint/${collectionId}`}
                className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
              >
                Back to the collection
              </Link>
            </>
          ) : !address ? (
            <ConnectButton.Custom>
              {({ openConnectModal }) => (
                <button
                  onClick={openConnectModal}
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
                >
                  Connect wallet
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
          ) : !isOwner ? (
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              Held by {owner ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : "someone else"}. Only
              the holder can redeem.
            </p>
          ) : !confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={isPending}
              className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 border border-fg text-fg hover:bg-fg hover:text-bg transition-colors disabled:opacity-40"
            >
              Redeem this homage
            </button>
          ) : (
            <div className="space-y-3 border border-gray-200 p-3">
              {/* Explicit consequence line — spell out exactly what redeeming
                  does before the tx (same copy contract as the Homage site). */}
              <p className="text-[11px] font-mono text-gray-600 leading-relaxed">
                Burns Homage #{tokenId}, returns 50,000 $111 to your wallet, and puts punk #
                {tokenId} back in the mintable pool.
              </p>
              {exitFee !== null && (
                <p className="text-[10px] font-mono text-gray-400 tabular-nums">
                  Exit fee: {trimEth(formatEther(exitFee))} ETH (sent with the transaction)
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleRedeem()}
                  disabled={isPending}
                  className="flex-1 text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isWritePending
                    ? "Confirm in wallet…"
                    : isTxPending
                      ? "Redeeming…"
                      : "Confirm redeem"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={isPending}
                  className="px-4 text-[11px] font-mono uppercase tracking-wider text-gray-400 border border-gray-200 hover:text-fg transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {(writeError || receiptError || feeError) && !isSuccess && (
            <p className="text-[11px] font-mono text-red-500 break-words">
              {feeError ?? formatWriteError(writeError ?? receiptError, "Redeem")}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
