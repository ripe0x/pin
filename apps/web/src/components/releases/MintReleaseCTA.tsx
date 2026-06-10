"use client"

/**
 * The mint CTA for a release. Shows the honest two-line price (artist price
 * + the flat surface fee when this page serves the mint), the live window
 * state, and handles both open mints and gated claims (hold / burn).
 *
 * RPC discipline: no polling. One getBlock for chain time (useChainNowSec),
 * one approval read for burn gates, and the tx itself. Validation errors
 * (not source owner, source already used…) surface from the contract via
 * formatWriteError instead of preflight reads.
 */

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { erc721Abi, formatEther, type Address } from "viem"
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
import { releaseAbi } from "@pin/abi"
import {
  Countdown,
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  TxSuccessBanner,
  formatWriteError,
  useChainNowSec,
} from "@/components/tx/tx-ui"
import { formatEthAmount } from "@/lib/format-eth"
import {
  GateMode,
  RELEASE_STATUS_LABELS,
  ReleaseStatus,
  ZERO_ADDRESS,
  liveStatus,
  mintCost,
  releasesSurfaceAddress,
  shortAddress,
  type ReleaseSnapshot,
} from "@/lib/releases"

const BTN =
  "block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
const INPUT =
  "w-full px-3 py-2 text-xs font-mono bg-surface border border-gray-200 focus:border-gray-400 outline-none transition-colors disabled:opacity-40"

const STATUS_DOT: Record<ReleaseStatus, string> = {
  [ReleaseStatus.Scheduled]: "bg-amber-400",
  [ReleaseStatus.Live]: "bg-emerald-500 animate-pulse",
  [ReleaseStatus.SoldOut]: "bg-gray-400",
  [ReleaseStatus.Closed]: "bg-gray-400",
  [ReleaseStatus.Ended]: "bg-gray-400",
}

