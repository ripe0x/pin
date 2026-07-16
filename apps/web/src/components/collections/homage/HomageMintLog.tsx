"use client"

// Proof that mints ARE reconstructable from onchain data: scans recent
// Transfer(from=0x0) events straight off the collection contract and lists
// them. Mirrors the enumeration pattern in lib/homage/punks.ts
// (useOwnedHomages) — same client, same fromBlock-windowed getContractEvents
// call, just filtered on `from` instead of `to`.

import {useEffect, useState} from "react"
import {usePublicClient} from "wagmi"
import {PREFERRED_CHAIN, evmNowTxUrl} from "@/components/tx/tx-ui"
import {evmNowAddressUrl, shortAddress} from "@/lib/collection"
import {homageCollectionAbi} from "@/lib/homage/contracts"

const SCAN_WINDOW = 300_000n
const MAX_ROWS = 12
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

type MintEntry = {tokenId: number; to: string; txHash: `0x${string}`}
type Status = "idle" | "loading" | "ok" | "error"

function useRecentMints(collection: `0x${string}`): {mints: MintEntry[]; status: Status} {
  const client = usePublicClient({chainId: PREFERRED_CHAIN.id})
  const [state, setState] = useState<{mints: MintEntry[]; status: Status}>({mints: [], status: "idle"})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!client) {
        setState({mints: [], status: "idle"})
        return
      }
      setState((s) => ({...s, status: "loading"}))
      try {
        const latest = await client.getBlockNumber()
        const fromBlock = latest > SCAN_WINDOW ? latest - SCAN_WINDOW : 0n
        const logs = await client.getContractEvents({
          address: collection,
          abi: homageCollectionAbi,
          eventName: "Transfer",
          args: {from: ZERO_ADDRESS},
          fromBlock,
          toBlock: "latest",
        })
        if (cancelled) return
        const byTokenId = new Map<number, MintEntry>()
        for (const l of logs) {
          const tokenId = (l.args as {tokenId?: bigint}).tokenId
          const to = (l.args as {to?: string}).to
          if (tokenId === undefined || to === undefined || !l.transactionHash) continue
          byTokenId.set(Number(tokenId), {tokenId: Number(tokenId), to, txHash: l.transactionHash})
        }
        const mints = Array.from(byTokenId.values())
          .sort((a, b) => b.tokenId - a.tokenId)
          .slice(0, MAX_ROWS)
        setState({mints, status: "ok"})
      } catch {
        if (!cancelled) setState({mints: [], status: "error"})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, collection])

  return state
}

export function HomageMintLog({collection, chainId}: {collection: `0x${string}`; chainId: number}) {
  const {mints, status} = useRecentMints(collection)

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Mint history</p>
      {status === "loading" && <p className="font-mono text-[10px] text-gray-400">…</p>}
      {status !== "loading" && mints.length === 0 && (
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">No mints yet.</p>
      )}
      {mints.length > 0 && (
        <ul className="flex flex-col gap-1">
          {mints.map((m) => (
            <li key={m.tokenId} className="flex items-center justify-between gap-4 font-mono text-[11px] text-gray-500">
              <span className="text-fg">Punk #{m.tokenId}</span>
              <span className="flex items-center gap-2">
                <a
                  href={evmNowAddressUrl(m.to, chainId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg"
                >
                  {shortAddress(m.to)}
                </a>
                <a
                  href={evmNowTxUrl(m.txHash, chainId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg"
                >
                  tx ↗
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
