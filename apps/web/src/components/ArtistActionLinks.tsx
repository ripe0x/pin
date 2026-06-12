"use client"

import Link from "next/link"
import { useAccount } from "wagmi"
import { PUBLIC_ARTIST_LINKS, studioToolHref } from "@/lib/studio-tools"

/**
 * The "For artists" menu contents. Rendered both in the desktop dropdown
 * and the mobile hamburger panel, so it lives in one place. The caller
 * supplies the `role="menu"` container; each item is a `menuitem`.
 * `onNavigate` closes the surrounding menu on click.
 *
 * Connected wallets lead with their own spaces — the studio (management)
 * and their public page — then everyone gets the public landing links.
 * Sourced from the studio-tools registry so the dropdown can't drift from
 * what the studio actually contains.
 */
export function ArtistActionLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { address } = useAccount()
  const item =
    "block px-4 py-2 text-xs font-mono text-fg transition-colors hover:bg-gray-100"

  return (
    <>
      {address ? (
        <>
          <Link
            href={studioToolHref(address)}
            role="menuitem"
            onClick={onNavigate}
            className={`${item} font-medium`}
          >
            Your studio
          </Link>
          <Link
            href={`/artist/${address.toLowerCase()}`}
            role="menuitem"
            onClick={onNavigate}
            className={`border-b border-gray-200 ${item} font-medium`}
          >
            Your page
          </Link>
        </>
      ) : (
        <Link
          href="/studio"
          role="menuitem"
          onClick={onNavigate}
          className={`border-b border-gray-200 ${item} font-medium`}
        >
          Studio
        </Link>
      )}
      {PUBLIC_ARTIST_LINKS.map((a) => (
        <Link
          key={a.href}
          href={a.href}
          role="menuitem"
          onClick={onNavigate}
          className={item}
        >
          {a.label}
        </Link>
      ))}
    </>
  )
}
