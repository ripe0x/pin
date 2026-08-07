"use client"

import Link from "next/link"
import { useAccount } from "wagmi"
import type { Address } from "viem"

/**
 * The gallery's minted-by filter control. "Your tokens" links to
 * ?owner=<connected wallet> (a server-side SELECT does the filtering); a
 * clear link drops back to the full grid. Client-only because it reads the
 * connected wallet; the actual filter is server-rendered from the query
 * param. Labeled "minted by you" because the indexed address is the mint
 * recipient, not the live owner (see the gallery component).
 */
export function GalleryOwnerFilter({
  collection,
  activeOwner,
}: {
  collection: Address
  activeOwner: Address | null
}) {
  const { address } = useAccount()
  const base = `/collections/${collection}/gallery`
  const isMine = !!address && !!activeOwner && address.toLowerCase() === activeOwner.toLowerCase()

  return (
    <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono uppercase tracking-wider">
      {address && !isMine && (
        <Link
          href={`${base}?owner=${address}`}
          className="rounded-full border border-gray-200 px-3 py-1 text-gray-500 transition-colors hover:border-gray-300 hover:text-fg"
        >
          Minted by you
        </Link>
      )}
      {activeOwner && (
        <Link
          href={base}
          className="rounded-full border border-gray-200 px-3 py-1 text-gray-500 transition-colors hover:border-gray-300 hover:text-fg"
        >
          Clear filter
        </Link>
      )}
    </div>
  )
}
