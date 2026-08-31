import type { Metadata } from "next"
import { Suspense } from "react"
import { ActivityFeed } from "@/components/home/v2/ActivityFeed"

export const metadata: Metadata = {
  title: "Activity | PND",
  description: "Recent release, mint, listing, bid, and sale activity observed by PND.",
}

export const dynamic = "force-dynamic"

export default function ActivityPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
      <header className="mb-8 max-w-2xl">
        <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          Public record
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          Recent releases, mints, listings, bids, and sales observed on Ethereum.
          Repeated actions are grouped so the work remains legible.
        </p>
      </header>
      <Suspense
        fallback={
          <p className="py-6 text-center font-mono text-xs italic text-gray-400">
            loading activity…
          </p>
        }
      >
        <ActivityFeed />
      </Suspense>
    </main>
  )
}
