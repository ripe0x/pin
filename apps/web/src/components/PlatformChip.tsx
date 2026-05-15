"use client"

/**
 * Tiny platform-attribution chip ("FND" / "SR" / "TL" / etc.) overlaid
 * on a card. Visible only when the god-mode "platformChips" debug flag
 * is on; everyone else gets a no-op.
 *
 * Lives as a client component so it can read localStorage without
 * forcing its parent to be one — drop it inside server-rendered cards
 * (HomeSquare's `WorkArtistCard`, the artist gallery card) without
 * any further plumbing.
 */

import { useDebugFlag } from "@/lib/useGodMode"
import type { PlatformId } from "@/lib/platforms/types"

const LABELS: Record<PlatformId, string> = {
  foundation: "FND",
  superrareV2: "SR",
  transient: "TL",
  manifold: "MAN",
  mint: "MINT",
  sovereign: "PND",
}

export function PlatformChip({ platform }: { platform?: PlatformId }) {
  const [enabled] = useDebugFlag("platformChips")
  if (!enabled || !platform) return null
  return (
    <span
      className="absolute top-2 right-2 z-10 rounded-full bg-fg/80 px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-bg backdrop-blur-sm pointer-events-none"
      title={`Source: ${platform}`}
    >
      {LABELS[platform]}
    </span>
  )
}
