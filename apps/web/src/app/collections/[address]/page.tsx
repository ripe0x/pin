import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { MintCollectionCTA } from "@/components/collections/MintCollectionCTA"
import { WithdrawPanel } from "@/components/collections/WithdrawPanel"
import { CollectionMintHistory } from "@/components/collections/CollectionMintHistory"
import { AttributionRoster } from "@/components/collections/AttributionRoster"
import { ExploreGrid, RecentMintsGrid } from "@/components/collections/GenerativeViews"
import { CollectionWall } from "@/components/collections/CollectionWall"
import { PlacardStatus, StickyMintBar } from "@/components/collections/CollectionPlacard"
import { CollectionFocusRefresh } from "@/components/collections/CollectionFocusRefresh"
import { OnchainPreviewWall } from "@/components/collections/OnchainPreviewWall"
import {
  getAttribution,
  getCollection,
  getCollectionMintHistory,
  getCollectionToken,
  getGateState,
  getRecentTokenMarks,
  getRendererPreviews,
} from "@/lib/collection-onchain"
import {
  CollectionStatus,
  PND_CHAIN_ID,
  REFERRAL_SHARE_BPS,
  ZERO_ADDRESS,
  evmNowAddressUrl,
  formatBps,
  hasPriceStrategy,
  ipfsToHttp,
  sellsViaMinterOnly,
  shortAddress,
} from "@/lib/collection"

/**
 * The collection page, composed as an exhibition rather than a token
 * detail: a typographic placard (name, artists, one live status line), the
 * wall (a full-bleed gallery field with the work large and a range strip
 * beneath it), an editorial band with the provenance story beside the mint
 * instrument, the collection grid, and a quiet record section. A sticky
 * mint bar keeps the sale one tap away while the instrument is off-screen —
 * only while a mint is live; closed pages are a record, not a store.
 */

// TODO: Collection Graph (edges) is not yet exposed by the data layer —
// skipping the graph view for v1; add it once the data layer grows the read.

