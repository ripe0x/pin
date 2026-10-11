"use client"

// Redeem panel — burn a homage you hold to reclaim the THRESHOLD $111 escrowed inside
// it, paying the live exitFee. Self-contained (reads its own account + exit fee) so it
// can stand alone on the redeem page. Lists the connected wallet's outstanding homages
// from the indexer (`/api/mint/[contract]/owned/[wallet]`, keyed by the minter) and
// issues redeem(punkId) per row.

import {useEffect, useState} from "react"
import {formatEther, type Address} from "viem"
import {useAccount, useChainId, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract} from "wagmi"
import {ConnectButton} from "@rainbow-me/rainbowkit"
import {PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL, TxSuccessBanner, formatWriteError} from "@/components/tx/tx-ui"
import {homageFlows, homageMinterAbi} from "@/lib/homage/contracts"
import {formatLocalTime, formatTokenAmount, useHomageRedeemStatus} from "@/lib/homage/redeem-status"

const btn =
  "text-[10px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 border border-gray-300 text-fg hover:bg-surface-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"

type OwnedStatus = "idle" | "loading" | "ok" | "error"

// Outstanding homages held by `wallet`, read from the indexer. The route is keyed by the
// minter (the mint descriptor address), not the collection. `refreshKey` bumps after a
// redeem to refetch.
function useIndexedOwnedHomages(
  minter: Address,
  wallet: Address | undefined,
  refreshKey: number,
): {ids: number[]; status: OwnedStatus} {
  const [state, setState] = useState<{ids: number[]; status: OwnedStatus}>({ids: [], status: "idle"})

  useEffect(() => {
    if (!wallet) {
      setState({ids: [], status: "idle"})
      return
    }
    let cancelled = false
    setState((s) => ({...s, status: "loading"}))
    fetch(`/api/mint/${encodeURIComponent(minter)}/owned/${wallet}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`owned ${r.status}`))))
      .then((d: {homages?: Array<{punkId: number}>}) => {
        if (!cancelled) setState({ids: (d.homages ?? []).map((h) => h.punkId).sort((a, b) => a - b), status: "ok"})
      })
      .catch(() => {
        if (!cancelled) setState({ids: [], status: "error"})
      })
    return () => {
      cancelled = true
    }
  }, [minter, wallet, refreshKey])

  return state
}

export function HomageRedeem({minter}: {minter: Address}) {
  const {address} = useAccount()
  const chainId = useChainId()
  const {switchChain, isPending: isSwitchPending} = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const exitFeeRead = useReadContract({
    address: minter, abi: homageMinterAbi, functionName: "exitFee", chainId: PREFERRED_CHAIN.id,
  })
  const exitFee = (exitFeeRead.data as bigint | undefined) ?? 0n
  const {threshold, opensAt, isOpen, loading: statusLoading} = useHomageRedeemStatus(minter)

  const [refreshKey, setRefreshKey] = useState(0)
  const indexed = useIndexedOwnedHomages(minter, address, refreshKey)
  const flows = homageFlows(minter)

  const {writeContract, data: txHash, isPending: isWritePending, error: writeError, reset} = useWriteContract()
  const {isLoading: isTxPending, isSuccess} = useWaitForTransactionReceipt({hash: txHash})
  const isPending = isWritePending || isTxPending
  const [pendingId, setPendingId] = useState<number | null>(null)
  // Ids redeemed in this session. The indexer lags the redeem by a few blocks, so a
  // refetch right after success can still list the burned id; this hides it until the
  // indexer catches up.
  const [redeemedIds, setRedeemedIds] = useState<ReadonlySet<number>>(new Set())
  const ids = indexed.ids.filter((id) => !redeemedIds.has(id))
  const status = indexed.status

  useEffect(() => {
    if (isSuccess) {
      if (pendingId !== null) setRedeemedIds((s) => new Set(s).add(pendingId))
      setRefreshKey((k) => k + 1)
      setPendingId(null)
    }
  }, [isSuccess])

  return (
    <div className="space-y-4">
      <p className="text-[11px] font-mono text-gray-400 leading-relaxed">
        Redeeming burns the piece and returns the full{" "}
        {threshold !== null ? formatTokenAmount(threshold) : "…"} $111 escrowed inside it, and
        returns its punk id to the mint pool. Costs the {formatEther(exitFee)} ETH exit fee.
      </p>

      {!address ? (
        <ConnectButton.Custom>
          {({openConnectModal}) => (
            <button
              onClick={openConnectModal}
              className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
            >
              Connect wallet to redeem
            </button>
          )}
        </ConnectButton.Custom>
      ) : wrongNetwork ? (
        <button
          onClick={() => switchChain({chainId: PREFERRED_CHAIN.id})}
          disabled={isSwitchPending}
          className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40"
        >
          {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
        </button>
      ) : isSuccess && txHash ? (
        <TxSuccessBanner
          txHash={txHash}
          chainId={PREFERRED_CHAIN.id}
          message="Redeemed. The escrowed $111 is back in your wallet."
          onDismiss={() => reset()}
        />
      ) : !statusLoading && !isOpen ? (
        <p className="text-[11px] font-mono text-gray-400 leading-relaxed">
          Redeems open {opensAt !== null ? formatLocalTime(opensAt) : "soon"}, once public mint begins.
        </p>
      ) : status === "loading" ? (
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Finding your homages…</p>
      ) : status === "error" ? (
        <p className="text-[11px] font-mono text-status-sold">Couldn’t load your homages. Reload to try again.</p>
      ) : ids.length === 0 ? (
        <p className="text-[11px] font-mono text-gray-400">You don’t hold any homages to redeem.</p>
      ) : (
        <ul className="space-y-2">
          {ids.map((id) => (
            <li
              key={id}
              className="flex items-center justify-between gap-3 rounded border border-gray-200 bg-surface-muted/40 px-3 py-2"
            >
              <span className="text-[11px] font-mono text-fg">Punk {id}</span>
              <button
                onClick={() => {
                  setPendingId(id)
                  writeContract({...flows.redeem(BigInt(id), exitFee), chainId: PREFERRED_CHAIN.id})
                }}
                disabled={isPending}
                className={btn}
              >
                {isPending && pendingId === id ? "Redeeming…" : "Redeem"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {writeError && <p className="text-[10px] font-mono text-status-sold leading-relaxed">{formatWriteError(writeError, "redeem")}</p>}
    </div>
  )
}
