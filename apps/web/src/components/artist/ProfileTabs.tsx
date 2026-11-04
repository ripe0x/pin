import Link from "next/link"
import {
  PROFILE_TAB_LABELS,
  formatTabCount,
  profileTabHref,
  type ProfileTab,
  type ProfileTabCounts,
} from "@/lib/profile-tabs"

/**
 * Tab bar for the unified profile (#299). Plain links (`?tab=`), so every
 * tab is a server render with a shareable URL and works without JS. Only
 * tabs with something to show are listed (lib/profile-tabs.ts).
 */
export function ProfileTabs({
  address,
  tabs,
  active,
  defaultTab,
  counts,
}: {
  address: string
  tabs: ProfileTab[]
  active: ProfileTab
  defaultTab: ProfileTab
  counts: ProfileTabCounts
}) {
  return (
    <nav
      aria-label="Profile sections"
      className="flex gap-x-6 overflow-x-auto whitespace-nowrap border-b border-gray-200"
    >
      {tabs.map((tab) => {
        const isActive = tab === active
        return (
          <Link
            key={tab}
            href={profileTabHref(address, tab, defaultTab)}
            scroll={false}
            aria-current={isActive ? "page" : undefined}
            className={`-mb-px inline-flex items-baseline gap-1.5 border-b-2 pb-2.5 text-[11px] font-mono font-medium uppercase tracking-wider transition-colors ${
              isActive
                ? "border-fg text-fg"
                : "border-transparent text-gray-500 hover:border-gray-300 hover:text-fg"
            }`}
          >
            {PROFILE_TAB_LABELS[tab]}
            <span className="tabular-nums text-gray-400">{formatTabCount(counts[tab])}</span>
          </Link>
        )
      })}
    </nav>
  )
}
