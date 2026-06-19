import type { AggregateStats as Stats } from "@/lib/mint-onchain"

/**
 * Shared-aggregate stat block (Vouch cube). The cube's image is driven by these
 * live aggregates; we surface them as plain numbers next to the artwork.
 */
export function AggregateStats({ stats }: { stats: Stats }) {
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`
  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-3">
        Live state
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[11px] font-mono">
        <Stat label="Active seats" value={String(stats.activeCount)} />
        <Stat label="Trust" value={pct(stats.trustBps)} />
        <Stat label="Coherence" value={pct(stats.coherenceBps)} />
        <Stat
          label="Form"
          value={stats.maintained ? "Holding" : "Below threshold"}
          muted={!stats.maintained}
        />
      </dl>
      <p className="mt-3 text-[10px] font-mono text-gray-400 leading-relaxed">
        The cube above is composed live from every active seat. Trust is the average
        freshness across minted seats; let it fall below {pct(stats.thresholdBps)} and the
        form dims.
      </p>
    </section>
  )
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="space-y-1">
      <dt className="text-[10px] uppercase tracking-wider text-gray-400">{label}</dt>
      <dd className={`tabular-nums text-sm ${muted ? "text-gray-400" : "text-fg"}`}>{value}</dd>
    </div>
  )
}
