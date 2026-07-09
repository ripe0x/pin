import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { MintCollectionCTA } from "@/components/collections/MintCollectionCTA"
import { WithdrawPanel } from "@/components/collections/WithdrawPanel"
import { CollectionMintHistory } from "@/components/collections/CollectionMintHistory"
import { AttributionRoster } from "@/components/collections/AttributionRoster"
import { GenerativeHero, RecentMintsGrid } from "@/components/collections/GenerativeViews"
import {
  getAttribution,
  getCollection,
  getCollectionMintHistory,
  getCollectionToken,
  getRecentTokenMarks,
} from "@/lib/collection-onchain"
import {
  COLLECTION_KIND_LABEL,
  PND_CHAIN_ID,
  REFERRAL_SHARE_BPS,
  ZERO_ADDRESS,
  evmNowAddressUrl,
  formatBps,
  hasPriceStrategy,
  ipfsToHttp,
  sellsViaMinterOnly,
  shortAddress,
} from "@/lib/sovereign-collection"

// TODO: Collection Graph (edges) is not yet exposed by the data layer —
// lib/collection-onchain.ts has no getCollectionEdges export (unlike
// lib/editions-onchain.ts's getEditionEdges). Skipping the graph view for
// v1; add it back once the data layer grows that read.

type Params = Promise<{ address: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address } = await params
  if (!isAddress(address)) return { title: "Collection" }
  const c = await getCollection(address as Address)
  if (!c) return { title: "Collection" }
  const image = ipfsToHttp(c.cfg.artworkURI)
  return {
    title: c.name,
    openGraph: image ? { title: c.name, images: [{ url: image }] } : { title: c.name },
    twitter: { card: "summary_large_image", title: c.name },
  }
}

