"use client"

import Link from "next/link"
import { useIsStudioOwner } from "@/components/studio/useIsStudioOwner"
import { studioToolHref } from "@/lib/studio-tools"

/**
 * Owner-gated pointer from the public record to its management view.
 * Sits exactly where the edit UI used to render on /catalog/[address]
 * so artists with muscle memory land in the right place.
 */
export function ManageInStudioLink({ artist }: { artist: string }) {
  const isOwner = useIsStudioOwner(artist)
  if (!isOwner) return null
  return (
    <Link
      href={studioToolHref(artist, "catalog")}
      className="shrink-0 text-[11px] font-mono font-medium uppercase tracking-wider px-3 py-1.5 bg-fg text-bg hover:opacity-80 transition-colors"
    >
      Manage in studio →
    </Link>
  )
}
