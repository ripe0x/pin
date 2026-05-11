import type { CheckedCard as CheckedCardType } from "@/lib/dependency-check"
import { StatusBadge } from "./StatusBadge"

function explain(card: CheckedCardType): string {
  // Status-first: when the underlying check couldn't run, the per-card
  // `detail` is unpopulated (e.g. `{reason: "indexer-unavailable"}`), so
  // the per-id branches below would render misleading "zero records"
  // copy. Status copy wins for the unresolved states.
  if (card.status === "UnableToCheck") {
    if (card.source.includes("seller-listings")) {
      return "PND's cross-platform marketplace check timed out. Try again in a moment."
    }
    return "PND could not reach the indexer for this check. Try again in a moment."
  }
  const d = card.detail as Record<string, unknown>
  switch (card.id) {
    case "foundation-exposure": {
      const t = Number(d.tokenCount ?? 0)
      const c = Number(d.collectionCount ?? 0)
      if (t === 0 && c === 0)
        return "No Foundation tokens minted by this wallet were found in the indexer."
      return `${t} ${t === 1 ? "token" : "tokens"} minted on Foundation${
        c > 0
          ? ` across ${c} ${c === 1 ? "collection" : "collections"}`
          : ""
      }.`
    }
    case "active-fnd-listings": {
      const a = Number(d.auctions ?? 0)
      const b = Number(d.buyNows ?? 0)
      const t = a + b
      if (t === 0) return "No active Foundation auctions or buy-nows."
      return `${a} active ${a === 1 ? "auction" : "auctions"} and ${b} buy-${b === 1 ? "now" : "nows"} on Foundation.`
    }
    case "sovereign-house":
      return d.house
        ? "A Sovereign Auction House is owned by this wallet."
        : "No Sovereign Auction House was found for this wallet."
    case "active-pnd-auctions": {
      const n = Number(d.count ?? 0)
      return n > 0
        ? `${n} active ${n === 1 ? "auction" : "auctions"} on a Sovereign house.`
        : "No active Sovereign auctions."
    }
    case "delistable": {
      const a = Number(d.auctions ?? 0)
      const b = Number(d.buyNows ?? 0)
      const t = a + b
      if (t === 0)
        return "No cancellable listings found across supported marketplaces."
      return `${t} listing${t === 1 ? "" : "s"} across supported marketplaces can still be cancelled.`
    }
    case "sale-paths": {
      const labels = (d.marketplaceLabels as string[] | undefined) ?? []
      if (labels.length === 0)
        return "No marketplaces detected with active listings or settled sales."
      return `Active or historical activity on: ${labels.join(", ")}.`
    }
    case "pnd-page-presence":
      return d.hasArtistPage
        ? "This wallet has enough indexed activity for a PND artist page."
        : "Not enough indexed activity to generate a PND artist page yet."
    default:
      return ""
  }
}

export function CheckedCard({ card }: { card: CheckedCardType }) {
  const detail = explain(card)
  return (
    <div className="border border-gray-200 rounded-md p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-medium">{card.title}</h3>
        <StatusBadge status={card.status} />
      </div>
      {detail && <p className="text-sm text-gray-600">{detail}</p>}
      <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
        <div className="text-[11px] font-mono text-gray-400">
          source: {card.source}
        </div>
        {card.actions.length > 0 && (
          <div className="flex gap-2">
            {card.actions.map((a) => (
              <a
                key={a.href}
                href={a.href}
                className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
              >
                {a.label}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
