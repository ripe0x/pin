"use client"

import Link from "next/link"
import { useAccount } from "wagmi"

type ArtistAction = { href: string; label: string }

const ARTIST_ACTIONS: ArtistAction[] = [
  { href: "/preserve", label: "Preserve work" },
  { href: "/delist", label: "Leave platforms" },
  { href: "/auction/new", label: "Deploy your auction" },
  { href: "/sites", label: "Run your own site" },
]

/**
 * The "For artists" link list. Rendered both in the desktop dropdown and the
 * mobile hamburger panel, so it lives in one place. The caller supplies the
 * `role="menu"` container; each item is a `menuitem`. `onNavigate` closes the
 * surrounding menu on click.
 */
export function ArtistActionLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { address } = useAccount()
  const item =
    "block px-4 py-2 text-xs font-mono text-fg transition-colors hover:bg-gray-100"

  return (
    <>
      {ARTIST_ACTIONS.map((a) => (
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
      {address && (
        <>
          <Link
            href={`/artist/${address}`}
            role="menuitem"
            onClick={onNavigate}
            className={`border-t border-gray-200 ${item}`}
          >
            Manage your work
          </Link>
          <Link
            href={`/catalog/${address}`}
            role="menuitem"
            onClick={onNavigate}
            className={item}
          >
            Your catalog
          </Link>
        </>
      )}
      <Link
        href="/guides"
        role="menuitem"
        onClick={onNavigate}
        className={`border-t border-gray-200 ${item}`}
      >
        Guides
      </Link>
    </>
  )
}
