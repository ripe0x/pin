import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { type Address } from "viem"
import { resolveEnsAddress } from "@/lib/artist-queries"
import { PLATFORMS } from "@/lib/platforms"
import type { CollectorTokenRef } from "@/lib/platforms"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

type Params = Promise<{ address: string }>

async function resolveParam(raw: string): Promise<string | null> {
  const decoded = decodeURIComponent(raw)
  if (ADDRESS_RE.test(decoded)) return decoded
  const resolved = await resolveEnsAddress(decoded)
  return resolved ?? null
}

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { address: raw } = await params
  return {
    title: `Collected by ${decodeURIComponent(raw)}`,
  }
}

/**
 * Collector page. Loops the platform registry — each adapter's
 * `discoverCollectorTokens(wallet)` returns the tokens this wallet owns
 * on that platform. The orchestrator unions and groups for display.
 *
 * Today: only Sovereign (PND) returns real data — auctions won by this
 * wallet. Foundation + Manifold collector adapters are stubs that
 * return [] until their scan implementations land in a follow-up. The
 * page renders empty groups for those platforms in the meantime.
 */
export default async function CollectorPage({
  params,
}: {
  params: Params
}) {
  const { address: raw } = await params
  const address = await resolveParam(raw)
  if (!address) redirect("/")

  const wallet = address.toLowerCase() as Address

  const perPlatform = await Promise.all(
    PLATFORMS.map(async (p) => ({
      id: p.id,
      displayName: p.displayName,
      tokens: p.discoverCollectorTokens
        ? await p.discoverCollectorTokens(wallet).catch(() => [])
        : ([] as CollectorTokenRef[]),
    })),
  )

  const totalTokens = perPlatform.reduce((n, p) => n + p.tokens.length, 0)

  return (
    <main className="px-6 py-10 lg:px-12 lg:py-14">
      <header className="mb-10">
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Collector
        </p>
        <h1 className="text-2xl font-mono font-medium mt-1 break-all">
          {address}
        </h1>
        <p className="text-xs font-mono text-gray-500 mt-2">
          {totalTokens} {totalTokens === 1 ? "token" : "tokens"} across{" "}
          {perPlatform.filter((p) => p.tokens.length > 0).length} platform
          {perPlatform.filter((p) => p.tokens.length > 0).length === 1
            ? ""
            : "s"}
        </p>
      </header>

      {perPlatform.map((p) =>
        p.tokens.length > 0 ? (
          <section key={p.id} className="mb-10">
            <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-4">
              {p.displayName} · {p.tokens.length}
            </h2>
            <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              {p.tokens.map((t) => (
                <li
                  key={`${t.contract.toLowerCase()}:${t.tokenId}`}
                  className="border border-gray-200"
                >
                  <Link
                    href={`/${t.contract}/${t.tokenId}`}
                    className="block p-3 hover:border-gray-400 transition-colors"
                  >
                    <p className="text-xs font-mono font-medium truncate">
                      #{t.tokenId}
                    </p>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500 truncate">
                      {t.contract.slice(0, 6)}…{t.contract.slice(-4)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}

      {totalTokens === 0 ? (
        <p className="text-sm text-gray-500">
          No tokens indexed yet for this wallet.
        </p>
      ) : null}
    </main>
  )
}