type Params = Promise<{ address: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address } = await params
  if (!isAddress(address)) return { title: "Collection" }
  const c = await getCollection(address as Address)
  if (!c) return { title: "Collection" }
  const image = ipfsToHttp(c.cover)
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
  const [history, attribution, recent, gate] = await Promise.all([
    getCollectionMintHistory(addr, c.minted, c.cfg.idMode),
    getAttribution(addr),
    getRecentTokenMarks(addr, c.minted, c.cfg.idMode),
    c.cfg.mintHook !== ZERO_ADDRESS ? getGateState(addr) : Promise.resolve(null),
  ])

  const hasCover = c.cover.length > 0
  const hasWork = c.work.code.length > 0
  // Renderer-native works (custom or Solidity-SVG renderers with no parity
  // work config): if the renderer implements the OPTIONAL previewURI
  // extension, the wall explores it straight from the chain. One cached
  // probe when unsupported.
  const onchainPreviews = !hasWork
    ? await getRendererPreviews(addr, c.renderer, c.minted + 1n, 5)
    : null
  const firstTokenImage =
    !hasCover && !hasWork && !onchainPreviews && c.minted > 0n
      ? (await getCollectionToken(addr, 1n))?.image ?? ""
      : ""

  const permanent = c.isRendererLocked
  const pooled = sellsViaMinterOnly(c.cfg.idMode)
  const strategy = hasPriceStrategy(c.priceStrategy)

  const capReached = c.cfg.supplyCap > 0n && c.minted >= c.cfg.supplyCap
  const soldOut = c.status === CollectionStatus.Closed && capReached
  const mintCouldBeLive =
    c.status === CollectionStatus.Scheduled || c.status === CollectionStatus.Open

  const placard = {
    price: c.cfg.price.toString(),
    supplyCap: c.cfg.supplyCap.toString(),
    mintStart: c.cfg.mintStart.toString(),
    mintEnd: c.cfg.mintEnd.toString(),
    minted: c.minted.toString(),
    hasStrategy: strategy,
    pooled,
  }

  const artists = attribution.length > 0 ? attribution.map((a) => a.artist) : [c.owner]

  return (
    <div>
      {mintCouldBeLive && <CollectionFocusRefresh />}

      {/* ── The placard: exhibition-scale identity, one live status line. ── */}
      <header className="mx-auto max-w-[1400px] px-6 pt-10 pb-8 lg:px-12 lg:pt-16 lg:pb-10">
        <nav className="mb-6 text-[10px] font-mono uppercase tracking-wider text-gray-400">
          <Link href="/collections" className="underline hover:text-fg">
            Collections
          </Link>
        </nav>
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-medium tracking-tight leading-[1.05]">
          {c.name}
        </h1>
        <p className="mt-3 text-[11px] font-mono uppercase tracking-wider text-gray-500">
          {c.symbol} · by{" "}
          {artists.map((a, i) => (
            <span key={a}>
              {i > 0 && ", "}
              <a
                href={evmNowAddressUrl(a, PND_CHAIN_ID)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-gray-300 underline-offset-2 hover:text-fg"
              >
                {shortAddress(a)}
              </a>
            </span>
          ))}
        </p>
        <div className="mt-4">
          <PlacardStatus snapshot={placard} />
        </div>
      </header>

      {/* ── The wall: the work large, its range beneath it. ── */}
      {hasWork ? (
        <CollectionWall
          collection={addr}
          work={c.work}
          entries={recent}
          minted={c.minted.toString()}
        />
      ) : onchainPreviews ? (
        <OnchainPreviewWall collection={addr} previews={onchainPreviews} />
      ) : (
        <section className="bg-gray-100 dark:bg-bg border-b border-gray-200">
          <div className="mx-auto flex max-w-[1400px] items-center justify-center px-6 py-10 lg:px-12 lg:py-14">
            {hasCover || firstTokenImage ? (
              <OptimizedImage
                src={hasCover ? c.cover : firstTokenImage}
                alt={c.name}
                width={1200}
                loading="eager"
                className="max-h-[62vh] max-w-full object-contain border border-gray-200 dark:border-gray-800"
              />
            ) : (
              <p className="py-24 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                No artwork yet
              </p>
            )}
          </div>
        </section>
      )}

      {/* ── Editorial band: the story beside the instrument. ── */}
      <div
        id="mint-instrument"
        className="mx-auto grid max-w-[1400px] scroll-mt-20 grid-cols-1 gap-10 px-6 py-10 lg:grid-cols-[1fr_420px] lg:gap-20 lg:px-12 lg:py-14"
      >
        <div className="max-w-[600px] space-y-6">
          <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            About this work
          </h2>
          {hasWork ? (
            <p className="text-sm leading-relaxed text-fg-muted">
              Every token is generated by the collection&apos;s own algorithm from a
              seed written onchain at mint. The render is a pure function of
              chain state: this code, that seed, forever. No server keeps the
              artwork alive, and every image on this page is the algorithm
              running live in your browser.
            </p>
          ) : onchainPreviews ? (
            <p className="text-sm leading-relaxed text-fg-muted">
              Every token is generated onchain by the collection&apos;s own
              renderer contract from a seed written at mint. The render is a
              pure function of chain state, and every example on this page
              was rendered by that contract, live.
            </p>
          ) : pooled ? (
            <p className="text-sm leading-relaxed text-fg-muted">
              A work on the artist&apos;s own contract, rendered by its own custom
              renderer and sold through its own minter. Every token carries a
              distinct onchain Mint Mark: its place in the collection&apos;s
              history, recorded at mint.
            </p>
          ) : (
            <p className="text-sm leading-relaxed text-fg-muted">
              An edition on the artist&apos;s own contract. Every token carries a
              distinct onchain Mint Mark: its place in the collection&apos;s
              history, recorded at mint.
            </p>
          )}
          <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
            {permanent
              ? "The renderer is locked: this collection renders through its current contract forever. The contract itself has had no upgrade path since deploy."
              : "The contract is immutable from deploy. The renderer can change until the artist locks it."}
          </p>
          <div className="pt-2">
            <h3 className="mb-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
              Self host this mint
            </h3>
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              This collection is the artist&apos;s own contract and can be minted
              from any interface. From your own page, call{" "}
              <code className="text-fg">mintWithReferral(qty, yourAddress, 0x)</code> on{" "}
              <code className="break-all text-fg">{addr}</code> so the{" "}
              {formatBps(REFERRAL_SHARE_BPS)} referral share routes to you, not PND.
            </p>
          </div>
        </div>

        <div>
          <MintCollectionCTA
            collection={addr}
            work={hasWork ? c.work : null}
            gate={gate}
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
          {/* Compact trust strip (§9): the load-bearing facts beside the
              mint action; the record section below carries the rest. */}
          <p className="pt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <a
              href={evmNowAddressUrl(addr, PND_CHAIN_ID)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-fg"
            >
              {shortAddress(addr)} ↗
            </a>
            {" · ERC721 · immutable contract · "}
            {permanent ? "renderer locked forever" : "renderer swappable until locked"}
          </p>
        </div>
      </div>

      {/* ── The collection: the body of work, live while minting. ── */}
      {hasWork && recent.length > 1 && (
        <section className="border-t border-gray-200 px-6 py-10 lg:px-12">
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              The collection
            </h2>
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
              {soldOut
                ? `Complete · ${c.minted.toString()} works`
                : c.cfg.supplyCap > 0n
                  ? `${c.minted.toString()} of ${c.cfg.supplyCap.toString()} minted`
                  : `${c.minted.toString()} minted`}
            </p>
          </div>
          <RecentMintsGrid
            collection={addr}
            work={c.work}
            entries={recent}
            live={c.status === CollectionStatus.Open}
          />
        </section>
      )}

      {/* Pre-mint: the algorithm's deeper range, before any token exists. */}
      {hasWork && c.minted === 0n && (
        <section className="border-t border-gray-200 px-6 py-10 lg:px-12">
          <h2 className="mb-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Example outputs
          </h2>
          <ExploreGrid collection={addr} work={c.work} />
        </section>
      )}

      {/* ── The record: attribution, history, facts. ── */}
      <section className="border-t border-gray-200">
        <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-16 px-6 py-10 md:grid-cols-2 lg:grid-cols-3 lg:px-12 lg:py-14">
          <div>
            <AttributionRoster entries={attribution} chainId={PND_CHAIN_ID} />
            <WithdrawPanel collection={addr} />
          </div>
          <div>
            <CollectionMintHistory history={history} chainId={PND_CHAIN_ID} />
          </div>
          <div className="py-5 space-y-2 text-[11px] font-mono">
            <Fact label="Contract" value={shortAddress(addr)} />
            <Fact label="Standard" value="ERC721" />
            <Fact label="Owner" value={shortAddress(c.owner)} />
            <Fact
              label="Renderer"
              value={c.isRendererLocked ? "Locked forever" : "Swappable by the artist"}
            />
            <Fact
              label="Supply"
              value={c.isSupplyLocked ? "Locked forever" : "Adjustable by the artist"}
            />
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
          </div>
        </div>
      </section>

      <StickyMintBar snapshot={placard} anchorId="mint-instrument" />
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
