import Link from "next/link"
import type { ReactNode } from "react"

/**
 * Shared presentational frame for a token thumbnail: a bordered card with
 * the artwork on top and a tinted caption footer (mono title + optional
 * meta row) beneath, mirroring the auction panel's settlement block so the
 * title stays anchored to its artwork. Used by the artist gallery and the
 * token detail page's "More from" row.
 *
 * Media is delegated to `children` so each call site controls aspect/crop
 * and overlays (e.g. a platform chip). No client hooks here, so it renders
 * on either side of the server/client boundary.
 */
export function TokenCard({
  href,
  title,
  meta,
  children,
  isActive = false,
}: {
  href: string
  title: string
  meta?: ReactNode
  children: ReactNode
  isActive?: boolean
}) {
  const borderClass = isActive
    ? "border-fg group-hover:border-fg"
    : "border-gray-200 group-hover:border-gray-400"
  return (
    <Link
      href={href}
      className={`group block border transition-colors ${borderClass}`}
    >
      {children}
      <div className="px-3 py-2.5 bg-surface-muted border-t border-gray-100 space-y-1.5">
        <p className="text-[11px] font-mono text-fg tracking-tight truncate group-hover:underline underline-offset-2">
          {title}
        </p>
        {meta}
      </div>
    </Link>
  )
}
