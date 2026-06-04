"use client"

/**
 * Phase 1 mint-funded permanence (docs/editions-permanence-funding.md): the
 * artist-facing view of the permanence vault's balance. A slice of every mint
 * routes to this artist-owned vault (it's a recipient in the edition's payout
 * split). This panel shows what's landed in the vault so far.
 *
 * RPC discipline: renders nothing — and reads nothing — unless the connected
 * wallet is the edition owner (the artist). So the public edition page triggers
 * ZERO chain reads from this component; only the artist viewing their own
 * edition fires a single `eth_getBalance`.
 *
 * Honest labeling: the native balance is what has been DISTRIBUTED out of the
 * 0xSplits payout split into the vault. Proceeds first accrue in the edition's
 * pull-payment balance, then in the split, until someone distributes them on
 * 0xSplits — so a freshly-minted edition can show 0 here while proceeds are
 * still upstream. The copy says so rather than implying the vault auto-fills.
 */

import { formatEther } from "viem"
import type { Address } from "viem"
import { useAccount, useBalance } from "wagmi"
import { evmNowAddressUrl, formatBps, shortAddress } from "@/lib/pnd-editions"

export function PermanenceVaultPanel({
  vault,
  bps,
  owner,
  chainId,
}: {
  vault: Address
  bps: number
  owner: Address
  chainId: number
}) {
  const { address } = useAccount()
  const isOwner = !!address && address.toLowerCase() === owner.toLowerCase()
  const { data: balance } = useBalance({
    address: vault,
    chainId,
    query: { enabled: isOwner },
  })

  if (!isOwner) return null

  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Permanence vault
      </h2>
      <div className="rounded-lg border border-gray-200 bg-surface p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            In vault now
          </span>
          <span className="text-lg font-mono font-medium tabular-nums">
            {balance ? formatEther(balance.value) : "—"}{" "}
            <span className="text-xs text-gray-500">ETH</span>
          </span>
        </div>
        <p className="text-[10px] font-mono text-gray-500 normal-case leading-relaxed">
          {formatBps(bps)} of every mint routes here. Proceeds first accrue in the
          payout split; distribute on 0xSplits to move them into the vault. This is
          a funding pot for keeping the work alive (a pay-once Arweave copy or
          renewable pinning), not permanence on its own.
        </p>
        <a
          href={evmNowAddressUrl(vault, chainId)}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
        >
          {shortAddress(vault)} ↗
        </a>
      </div>
    </section>
  )
}
