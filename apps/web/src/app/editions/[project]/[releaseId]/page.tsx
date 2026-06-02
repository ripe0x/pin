import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { MintReleaseCTA } from "@/components/editions/MintReleaseCTA"
import { ReleaseGraphView } from "@/components/editions/ReleaseGraphView"
import {
  getEditionEdges,
  getEditionProject,
  getEditionRelease,
} from "@/lib/editions-onchain"
import {
  ipfsToHttp,
  PND_CHAIN_ID,
  RELEASE_KIND_DESCRIPTION,
  RELEASE_KIND_LABEL,
  ZERO_ADDRESS,
  formatBps,
  shortAddress,
} from "@/lib/pnd-editions"

type Params = Promise<{ project: string; releaseId: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { project, releaseId } = await params
  if (!isAddress(project)) return { title: "Release" }
  const [p, r] = await Promise.all([
    getEditionProject(project as Address),
    getEditionRelease(project as Address, Number(releaseId)),
  ])
  const title = p ? `${p.name} — Release #${releaseId}` : `Release #${releaseId}`
  const image = r ? ipfsToHttp(r.cfg.defaultArtworkURI) : undefined
  return {
    title,
    openGraph: image ? { title, images: [{ url: image }] } : { title },
    twitter: { card: "summary_large_image", title },
  }
}

export default async function ReleasePage({ params }: { params: Params }) {
  const { project, releaseId: releaseIdStr } = await params
  if (!isAddress(project)) notFound()
  const addr = project as Address
  const releaseId = Number(releaseIdStr)
  if (!Number.isInteger(releaseId) || releaseId < 0) notFound()

  const [p, r, edges] = await Promise.all([
    getEditionProject(addr),
    getEditionRelease(addr, releaseId),
    getEditionEdges(addr, releaseId),
  ])
  if (!p || !r) notFound()

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:py-12">
      <nav className="mb-6 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        <Link href={`/editions/${addr}`} className="underline hover:text-fg">
          {p.name}
        </Link>{" "}
        / Release #{releaseId}
      </nav>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-10">
        {/* artwork */}
        <div className="md:sticky md:top-20 md:self-start">
          <div className="aspect-square w-full overflow-hidden rounded-lg border border-gray-200 bg-surface-muted">
            <OptimizedImage
              src={r.cfg.defaultArtworkURI}
              alt={`${p.name} Release #${releaseId}`}
              width={1200}
              loading="eager"
              className="h-full w-full object-contain"
            />
          </div>
        </div>

        {/* details + mint */}
        <div className="min-w-0">
          <header className="pb-5 border-b border-gray-100 space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">
              {p.name}
              <span className="text-gray-400"> · Release #{releaseId}</span>
            </h1>
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              {RELEASE_KIND_LABEL[r.cfg.kind]}
            </p>
            <p className="text-sm text-fg-muted leading-relaxed">
              {RELEASE_KIND_DESCRIPTION[r.cfg.kind]}
            </p>
          </header>

          <MintReleaseCTA
            project={addr}
            releaseId={releaseId}
            release={{
              price: r.cfg.price.toString(),
              surfaceShareBps: r.cfg.surfaceShareBps,
              supplyCap: r.cfg.supplyCap.toString(),
              mintStart: r.cfg.mintStart.toString(),
              mintEnd: r.cfg.mintEnd.toString(),
              minted: r.minted.toString(),
              status: r.status,
            }}
          />

          <ReleaseGraphView edges={edges} />

          {/* facts */}
          <section className="py-5 border-b border-gray-100 space-y-2 text-[11px] font-mono">
            <Fact label="Contract" value={shortAddress(addr)} />
            <Fact label="Standard" value="ERC721 (ERC721A)" />
            <Fact
              label="Royalty"
              value={r.cfg.royaltyBps > 0 ? formatBps(r.cfg.royaltyBps) : "none"}
            />
            <Fact
              label="Surface share"
              value={r.cfg.surfaceShareBps > 0 ? formatBps(r.cfg.surfaceShareBps) : "0% (artist keeps 100%)"}
            />
            <Fact
              label="Payout"
              value={
                r.cfg.payoutAddress === ZERO_ADDRESS
                  ? shortAddress(p.owner)
                  : shortAddress(r.cfg.payoutAddress)
              }
            />
          </section>

          {/* self host */}
          <section className="py-5">
            <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-2">
              Self host this mint
            </h2>
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              This release lives in your own contract and can be minted from any
              interface. From your own page, call{" "}
              <code className="text-fg">mint({releaseId}, qty, yourAddress, 0x)</code> on{" "}
              <code className="break-all text-fg">{addr}</code> so the Surface
              Share routes to you, not PND.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-gray-400 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="tabular-nums text-right">{value}</span>
    </div>
  )
}