export default async function CollectionPage({ params }: { params: Params }) {
  const { address } = await params
  if (!isAddress(address)) notFound()
  const addr = address as Address
  const c = await getCollection(addr)
  if (!c) notFound()
  const [history, attribution, recent] = await Promise.all([
    getCollectionMintHistory(addr, c.minted, c.cfg.idMode),
    getAttribution(addr),
    getRecentTokenMarks(addr, c.minted, c.cfg.idMode),
  ])

  // Hero cascade: the artist's explicit cover always wins; a coverless
  // generative work shows a live render (latest mint's real seed, or a
  // deterministic preview seed pre-mint); a coverless renderer-native work
  // falls back to its first token's image once one exists.
  const hasCover = c.cfg.artworkURI.length > 0
  const hasWork = c.work.code.length > 0
  const latest = recent[0] ?? null
  const firstTokenImage =
    !hasCover && !hasWork && c.minted > 0n
      ? (await getCollectionToken(addr, 1n))?.image ?? ""
      : ""

  // The contract itself is an immutable clone (no upgrade path, ever); what
  // the artist can still change pre-lock is the work definition and renderer.
  const mutability = c.isWorkLocked ? "Work locked" : "Work editable by the artist"
  const metadataState = c.isMetadataFrozen ? "Frozen" : "Mutable by the artist"
  const permanent = c.isPermanent
  const pooled = sellsViaMinterOnly(c.cfg.idMode)
  const strategy = hasPriceStrategy(c.priceStrategy)

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        {/* Artwork: full-bleed gray field, sticky on desktop. */}
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 dark:bg-bg p-8 lg:p-12">
          {hasCover ? (
            <OptimizedImage
              src={c.cfg.artworkURI}
              alt={c.name}
              width={1200}
              loading="eager"
              className="max-h-[78vh] max-w-full object-contain"
            />
          ) : hasWork ? (
            <GenerativeHero collection={addr} work={c.work} latest={latest} />
          ) : firstTokenImage ? (
            <OptimizedImage
              src={firstTokenImage}
              alt={`${c.name} #1`}
              width={1200}
              loading="eager"
              className="max-h-[78vh] max-w-full object-contain"
            />
          ) : (
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              No artwork yet
            </p>
          )}
        </div>

        {/* Sidebar */}
        <aside className="lg:border-l border-gray-200 px-6 py-8 lg:px-8 lg:py-10">
          <nav className="mb-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <Link href="/collections" className="underline hover:text-fg">
              Collections
            </Link>
          </nav>

          <header className="pb-5 border-b border-gray-100 space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{c.name}</h1>
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              {c.symbol} · {COLLECTION_KIND_LABEL[c.cfg.kind]}
            </p>
          </header>

          <MintCollectionCTA
            collection={addr}
            snapshot={{
              price: c.cfg.price.toString(),
              supplyCap: c.cfg.supplyCap.toString(),
              mintStart: c.cfg.mintStart.toString(),
              mintEnd: c.cfg.mintEnd.toString(),
              minted: c.minted.toString(),
              status: c.status,
              priceStrategy: c.priceStrategy,
              idMode: c.cfg.idMode,
            }}
          />

          <AttributionRoster entries={attribution} chainId={PND_CHAIN_ID} />

          <WithdrawPanel collection={addr} />

          <CollectionMintHistory history={history} chainId={PND_CHAIN_ID} />

          <section className="py-5 border-b border-gray-100 space-y-2 text-[11px] font-mono">
            <Fact label="Contract" value={shortAddress(addr)} />
            <Fact label="Standard" value="ERC721" />
            <Fact label="Owner" value={shortAddress(c.owner)} />
            <Fact label="Mutability" value={mutability} />
            <Fact label="Metadata" value={metadataState} />
            <Fact label="Permanence" value={permanent ? "Permanent" : "Not yet permanent"} />
            <Fact
              label="Royalty"
              value={c.cfg.royaltyBps > 0 ? formatBps(c.cfg.royaltyBps) : "none"}
            />
            <Fact
              label="Referral share"
              value={`${formatBps(REFERRAL_SHARE_BPS)} (to the referrer)`}
            />
            <Fact label="Pricing" value={strategy ? "Live strategy" : "Fixed"} />
            <Fact label="Sale mode" value={pooled ? "Pooled (via minter)" : "Sequential"} />
            <Fact
              label="Payout"
              value={
                c.cfg.payoutAddress === ZERO_ADDRESS
                  ? shortAddress(c.owner)
                  : shortAddress(c.cfg.payoutAddress)
              }
            />
            <div className="pt-1">
              <a
                href={evmNowAddressUrl(addr, PND_CHAIN_ID)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] uppercase tracking-wider text-gray-400 underline hover:text-fg"
              >
                View contract ↗
              </a>
            </div>
            {permanent ? (
              <p className="pt-2 text-[10px] font-mono text-gray-400 normal-case leading-relaxed">
                Permanent: the work is locked and metadata is frozen, so the
                artwork and code cannot change. The contract itself has no
                upgrade path from deploy.
              </p>
            ) : (
              <p className="pt-2 text-[10px] font-mono text-gray-400 normal-case leading-relaxed">
                The contract is immutable from deploy.{" "}
                {!c.isWorkLocked ? "The artist can edit the work definition until they lock it. " : ""}
                {!c.isMetadataFrozen ? "Artwork and renderer can change until the artist freezes metadata." : ""}
              </p>
            )}
          </section>

          <section className="pt-5">
            <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-2">
              Self host this mint
            </h2>
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              This collection is your own contract and can be minted from any
              interface. From your own page, call{" "}
              <code className="text-fg">mintWithReferral(qty, yourAddress, 0x)</code> on{" "}
              <code className="break-all text-fg">{addr}</code> so the{" "}
              {formatBps(REFERRAL_SHARE_BPS)} referral share routes to you, not PND.
            </p>
          </section>
        </aside>
      </div>

      {/* Recent mints: live renders from real seeds via the parity builder
          (one shared deps fetch, no tokenURI calls). Skipped when the hero
          already shows the only mint. */}
      {hasWork && recent.length > 1 && (
        <section className="border-t border-gray-200 px-6 py-10 lg:px-12">
          <h2 className="mb-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Recent mints
          </h2>
          <RecentMintsGrid collection={addr} work={c.work} entries={recent} />
        </section>
      )}
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
