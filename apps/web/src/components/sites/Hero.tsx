/**
 * Top hero block for the /sites landing page. Headline + subhead +
 * deploy buttons. No accompanying screenshot until we have real ones
 * to drop in (see apps/web/public/sites/README.md). Once captures
 * exist, restore the right column.
 */
import { DeployButtons } from "./DeployButtons"

export function Hero() {
  return (
    <section className="pt-12 pb-16 max-w-3xl">
      <div className="space-y-6">
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">
          Run your own auction page.
        </h1>
        <p className="text-base sm:text-lg text-fg-muted leading-relaxed">
          A free, self-hosted page that reads your Sovereign auction
          house contract directly. Every active auction, every settled
          sale, and live in-page bidding, on a domain you control.
        </p>
        <div className="space-y-2">
          <DeployButtons />
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-400 pt-2">
            Free to deploy · Two minutes · No backend
          </p>
        </div>
      </div>
    </section>
  )
}
