import Link from "next/link"
import { ConnectButton } from "./ConnectButton"
import { getArtistDisplayName } from "@/lib/artist"

/**
 * Top navbar — fixed-position single-row chrome matching the PND main app's
 * pattern. Wordmark on the left links home, wallet on the right. (Theme
 * toggle lives in the footer, mirroring the main site.)
 *
 * Server component so the wordmark resolves the artist's display name
 * (env var → ENS reverse → truncated address) on the server without a
 * client-side flash.
 */
export async function Navbar() {
  const displayName = await getArtistDisplayName()
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-surface border-b border-gray-200">
      <nav className="mx-auto flex h-16 max-w-[2000px] items-center justify-between px-6">
        <Link href="/" className="text-lg font-medium tracking-tight">
          {displayName}
        </Link>

        <div className="flex items-center gap-6">
          <ConnectButton />
        </div>
      </nav>
    </header>
  )
}
