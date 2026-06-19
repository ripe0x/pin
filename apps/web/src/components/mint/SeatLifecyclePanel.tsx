"use client"

/**
 * Per-piece seat lifecycle (Vouch). A seat is active for 30 days from its last
 * mint/renew/claim:
 *   - the holder can `renew()` for free while it's active (resets the clock),
 *   - once lapsed, anyone can `claim()` it at the mint price (takes the token,
 *     restarts the clock, re-rolls its position in the cube).
 *
 * Driven entirely by the collection descriptor's `lifecycle` fns, so it only
 * renders for collections that declare one. No-op for plain mints.
 */

import { useRouter } from "next/navigation"
import { formatEther } from "viem"
import {
  useAccount,
  useChainId,
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

function trimEth(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s
}

export function SeatLifecyclePanel({
  collectionId,
  tokenId,
  owner,
  active,
  expiresAt,
  freshnessBps,
  priceWei,
}: {
  collectionId: string
  tokenId: number
  owner: string | null
  active: boolean
  expiresAt: number
  freshnessBps: number
  priceWei: string
}) {
  const desc = resolveMintCollection(collectionId)
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const nowSec = useChainNowSec()
  const router = useRouter()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract()
  const { isLoading: isTxPending, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  const isPending = isWritePending || isTxPending

  const life = desc?.lifecycle
  if (!desc || !life) return null

  const price = BigInt(priceWei)
  const isOwner = !!address && !!owner && address.toLowerCase() === owner.toLowerCase()
  const freshnessPct = Math.max(0, Math.min(100, Math.round(freshnessBps / 100)))

  function handleRenew() {
    if (!desc || !life) return
    writeContract({
      address: desc.address,
      abi: desc.abi,
      functionName: life.renewFn,
      args: [BigInt(tokenId)],
    })
  }

  function handleClaim() {
    if (!desc || !life) return
    writeContract({
      address: desc.address,
      abi: desc.abi,
      functionName: life.claimFn,
      args: [BigInt(tokenId)],
      value: price,
    })
  }

  const dot = active ? "bg-emerald-500 animate-pulse" : "bg-gray-400"
  const statusLabel = active ? "Active seat" : "Lapsed seat"

  return (
    <section className="py-5 border-b border-gray-100">
      <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                {statusLabel}
              </span>
            </div>
            {active && expiresAt > 0 && (
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
                Expires in <Countdown endTime={BigInt(expiresAt)} nowSec={nowSec} />
              </span>
            )}
          </div>

          {active ? (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Freshness
                </span>
                <span className="text-[11px] font-mono tabular-nums text-gray-500">{freshnessPct}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                <div className="h-full bg-fg transition-all" style={{ width: `${freshnessPct}%` }} />
              </div>
            </div>
          ) : (
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              This seat has lapsed. Anyone can claim it at the mint price — claiming takes the
              token, restarts its 30-day clock, and re-rolls its position in the cube.
            </p>
          )}

          {isSuccess && txHash && (
            <TxSuccessBanner
              txHash={txHash}
              chainId={PREFERRED_CHAIN.id}
              message={active ? "Renewed. The clock is reset." : "Claimed. The seat is yours."}
              onDismiss={() => {
                reset()
                router.refresh()
              }}
            />
          )}

          {!(isSuccess && txHash) && (
            <>
              {!address ? (
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
              ) : active ? (
                isOwner ? (
                  <button
                    onClick={handleRenew}
                    disabled={isPending}
                    className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isWritePending ? "Confirm in wallet…" : isTxPending ? "Renewing…" : "Renew (free)"}
                  </button>
                ) : (
                  <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                    Held by {owner ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : "someone"}. Only the
                    holder can renew while it's active; if it lapses, anyone can claim it.
                  </p>
                )
              ) : (
                <button
                  onClick={handleClaim}
                  disabled={isPending}
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isWritePending
                    ? "Confirm in wallet…"
                    : isTxPending
                      ? "Claiming…"
                      : `Claim seat for ${trimEth(formatEther(price))} ETH`}
                </button>
              )}

              {writeError && (
                <p className="text-[11px] font-mono text-red-500 break-words">
                  {formatWriteError(writeError, active ? "Renew" : "Claim")}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
