"use client"

/**
 * Live collect button for a Mint protocol (mint.vv.xyz) edition.
 *
 * Mint editions are open for a fixed 24h window from creation. We derive the
 * close time off-chain as `mintTime + 24h` (mintTime = first-mint block time,
 * indexed by the worker) — no on-chain `mintOpenUntil` read. The contract still
 * enforces the true window, so a stale-edge attempt reverts with MintClosed,
 * surfaced by formatWriteError. Funds are never at risk.
 *
 * Price is dynamic: unitPrice = block.basefee * 60_000 (Mint.sol), with NO
 * refund of overpayment (excess goes to the artist). So we read the base fee
 * fresh at click time, send with a small buffer to clear basefee drift, and
 * disclose that overpayment tips the artist.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { formatEther } from "viem"
import {
  useAccount,
  useBalance,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { mintEditionAbi } from "@pin/abi"
import {
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  formatWriteError,
  Countdown,
  TxSuccessBanner,
} from "@/components/tx/tx-ui"

const MINT_WINDOW_SECS = 86_400 // 24h, fixed by Mint.sol (MINT_DURATION)
const BASEFEE_MULTIPLIER = 60_000n // unitPrice = block.basefee * 60_000
// Headroom over the estimated base-fee price so a basefee uptick between the
// estimate and inclusion doesn't trip `MintPriceNotMet`. Kept tight: there's no
// refund, so the buffer becomes a small tip to the artist.
const PRICE_BUFFER_NUM = 115n
const PRICE_BUFFER_DEN = 100n

/**
 * Reads one block on mount to anchor chain time AND capture the base fee for
 * the price estimate — folded into a single getBlock so the CTA costs exactly
 * one RPC read on mount (rather than pairing useChainNowSec with a second read
 * for the base fee). Ticks once a second for the countdown.
 */
function useMintClock(): { nowSec: number; baseFeePerGas: bigint | null } {
  const client = usePublicClient()
  const [offsetSec, setOffsetSec] = useState<number | null>(null)
  const [baseFeePerGas, setBaseFeePerGas] = useState<bigint | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!client) return
    let cancelled = false
    void client
      .getBlock()
      .then((block) => {
        if (cancelled) return
        setOffsetSec(Number(block.timestamp) - Math.floor(Date.now() / 1000))
        setBaseFeePerGas(block.baseFeePerGas ?? null)
      })
      .catch(() => {
        if (!cancelled) setOffsetSec(0)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return {
    nowSec: offsetSec === null ? 0 : Math.floor(Date.now() / 1000) + offsetSec,
    baseFeePerGas,
  }
}

export function MintEditionCTA({
  contract,
  tokenId,
  mintTime,
}: {
  contract: `0x${string}`
  tokenId: string
  /** Unix seconds of the first mint; window closes at mintTime + 24h. */
  mintTime: number
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const { nowSec, baseFeePerGas } = useMintClock()
  const closeAt = BigInt(mintTime + MINT_WINDOW_SECS)
  // Three states. While chain time is unknown (nowSec === 0, before the first
  // block read resolves) we are NOT "open" — showing the mint button + a price
  // estimate for what might be a long-closed edition is wrong. Stay in a
  // neutral "checking" state until we know, then resolve to open or closed.
  const ready = nowSec > 0
  const isClosed = ready && nowSec >= Number(closeAt)
  const isOpen = ready && nowSec < Number(closeAt)

  const [amount, setAmount] = useState(1)
  const amountValid = Number.isInteger(amount) && amount >= 1

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
  const { isLoading: isTxPending, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  const router = useRouter()
  const isPending = isWritePending || isTxPending

  // Estimated per-copy / total price from the mount-time base fee, for display.
  const unitPriceEst =
    baseFeePerGas != null ? baseFeePerGas * BASEFEE_MULTIPLIER : null
  const totalEst =
    unitPriceEst != null && amountValid ? unitPriceEst * BigInt(amount) : null

  async function handleMint() {
    if (!amountValid) return
    // Re-read the base fee fresh at click time so the value we send tracks the
    // current network fee as closely as possible (minimizing the no-refund
    // overpayment). Fall back to gas price, then the mount estimate.
    let unitPrice = unitPriceEst
    if (publicClient) {
      try {
        const block = await publicClient.getBlock()
        if (block.baseFeePerGas != null) {
          unitPrice = block.baseFeePerGas * BASEFEE_MULTIPLIER
        } else {
          const gasPrice = await publicClient.getGasPrice()
          unitPrice = gasPrice * BASEFEE_MULTIPLIER
        }
      } catch {
        // keep the mount estimate
      }
    }
    if (unitPrice == null) return
    const total = unitPrice * BigInt(amount)
    const value = (total * PRICE_BUFFER_NUM) / PRICE_BUFFER_DEN
    writeContract({
      address: contract,
      abi: mintEditionAbi,
      functionName: "mint",
      args: [BigInt(tokenId), BigInt(amount)],
      value,
    })
  }

  return (
    <section className="py-5 border-b border-gray-100">
      <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                !ready
                  ? "bg-gray-300"
                  : isClosed
                    ? "bg-gray-400"
                    : "bg-emerald-500 animate-pulse"
              }`}
            />
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
              {!ready ? "Checking mint status…" : isClosed ? "Mint closed" : "Open edition"}
            </span>
          </div>

          {isOpen && (
            <div className="flex items-end justify-between gap-6">
              <div className="space-y-1">
                <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Price
                </p>
                <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
                  {totalEst != null ? (
                    <>
                      ~{formatEther(totalEst)}{" "}
                      <span className="text-sm font-mono text-gray-500">ETH</span>
                    </>
                  ) : (
                    <span className="text-sm font-mono text-gray-500">
                      Estimating…
                    </span>
                  )}
                </p>
              </div>
              <div className="text-right space-y-1">
                <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Closes in
                </p>
                <p className="text-sm font-mono tabular-nums leading-none">
                  <Countdown endTime={closeAt} nowSec={nowSec} />
                </p>
              </div>
            </div>
          )}

          {isSuccess && txHash && (
            <TxSuccessBanner
              txHash={txHash}
              chainId={PREFERRED_CHAIN.id}
              message="Minted. The edition count updates shortly."
              onDismiss={() => {
                reset()
                router.refresh()
              }}
            />
          )}

          {isOpen && !(isSuccess && txHash) && (
            <>
              {/* Quantity */}
              <label className="block">
                <span className="sr-only">Number of copies to mint</span>
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
                    {amount === 1 ? "copy" : "copies"}
                  </span>
                </div>
              </label>

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
                  {isSwitchPending
                    ? "Switching…"
                    : `Wrong network — switch to ${PREFERRED_CHAIN_LABEL}`}
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
                      : "Mint"}
                </button>
              )}

              <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
                Price tracks the network base fee and can move. Any overpayment
                goes to the artist (no refund).
              </p>

              {writeError && (
                <p className="text-[11px] font-mono text-red-500 break-words">
                  {formatWriteError(writeError, "Mint")}
                </p>
              )}
            </>
          )}

          {isClosed && (
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              This edition&rsquo;s 24-hour mint window has closed.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
