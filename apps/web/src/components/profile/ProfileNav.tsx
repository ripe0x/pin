import type { ProfileSummary } from "@/lib/profile-queries"

export function ProfileNav({ summary }: { summary: ProfileSummary }) {
  const links = [
    summary.availableTotal > 0 && ["available", "Available now"],
    summary.createdTotal > 0 && ["created", "Created"],
    summary.transferredTotal > 0 && ["archive", "Sold / transferred"],
    summary.heldTotal > 0 && ["collected", "Collected"],
    summary.declaredTotal > 0 && ["catalog", "Catalog"],
  ].filter(Boolean) as string[][]

  return (
    <nav
      aria-label="Profile sections"
      className="flex flex-wrap gap-x-4 gap-y-2 border-b border-gray-200 py-3 sm:flex-nowrap sm:overflow-x-auto"
    >
      {links.map(([id, label]) => (
        <a
          key={id}
          href={`#${id}`}
          className="shrink-0 font-mono text-[11px] text-gray-500 hover:text-fg"
        >
          {label}
        </a>
      ))}
    </nav>
  )
}
