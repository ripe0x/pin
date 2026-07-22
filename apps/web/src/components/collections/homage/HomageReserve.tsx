"use client"

// Pre-claim reservation panel — a punk owner withholds their punk id from the random
// draw pool (reserve*) so it's guaranteed available to claim once the claim window
// opens, instead of risking someone else's random mint landing on it. Unclaimed
// reservations release back into the public pool at public start.
//
// Two routes, mirroring HomageMinter: direct `reserveMine([id])` for a punk you hold
// (raw or wrapped), `reserveVia([id], vault)` for one you access via delegate.xyz.

import {useEffect, useState} from "react"
import {type Address} from "viem"
import {
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import {ConnectButton} from "@rainbow-me/rainbowkit"
import {PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL, formatWriteError} from "@/components/tx/tx-ui"
import {homageFlows, homageMinterAbi} from "@/lib/homage/contracts"
import {useOwnedPunks} from "@/lib/homage/punks"

export function HomageReserve({minter}: {minter: Address}) {
  const {address} = useAccount()
  const chainId = useChainId()
  const {switchChain, isPending: isSwitchPending} = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const [refreshKey, setRefreshKey] = useState(0)
  const {punks, status} = useOwnedPunks(minter, address, refreshKey)
  const flows = homageFlows(minter)

  const ids = punks.map((p) => p.id)
  const reservedReads = useReadContracts({
    contracts: ids.map((id) => ({address: minter, abi: homageMinterAbi, functionName: "isReserved", args: [BigInt(id)]}) as const),
    query: {enabled: ids.length > 0, staleTime: 30_000},
  })
  const reservedById = new Map<number, boolean>()
  ids.forEach((id, i) => {
    const r = reservedReads.data?.[i]
    reservedById.set(id, r?.status === "success" && r.result === true)
  })

  const reservedRemainingRead = useReadContract({
    address: minter, abi: homageMinterAbi, functionName: "reservedRemaining", chainId: PREFERRED_CHAIN.id,
    query: {staleTime: 30_000},
  })
  const reservedRemaining = reservedRemainingRead.data !== undefined ? Number(reservedRemainingRead.data as bigint) : undefined

  const {writeContract, data: txHash, isPending: isWritePending, error: writeError, reset} = useWriteContract()
  const {isLoading: isTxPending, isSuccess} = useWaitForTransactionReceipt({hash: txHash})
  const isPending = isWritePending || isTxPending
  const [pendingId, setPendingId] = useState<number | null>(null)

  useEffect(() => {
    if (isSuccess) {
      setRefreshKey((k) => k + 1)
      void reservedReads.refetch()
      void reservedRemainingRead.refetch()
      setPendingId(null)
      reset()
    }
    // reservedReads / reservedRemainingRead intentionally omitted — refetch functions
    // are stable per wagmi's contract, and including the whole query objects would
    // re-run this on every poll tick, not just on tx success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess, reset])

  function doReserve(id: number, vault?: Address) {
    setPendingId(id)
    const bid = BigInt(id)
    const args = vault ? flows.reserveVia([bid], vault) : flows.reserveMine([bid])
    // reserveMine / reserveVia are a union of write configs; wagmi's writeContract param
    // can't unify the union (same issue as HomageClaim's onClaim), so cast through unknown.
    writeContract({...args, chainId: PREFERRED_CHAIN.id} as unknown as Parameters<typeof writeContract>[0])
  }

  return (
    <div className="space-y-3">
      {!address ? (
        <div className="space-y-3">
          <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
            Punk owners can reserve their punk&apos;s homage before the punk mint claim opens,
            withholding it from the random draw pool. Connect to see which of your
            punks are available to reserve.
          </p>
          <ConnectButton.Custom>
            {({openConnectModal}) => (
              <button
                onClick={openConnectModal}
                className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
              >
                Connect wallet to reserve
              </button>
            )}
          </ConnectButton.Custom>
        </div>
      ) : wrongNetwork ? (
        <button
          onClick={() => switchChain({chainId: PREFERRED_CHAIN.id})}
          disabled={isSwitchPending}
          className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40"
        >
          {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
        </button>
      ) : (
        <>
          {status === "loading" && <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Finding your punks…</p>}

          {punks.length > 0 && (
            <ul className="space-y-2">
              {punks.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 rounded border border-gray-200 bg-surface-muted/40 px-3 py-2">
                  <span className="text-[11px] font-mono text-fg">
                    Punk {p.id}
                    {p.wrapped && <span className="text-gray-400"> · wrapped</span>}
                    {p.vault && <span className="text-gray-400"> · via vault {p.vault.slice(0, 6)}…</span>}
                  </span>
                  {reservedById.get(p.id) ? (
                    <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Reserved ✓</span>
                  ) : (
                    <button
                      onClick={() => doReserve(p.id, p.vault)}
                      disabled={isPending}
                      className="text-[10px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isPending && pendingId === p.id ? "…" : "Reserve"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {punks.length === 0 && status !== "loading" && (
            <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
              No punks found for this wallet{status === "partial" ? " in the recent window" : ""}.
            </p>
          )}
        </>
      )}

      {writeError && <p className="text-[10px] font-mono text-status-sold leading-relaxed">{formatWriteError(writeError, "reserve")}</p>}

      <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
        Reserving withholds your punk’s homage from the random draw. It stays yours to claim until public mint opens
        Wednesday. Unclaimed reservations return to the public pool then.
      </p>

      {reservedRemaining !== undefined && reservedRemaining > 0 && (
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
          {reservedRemaining} reserved for owners
        </p>
      )}
    </div>
  )
}
