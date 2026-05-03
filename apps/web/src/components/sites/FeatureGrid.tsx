/**
 * 2×3 grid of capability cards. Mirrors PND's existing feature-card
 * styling (border-only, no fill) — `text-[10px] font-mono uppercase` label
 * sitting under a status-colored dot, then a one-line description.
 *
 * Note on Foundation/SuperRare/Transient: the artist-page template
 * currently ships Sovereign-only support. The "All marketplaces" card
 * is honest about that — phrased as a roadmap rather than a present
 * promise. When Phase 2 ships, update the description.
 */
const features: Array<{
  label: string
  desc: string
  dot: string
}> = [
  {
    label: "Sovereign auction houses",
    desc: "Surfaces every active and past auction on your SovereignAuctionHouse — created here or anywhere else.",
    dot: "bg-status-live",
  },
  {
    label: "Live + past sales",
    desc: "Active auctions with countdown and bidding. Permanent record of every settled sale.",
    dot: "bg-status-sold",
  },
  {
    label: "Bidding in-page",
    desc: "Visitors connect their wallet and bid without leaving your site.",
    dot: "bg-status-available",
  },
  {
    label: "Link previews",
    desc: "Twitter, Farcaster, Discord, and iMessage all unfurl with the artwork and current price.",
    dot: "bg-status-upcoming",
  },
  {
    label: "ENS-native",
    desc: "Your name, avatar, bio, and social links all auto-resolve from your ENS profile. No setup.",
    dot: "bg-status-live",
  },
  {
    label: "Yours to edit",
    desc: "A regular Next.js codebase. Fork it, restyle it, host it anywhere.",
    dot: "bg-status-available",
  },
]

export function FeatureGrid() {
  return (
    <section className="py-16 border-t border-gray-200">
      <div className="space-y-12">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
            What you get
          </p>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-2">
            Everything that should be on an artist&apos;s page.
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-gray-200 border border-gray-200">
          {features.map((f) => (
            <div
              key={f.label}
              className="bg-bg p-6 space-y-3 min-h-[140px]"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${f.dot}`}
                  aria-hidden
                />
                <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                  {f.label}
                </span>
              </div>
              <p className="text-sm text-fg leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
