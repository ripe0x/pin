import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { getEditionProject, getEditionReleases } from "@/lib/editions-onchain"
import {
  evmNowAddressUrl,
  formatPriceLabel,
  PND_CHAIN_ID,
  RELEASE_KIND_LABEL,
  RELEASE_STATUS_LABEL,
  shortAddress,
} from "@/lib/pnd-editions"

type Params = Promise<{ project: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { project } = await params
  if (!isAddress(project)) return { title: "Project" }
  const p = await getEditionProject(project as Address)
  return { title: p ? p.name : "Project" }
}

export default async function ProjectPage({ params }: { params: Params }) {
  const { project } = await params
  if (!isAddress(project)) notFound()
  const addr = project as Address
  const p = await getEditionProject(addr)
  if (!p) notFound()
  const releases = await getEditionReleases(addr, p.totalReleases)

  const mutability = !p.isUpgradeable
    ? p.isSealed
      ? "Sealed"
      : "Immutable"
    : "Upgradeable"

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 md:py-14 space-y-8">
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-medium tracking-tight">{p.name}</h1>
          <span className="shrink-0 mt-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-gray-200 text-gray-600">
            {mutability}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono uppercase tracking-wider text-gray-400">
          <span>{p.symbol}</span>
          <a
            href={evmNowAddressUrl(addr, PND_CHAIN_ID)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-fg"
          >
            {shortAddress(addr)} ↗
          </a>
          <span className="tabular-nums">
            owner {shortAddress(p.owner)}
          </span>
          <span className="tabular-nums">{Number(p.totalSupply)} minted</span>
        </div>
      </header>

      {releases.length === 0 ? (
        <p className="text-sm text-fg-muted">This project has no releases yet.</p>
      ) : (
        <ul className="space-y-3">
          {releases.map((r) => (
            <li key={r.releaseId}>
              <Link
                href={`/editions/${addr}/${r.releaseId}`}
                className="flex gap-4 rounded-lg border border-gray-200 bg-surface p-3 hover:border-gray-300 transition-colors"
              >
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded bg-surface-muted">
                  <OptimizedImage
                    src={r.cfg.defaultArtworkURI}
                    alt={`Release ${r.releaseId}`}
                    width={200}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Release #{r.releaseId}</span>
                    <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                      {RELEASE_STATUS_LABEL[r.status]}
                    </span>
                  </div>
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    {RELEASE_KIND_LABEL[r.cfg.kind]} · {formatPriceLabel(r.cfg.price)}
                  </p>
                  <p className="text-[10px] font-mono text-gray-500 tabular-nums">
                    {r.cfg.supplyCap > 0n
                      ? `${Number(r.minted)} / ${Number(r.cfg.supplyCap)} minted`
                      : `${Number(r.minted)} minted · open`}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
