/**
 * 2x3 grid of capability cards describing what's actually shipped today.
 * Each card uses the existing PND status-dot + tiny mono caps label
 * pattern so it reads as part of the same visual family as the rest of
 * the app.
 */
const features: Array<{
  label: string
  desc: string
  dot: string
}> = [
  {
    label: "Sovereign auction house",
    desc: "Reads every auction on your house contract directly from the blockchain. Nothing to import, nothing to keep in sync.",
    dot: "bg-status-live",
  },
  {
    label: "Live bidding",
    desc: "Visitors connect their wallet and bid in-page. Current bid, time remaining, and bid history update on every block.",
    dot: "bg-status-available",
  },
  {
    label: "Settled sale archive",
    desc: "Every settled auction stays on the page as a permanent record with the final price and the winner.",
    dot: "bg-status-sold",
  },
  {
    label: "Link previews",
    desc: "Twitter, Farcaster, Discord, and iMessage all unfurl with the artwork and current price.",
    dot: "bg-status-upcoming",
  },
  {
    label: "ENS-native",
    desc: "Your name, avatar, bio, and social links auto-resolve from your ENS profile. No setup. Bidders surface as their ENS names too.",
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
