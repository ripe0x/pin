import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { MintPanel } from "@/components/mint/MintPanel"
import { CollectionStage } from "@/components/mint/CollectionStage"
import { AggregateStats } from "@/components/mint/AggregateStats"
import { SeatGrid } from "@/components/mint/SeatGrid"
import { RecentMints } from "@/components/mint/RecentMints"
import {
  getAggregateStats,
  getCollectionArt,
  getMintSnapshot,
  getSeatStates,
} from "@/lib/mint-onchain"
import { resolveMintCollection } from "@/lib/mint-collections"
import { evmNowAddressUrl, shortAddress } from "@/lib/pnd-editions"

type Params = Promise<{ contract: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { contract } = await params
  const desc = resolveMintCollection(contract)
  if (!desc) return { title: "Mint" }
  // Title/description come from the token's onchain metadata (tokenURI JSON)
  // when the hero carries the collection identity (Vouch's shared cube); the
  // descriptor is the fallback — and the only source when `identityFromHero`
  // is false (Homage: the hero is just a sample token whose own name would
  // mislabel the page). getCollectionArt is cached, so this shares the fetch
  // with the page render below.
  const art = await getCollectionArt(desc).catch(() => null)
  const heroIdentity = desc.identityFromHero !== false
  const name = (heroIdentity ? art?.name : null) ?? desc.name
  const description = (heroIdentity ? art?.description : null) ?? desc.description
  return {
    title: `Mint · ${name}`,
    description,
    openGraph: { title: name, description },
    twitter: { card: "summary_large_image", title: name },
  }
}

export default async function MintCollectionPage({ params }: { params: Params }) {
  const { contract } = await params
  const desc = resolveMintCollection(contract)
  if (!desc) notFound()

  const [snapshot, art, stats, seats] = await Promise.all([
    getMintSnapshot(desc),
    getCollectionArt(desc),
    getAggregateStats(desc),
    getSeatStates(desc),
  ])

  const heroAspect = desc.heroAspect ?? "1 / 1"
  // Prefer the onchain metadata (name/description from the tokenURI JSON) when
  // the hero carries the collection identity; otherwise (identityFromHero:
  // false — the hero is a sample token) the descriptor always names the page.
  const heroIdentity = desc.identityFromHero !== false
  const title = (heroIdentity ? art?.name : null) ?? desc.name
  const description = (heroIdentity ? art?.description : null) ?? desc.description

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        {/* Artwork: full-bleed, sticky on desktop. */}
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 dark:bg-bg p-6 lg:p-10">
          {art ? (
            <CollectionStage
              collectionId={contract}
              cubeImageUrl={art.imageUrl}
              cubeAnimationUrl={art.animationUrl}
              title={title}
              heroAspect={heroAspect}
              pieceAspect={desc.pieceAspect}
              aggregateLabel={desc.layout === "shared-aggregate" ? "Cube" : "Cover"}
            />
          ) : (
            <div className="text-[11px] font-mono text-gray-400">Artwork unavailable</div>
          )}
        </div>

        {/* Sidebar */}
        <aside className="lg:border-l border-gray-200 px-6 py-8 lg:px-8 lg:py-10">
          <nav className="mb-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <Link href="/" className="underline hover:text-fg">
              Home
            </Link>
          </nav>

          <header className="pb-5 border-b border-gray-100 space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
            {description && (
              <p className="text-[11px] font-mono text-gray-500 leading-relaxed">{description}</p>
            )}
          </header>

          {/* `seats` doubles as selector context (Vouch's chosen-seat picker)
              — the same getSeatStates read that feeds SeatGrid/RecentMints. */}
          <MintPanel collectionId={contract} snapshot={snapshot} selectorData={seats} />

          {stats && <AggregateStats stats={stats} />}

          <RecentMints seats={seats} collectionId={contract} tokenNoun={desc.tokenNoun} />

          <section className="py-5 border-b border-gray-100 space-y-2 text-[11px] font-mono">
            <Fact label="Contract" value={shortAddress(desc.address)} />
            <Fact label="Standard" value="ERC-721" />
            <Fact label="Art" value="Fully onchain" />
            <div className="pt-1">
              <a
                href={evmNowAddressUrl(desc.address, desc.chainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] uppercase tracking-wider text-gray-400 underline hover:text-fg"
              >
                View contract ↗
              </a>
            </div>
          </section>

          <SeatGrid seats={seats} collectionId={contract} tokenNoun={desc.tokenNoun} />
        </aside>
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
