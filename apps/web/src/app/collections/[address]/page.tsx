import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { MintCollectionCTA } from "@/components/collections/MintCollectionCTA"
import { WithdrawPanel } from "@/components/collections/WithdrawPanel"
import { CollectionMintHistory } from "@/components/collections/CollectionMintHistory"
import { AttributionRoster } from "@/components/collections/AttributionRoster"
import {
  getAttribution,
  getCollection,
  getCollectionMintHistory,
} from "@/lib/collection-onchain"
import {
  COLLECTION_KIND_LABEL,
  PND_CHAIN_ID,
  SURFACE_SHARE_BPS,
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
  const [history, attribution] = await Promise.all([
    getCollectionMintHistory(addr, c.minted, c.cfg.idMode),
    getAttribution(addr),
  ])

  const mutability = c.isWorkLocked ? "Locked (no upgrades)" : "Upgradeable by the artist"
  const metadataState = c.isMetadataFrozen ? "Frozen" : "Mutable by the artist"
  const permanent = c.isPermanent
  const pooled = sellsViaMinterOnly(c.cfg.idMode)
  const strategy = hasPriceStrategy(c.priceStrategy)

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        {/* Artwork: full-bleed gray field, sticky on desktop. */}
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 dark:bg-bg p-8 lg:p-12">
          <OptimizedImage
            src={c.cfg.artworkURI}
            alt={c.name}
            width={1200}
            loading="eager"
            className="max-h-[78vh] max-w-full object-contain"
          />
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
              label="Surface share"
              value={`${formatBps(SURFACE_SHARE_BPS)} (to the mint surface)`}
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
                Permanent: the contract is locked (no further upgrades) and
                metadata is frozen, so the artwork and code cannot change.
              </p>
            ) : (
              <p className="pt-2 text-[10px] font-mono text-gray-400 normal-case leading-relaxed">
                {!c.isWorkLocked ? "The artist can upgrade this contract until they lock it. " : ""}
                {!c.isMetadataFrozen ? "Artwork can change until the artist freezes metadata." : ""}
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
              <code className="text-fg">mintWithRewards(qty, yourAddress, 0x)</code> on{" "}
              <code className="break-all text-fg">{addr}</code> so the{" "}
              {formatBps(SURFACE_SHARE_BPS)} surface share routes to you, not PND.
            </p>
          </section>
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
