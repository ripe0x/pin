import type { Metadata } from "next"
import Link from "next/link"
import { getRecentReleases } from "@/lib/releases-onchain"
import {
  RELEASE_STATUS_LABELS,
  formatPriceLabel,
  releaseFactoryAddress,
  shortAddress,
} from "@/lib/releases"

export const metadata: Metadata = {
  title: "Releases",
  description:
    "Timed open editions from contracts artists own outright. The artist gets 100% of their price. Free means gas only. Mainnet only.",
}

export const revalidate = 3600

export default async function ReleasesHome() {
  const factory = releaseFactoryAddress()
  const recent = factory ? await getRecentReleases(factory, 8) : []

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 md:py-16 space-y-12">
      <header className="space-y-5">
        <h1 className="text-2xl md:text-3xl font-medium tracking-tight">
          Releases
        </h1>
        <p className="text-sm text-fg-muted leading-relaxed max-w-xl">
          Timed open editions from contracts you own outright. Open a mint
          window; whoever shows up decides the edition size. The artist gets
          100% of their price, always. Free means gas only. Later moves are
          native: gate a follow-on release on holding a token from a previous
          one, or burn one work to mint the next.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link
            href="/releases/new"
            className="text-[11px] font-mono font-medium uppercase tracking-wider px-5 py-3 bg-fg text-bg hover:opacity-80 transition-colors"
          >
            Open a release
          </Link>
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 pt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
          <li>Artist owned contracts</li>
          <li>Terms fixed in bytecode</li>
          <li>Timed windows</li>
          <li>Hold or burn to continue</li>
          <li>Self hostable</li>
        </ul>
      </header>

      {recent.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Recent releases
          </h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {recent.map((r) => (
              <li key={r.address}>
                <Link
                  href={`/releases/${r.address}`}
                  className="block rounded-lg border border-gray-200 bg-surface p-4 hover:border-gray-300 transition-colors"
                >
                  <p className="text-sm font-medium tracking-tight truncate">
                    {r.name}
                  </p>
                  <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    {r.symbol} · {shortAddress(r.address)}
                  </p>
                  <p className="mt-2 text-[10px] font-mono text-gray-500 tabular-nums">
                    {formatPriceLabel(BigInt(r.price))} · {r.totalMinted}{" "}
                    minted · {RELEASE_STATUS_LABELS[r.status]}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