export function MintReleaseCTA({
  release,
  snapshot,
  initialStatus,
  surface,
}: {
  release: Address
  snapshot: ReleaseSnapshot
  initialStatus: ReleaseStatus
  /** Override for self-hosted pages; defaults to PND's surface env. */
  surface?: Address
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
  const router = useRouter()
  const nowSec = useChainNowSec()

  const [quantity, setQuantity] = useState(1)
  const [sourceIdsRaw, setSourceIdsRaw] = useState("")
  const [successHash, setSuccessHash] = useState<`0x${string}` | null>(null)

  const surfaceAddr = surface ?? releasesSurfaceAddress()
  const price = BigInt(snapshot.price)
  const fee = BigInt(snapshot.surfaceFee)
  const gated = snapshot.gateMode !== GateMode.None

  const sourceIds = useMemo(
    () =>
      sourceIdsRaw
        .split(/[\s,]+/)
        .filter((s) => s.length > 0 && /^\d+$/.test(s))
        .map((s) => BigInt(s)),
    [sourceIdsRaw],
  )
  const qty = gated ? BigInt(sourceIds.length) : BigInt(Math.max(quantity, 1))

  const status = nowSec > 0 ? liveStatus(snapshot, nowSec) : initialStatus
  const mintable = status === ReleaseStatus.Live

  const total = mintCost(price, fee, qty, surfaceAddr)
  const artistLeg = price * qty
  const feeLeg = total - artistLeg

  // Burn gates need this release approved as an operator on the gate.
  const approval = useReadContract({
    address: snapshot.gateToken,
    abi: erc721Abi,
    functionName: "isApprovedForAll",
    args: [address ?? ZERO_ADDRESS, release],
    chainId: PREFERRED_CHAIN.id,
    query: {
      enabled:
        !!address && snapshot.gateMode === GateMode.Burn && !wrongNetwork,
    },
  })
  const needsApproval =
    snapshot.gateMode === GateMode.Burn && approval.data === false

  const approve = useWriteContract()
  const { isLoading: approveMining, data: approveReceipt } =
    useWaitForTransactionReceipt({ hash: approve.data })
  useEffect(() => {
    if (approveReceipt) approval.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt])

  const mint = useWriteContract()
  const { isLoading: mintMining, data: mintReceipt } =
    useWaitForTransactionReceipt({ hash: mint.data })
  useEffect(() => {
    if (mintReceipt && mint.data) {
      setSuccessHash(mint.data)
      mint.reset()
      router.refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintReceipt])

  const { data: balance } = useBalance({
    address,
    chainId: PREFERRED_CHAIN.id,
    query: { enabled: !!address && !wrongNetwork },
  })
  const insufficient = !!balance && balance.value < total

  function doMint() {
    if (!address) return
    if (gated) {
      mint.writeContract({
        address: release,
        abi: releaseAbi,
        functionName: "mintGated",
        args: [address, sourceIds, surfaceAddr],
        value: total,
      })
    } else {
      mint.writeContract({
        address: release,
        abi: releaseAbi,
        functionName: "mint",
        args: [address, qty, surfaceAddr],
        value: total,
      })
    }
  }

  const busy = mint.isPending || mintMining || approve.isPending || approveMining

  const minted = BigInt(snapshot.totalMinted)
  const maxSupply = BigInt(snapshot.maxSupply)
  const endTime = BigInt(snapshot.endTime)

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-4">
      {/* Status line */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-gray-500">
          <span
            className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[status]}`}
          />
          {RELEASE_STATUS_LABELS[status]}
        </span>
        {status === ReleaseStatus.Live && endTime !== 0n && (
          <span className="text-[11px] font-mono text-gray-500">
            <Countdown endTime={endTime} nowSec={nowSec} />
          </span>
        )}
      </div>

      <div className="text-[11px] font-mono text-gray-500">
        {minted.toString()} minted
        {maxSupply !== 0n && ` of ${maxSupply.toString()}`}
        {status === ReleaseStatus.Scheduled &&
          ` · opens ${new Date(Number(snapshot.startTime) * 1000).toLocaleString()}`}
      </div>

      {/* Gated input */}
      {gated && (
        <div>
          <label
            className="block text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-1.5"
            htmlFor="claim-ids"
          >
            {snapshot.gateMode === GateMode.Hold
              ? "Token ids you hold"
              : "Token ids to burn"}
          </label>
          <input
            id="claim-ids"
            className={INPUT}
            value={sourceIdsRaw}
            onChange={(e) => setSourceIdsRaw(e.target.value)}
            placeholder="e.g. 12, 47"
            disabled={busy}
          />
          <p className="mt-1.5 text-[10px] font-mono text-gray-400 leading-relaxed">
            From {shortAddress(snapshot.gateToken)}.{" "}
            {snapshot.gateMode === GateMode.Hold
              ? "Each token mints once and stays yours."
              : "Each token is burned and mints one. Approve this release first."}
          </p>
        </div>
      )}

      {/* Quantity for open mints */}
      {!gated && (
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className={`${INPUT} w-24`}
            value={quantity}
            onChange={(e) =>
              setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))
            }
            aria-label="Quantity"
            disabled={busy}
          />
          <span className="text-[11px] font-mono text-gray-500">
            {quantity === 1 ? "token" : "tokens"}
          </span>
        </div>
      )}

      {/* The honest price block */}
      <div className="space-y-1 border-t border-gray-100 pt-3 text-[11px] font-mono">
        {price === 0n ? (
          <div className="text-gray-600">Free (gas only)</div>
        ) : (
          <>
            <div className="flex justify-between text-gray-600">
              <span>To the artist</span>
              <span>{formatEthAmount(artistLeg)} ETH</span>
            </div>
            {feeLeg > 0n && (
              <div className="flex justify-between text-gray-400">
                <span>To this surface (flat fee)</span>
                <span>{formatEthAmount(feeLeg)} ETH</span>
              </div>
            )}
            <div className="flex justify-between font-medium text-fg">
              <span>Total</span>
              <span>{formatEthAmount(total)} ETH</span>
            </div>
          </>
        )}
      </div>

      {/* Action */}
      {!address ? (
        <ConnectButton.Custom>
          {({ openConnectModal }) => (
            <button onClick={openConnectModal} className={BTN}>
              Connect wallet
            </button>
          )}
        </ConnectButton.Custom>
      ) : wrongNetwork ? (
        <button
          onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
          disabled={isSwitchPending}
          className={BTN}
        >
          {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
        </button>
      ) : needsApproval ? (
        <button
          onClick={() =>
            approve.writeContract({
              address: snapshot.gateToken,
              abi: erc721Abi,
              functionName: "setApprovalForAll",
              args: [release, true],
            })
          }
          disabled={busy || !mintable}
          className={BTN}
        >
          {approve.isPending
            ? "Confirm in wallet…"
            : approveMining
              ? "Approving…"
              : "Approve burn"}
        </button>
      ) : (
        <button
          onClick={doMint}
          disabled={
            busy ||
            !mintable ||
            insufficient ||
            (gated && sourceIds.length === 0)
          }
          className={BTN}
        >
          {mint.isPending
            ? "Confirm in wallet…"
            : mintMining
              ? "Minting…"
              : insufficient
                ? "Insufficient balance"
                : gated
                  ? snapshot.gateMode === GateMode.Burn
                    ? "Burn and mint"
                    : "Claim and mint"
                  : "Mint"}
        </button>
      )}

      {successHash && (
        <TxSuccessBanner
          txHash={successHash}
          chainId={1}
          message="Minted onchain."
          onDismiss={() => setSuccessHash(null)}
        />
      )}

      {(mint.error || approve.error) && (
        <p className="text-[11px] font-mono text-red-500 break-words">
          {formatWriteError(mint.error ?? approve.error, "Mint")}
        </p>
      )}
    </div>
  )
}
