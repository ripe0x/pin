"use client"

// The token detail page's quiet redeem affordance. Redeem burns a homage you
// hold to reclaim its escrowed $111, so it's only actionable by the token's
// owner — the link stays hidden for everyone else (disconnected, or a wallet
// that isn't the holder). The redeem page itself lists what you own; this is
// just the convenience jump-off.

import Link from "next/link"
import {type Address} from "viem"
import {useAccount} from "wagmi"

export function HomageRedeemLink({collection, owner}: {collection: Address; owner: Address | null}) {
  const {address} = useAccount()
  if (!owner || !address || address.toLowerCase() !== owner.toLowerCase()) return null
  return (
    <div className="mt-6">
      <Link
        href={`/collections/${collection}/redeem`}
        className="font-mono text-[11px] uppercase tracking-wider text-gray-400 hover:text-fg"
      >
        <span className="border-b border-gray-300 pb-0.5">Redeem this homage →</span>
      </Link>
    </div>
  )
}
