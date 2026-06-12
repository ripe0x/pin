"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { studioTools, studioToolHref } from "@/lib/studio-tools"

/**
 * Studio tool navigation, registry-driven. Desktop: vertical list in
 * the shell's left column (same border-l idiom as the guides index).
 * Mobile: a horizontally scrollable row above the content — non-sticky
 * on purpose, so it can't fight the fixed navbar + mobile search row.
 */
export function StudioNav({ address }: { address: string }) {
  const pathname = usePathname()
  const overviewHref = studioToolHref(address)

  const items = [
    { id: "", label: "Overview", href: overviewHref },
    ...studioTools().map((t) => ({
      id: t.id,
      label: t.label,
      href: studioToolHref(address, t.id),
    })),
  ]

  function isActive(href: string): boolean {
    if (href === overviewHref) return pathname === overviewHref
    return pathname === href || pathname.startsWith(`${href}/`)
  }

  return (
    <nav
      aria-label="Studio tools"
      className="flex md:flex-col gap-x-5 gap-y-2 overflow-x-auto md:overflow-visible whitespace-nowrap pb-2 md:pb-0 border-b border-gray-200 md:border-b-0"
    >
      {items.map((item) => {
        const active = isActive(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`text-[11px] font-mono font-medium uppercase tracking-wider transition-colors md:border-l-2 md:pl-3 py-0.5 ${
              active
                ? "text-fg md:border-fg"
                : "text-gray-500 hover:text-fg md:border-gray-200 md:hover:border-gray-400"
            }`}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
