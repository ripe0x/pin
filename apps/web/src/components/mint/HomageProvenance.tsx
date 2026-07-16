import { formatEthAmount } from "@/lib/format-eth"
import { shortAddress } from "@/lib/collection"
import type { HomageActivityEntry } from "@/lib/homage-queries"

/**
 * Per-token provenance timeline for an indexed mint collection, built from the
 * `homage_activity` rows (mint/claim/redeem/transfer, oldest-first). The churn
 * IS the story: a punkId can be minted, redeemed (coins pulled back out, id
 * returned to the pool), and re-minted, and that whole history reads here.
 *
 * Server component — takes already-fetched rows (the token page reads them
 * through lib/homage-queries.ts, which degrades to `[]` when the indexer tables
 * don't exist yet). Renders nothing on an empty list, so pre-deploy the section
 * simply doesn't appear.
 */

const K_111 = 1000n
function format111(raw: bigint | null): string | null {
  if (raw == null) return null
  // $111 is an 18-decimal ERC-20; escrow is 50,000 whole coins. Show whole
  // coins with thousands separators (the fractional dust isn't meaningful here).
  const whole = raw / 10n ** 18n
  return whole.toLocaleString("en-US")
}

function formatDate(unixSec: number): string | null {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return null
  return new Date(unixSec * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function phaseLabel(phase: string | null): string | null {
  switch (phase) {
    case "claim":
      return "Claim"
    case "allowlist":
      return "Allowlist"
    case "public":
      return "Public"
    default:
      return null
  }
}

type Line = { headline: string; sub?: string; party?: { addr: string | null } }

function describe(entry: HomageActivityEntry): Line {
  const eth = formatEthAmount // reserved for future ETH-denominated rows
  void eth
  switch (entry.type) {
    case "claim":
    case "mint": {
      const label = entry.type === "claim" ? "Claimed" : "Minted"
      const phase = phaseLabel(entry.mintPhase)
      const coins = format111(entry.received111)
      const sub = [phase ? `${phase} window` : null, coins ? `${coins} $111 escrowed` : null]
        .filter(Boolean)
        .join(" · ")
      return { headline: label, sub: sub || undefined, party: { addr: entry.to } }
    }
    case "redeem": {
      const coins = format111(entry.amount111)
      return {
        headline: "Redeemed",
        sub: coins ? `${coins} $111 returned · id back in the pool` : "id back in the pool",
        party: { addr: entry.from },
      }
    }
    case "transfer":
      return { headline: "Transferred", party: { addr: entry.to } }
    default:
      return { headline: entry.type }
  }
}

export function HomageProvenance({ entries }: { entries: HomageActivityEntry[] }) {
  if (entries.length === 0) return null

  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Provenance
      </h2>
      <ul className="space-y-0">
        {entries.map((entry, i) => {
          const line = describe(entry)
          const date = formatDate(entry.blockTime)
          const addr = line.party?.addr ?? null
          return (
            <li key={entry.txHash + i} className="flex gap-3 py-2">
              {/* Timeline dot + connecting line */}
              <div className="flex flex-col items-center pt-1.5">
                <div className="h-1.5 w-1.5 rounded-full bg-fg" />
                {i < entries.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-1" />}
              </div>

              <div className="flex-1 pb-1 space-y-0.5">
                <p className="text-[11px] font-mono">
                  <span className="font-medium">{line.headline}</span>
                  {addr && (
                    <>
                      <span className="text-gray-400"> by </span>
                      <a
                        href={`https://evm.now/address/${addr}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-500 hover:text-fg hover:underline"
                      >
                        {shortAddress(addr)}
                      </a>
                    </>
                  )}
                </p>
                {line.sub && <p className="text-[10px] font-mono text-gray-400">{line.sub}</p>}
                <a
                  href={`https://evm.now/tx/${entry.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-gray-400 hover:text-fg hover:underline transition-colors"
                >
                  {date ?? "Transaction ↗"}
                </a>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
