import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { MintCollectionCTA } from "@/components/collections/MintCollectionCTA"
import { HomageMint } from "@/components/collections/homage/HomageMint"
import { FitHeadline } from "@/components/collections/homage/FitHeadline"
import { HomageMintChip, HomageStickyMintBar } from "@/components/collections/homage/HomageMintChip"
import { ArtistName } from "@/components/collections/homage/ArtistName"
import { HomageMintLog } from "@/components/collections/homage/HomageMintLog"
import { HomageField } from "@/components/collections/homage/HomageField"
import { getHomageMintedIds } from "@/lib/homage/collection.server"
import { WithdrawPanel } from "@/components/collections/WithdrawPanel"
import { CollectionMintHistory } from "@/components/collections/CollectionMintHistory"
import { AttributionRoster } from "@/components/collections/AttributionRoster"
import { ParityMosaic, OnchainMosaic } from "@/components/collections/CollectionMosaic"
import { PlacardStats, StickyMintBar } from "@/components/collections/CollectionPlacard"
import { CollectionFocusRefresh } from "@/components/collections/CollectionFocusRefresh"
import {
  getAttribution,
  getCollection,
  getCollectionMintHistory,
  getCollectionToken,
  getContractDescription,
  getGateState,
  getRecentTokenMarks,
  getRendererPreviews,
} from "@/lib/collection-onchain"
import { detectHomageMinter } from "@/lib/homage/detect.server"
// Third layout: the generic collection page reskinned with the /mint/homage
// terminal look (dark palette + Anton condensed display + mono body), applied via
// ?skin=homage. homage-gallery.css defines the .homage-terminal tokens/fonts/accent
// (scoped, so it never leaks); homage-skin.css maps them onto this page's masthead.
import "@/components/mint/homage-gallery/homage-gallery.css"
import "./homage-skin.css"
import {
  SurfaceStatus,
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

export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: Promise<{ skin?: string; layout?: string }>
}) {
  const { address } = await params
  const { skin, layout } = await searchParams
  if (!isAddress(address)) notFound()
  const addr = address as Address
  const c = await getCollection(addr)
  if (!c) notFound()
  // Homage is a pooled collection driven by a bespoke HomageMinter — PND's generic
  // direct-sale path can't drive it, so when this is the registered homage collection
  // (verified on-chain) we render the homage mint instrument instead of the CTA.
  const homageMinter = await detectHomageMinter(addr, PND_CHAIN_ID)
  // Homage owns its whole page: when this is the homage collection it renders in
  // the terminal skin (dark + condensed) with immersive site chrome. `?skin=homage`
  // still forces it on for previewing the treatment on any collection.
  const homageSkin = !!homageMinter || skin === "homage"
  // Alt arrangement (?layout=mint-first): the About|Mint band sits ABOVE the field so
  // the instrument is the second thing on the page instead of below the full-bleed grid.
  const mintFirst = homageSkin && layout === "mint-first"
  // "About this work" is fed from the collection's own contractURI description
  // on the homage skin (no hardcoded meta copy).
  const contractDescription = homageSkin ? await getContractDescription(addr) : null
  // Homage field: the minted set (chain-enumerated) + a deterministic sample spread the
  // pre-mint / fill state draws from.
  const homageMintedIds = homageSkin ? await getHomageMintedIds(addr) : []
  const homageSampleIds = Array.from({ length: 12 }, (_, i) => Math.floor((i + 0.5) * (10_000 / 12)))
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
    ? await getRendererPreviews(addr, c.renderer, c.minted + 1n, 15)
    : null
  const firstTokenImage =
    !hasCover && !hasWork && !onchainPreviews && c.minted > 0n
      ? (await getCollectionToken(addr, 1n))?.image ?? ""
      : ""

  const permanent = c.isRendererLocked
  const pooled = sellsViaMinterOnly(c.cfg.idMode)
  const strategy = hasPriceStrategy(c.priceStrategy)

  const capReached = c.cfg.supplyCap > 0n && c.minted >= c.cfg.supplyCap
  const soldOut = c.status === SurfaceStatus.Closed && capReached
  const mintCouldBeLive =
    c.status === SurfaceStatus.Scheduled || c.status === SurfaceStatus.Open

  const placard = {
    price: c.cfg.price.toString(),
    supplyCap: c.cfg.supplyCap.toString(),
    mintStart: c.cfg.mintStart.toString(),
    mintEnd: c.cfg.mintEnd.toString(),
    minted: c.minted.toString(),
    hasStrategy: strategy,
    pooled,
  }

  const artists = attribution.length > 0 ? attribution.map((a) => a.creator) : [c.owner]

  const hero = homageSkin ? (
    <HomageField
      collection={addr}
      renderer={c.renderer}
      mintedIds={homageMintedIds}
      sampleIds={homageSampleIds}
      supply={c.cfg.supplyCap > 0n ? Number(c.cfg.supplyCap) : 10_000}
      minted={Number(c.minted)}
    />
  ) : hasWork ? (
    <ParityMosaic
      collection={addr}
      work={c.work}
      entries={recent}
      minted={c.minted.toString()}
    />
  ) : onchainPreviews ? (
    <OnchainMosaic collection={addr} previews={onchainPreviews} />
  ) : hasCover || firstTokenImage ? (
    <div className="flex justify-center border-y border-gray-200 bg-gray-100 px-6 py-10 dark:bg-bg lg:py-16">
      <OptimizedImage
        src={hasCover ? c.cover : firstTokenImage}
        alt={c.name}
        width={1600}
        loading="eager"
        className="max-h-[70vh] w-auto max-w-full object-contain"
      />
    </div>
  ) : null

  return (
    <div className={homageSkin ? "dark homage-terminal collection-homage-skin" : undefined}>
      {mintCouldBeLive && <CollectionFocusRefresh />}

      {/* ── Masthead: exhibition-title scale, the whole viewport width, so
             the collection announces itself before the field of work. ── */}
      <header
        className={`px-6 pb-8 lg:px-12 lg:pb-10 ${
          // Immersive homage chrome overlays the fixed 64px navbar, so this page
          // pads itself clear of it and gives the logo real breathing room.
          homageSkin ? "pt-24 lg:pt-32" : "pt-8 lg:pt-12"
        }`}
      >
        <nav className="mb-8 text-[10px] font-mono uppercase tracking-wider text-gray-400 lg:mb-12">
          <Link href="/collections" className="hover:text-fg">
            ← Collections
          </Link>
        </nav>
        {(() => {
          const byline = (
            <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
              by{" "}
              {artists.map((a, i) => (
                <span key={a}>
                  {i > 0 && ", "}
                  <a
                    href={evmNowAddressUrl(a, PND_CHAIN_ID)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-gray-300 underline-offset-2 hover:text-fg"
                  >
                    <ArtistName address={a} />
                  </a>
                </span>
              ))}
              {!homageSkin && (
                <>
                  {" · "}
                  {hasWork
                    ? "long-form generative work, rendered live in your browser"
                    : onchainPreviews
                      ? "long-form generative work, rendered by its own onchain contract"
                      : pooled
                        ? "a work sold through its own minter"
                        : "an edition on the artist's own contract"}
                  {c.cfg.supplyCap > 0n && ` · ${c.cfg.supplyCap.toString()} editions`}
                </>
              )}
            </p>
          )
          return homageSkin ? (
            // Headline fills the width on one line, scaling to the title length;
            // byline on the left, and on the right the count + the mint chip (the
            // only place status lives, so nothing is said twice).
            <div className="space-y-5">
              <FitHeadline text={c.name} className="w-full" />
              <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
                {byline}
                <div className="flex shrink-0 flex-col items-start gap-4 sm:items-end">
                  <p className="font-mono text-3xl tabular-nums tracking-tight text-fg sm:text-4xl">
                    {c.minted.toLocaleString()}{" "}
                    <span className="text-gray-500">/ {c.cfg.supplyCap.toLocaleString()}</span>
                  </p>
                  {homageMinter && (
                    <HomageMintChip id="mint-chip" minter={homageMinter} anchorId="mint-instrument" />
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
              <div>
                <h1 className="max-w-[16ch] text-5xl font-medium leading-[0.92] tracking-tight sm:text-6xl lg:text-[5.5rem]">
                  {c.name}
                </h1>
                <div className="mt-4">{byline}</div>
              </div>
              <div className="shrink-0 lg:pb-1">
                <PlacardStats snapshot={placard} />
              </div>
            </div>
          )
        })()}
      </header>

      {/* Field + editorial band in one flex column so ?layout=mint-first can lift the
          band above the field via CSS order (no duplicated JSX). */}
      <div className="flex flex-col">

      {/* ── The field: the collection's multiplicity, edge to edge. Every
             color on the page comes from the work. ── */}
      {hero ?? (
        <div className="flex min-h-[50vh] items-center justify-center border-y border-gray-200 bg-gray-100 dark:bg-bg">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            No artwork yet
          </p>
        </div>
      )}

      {/* ── Editorial band: the story beside the instrument, set in
             hairline-framed cells (the Feral File grammar) so the band
             reads as composed, not floated. ── */}
      <div
        id="mint-instrument"
        className={`grid scroll-mt-20 grid-cols-1 border-b border-gray-200 lg:divide-x lg:divide-gray-200 ${
          homageSkin ? "lg:grid-cols-2" : "lg:grid-cols-[1fr_460px]"
        } ${mintFirst ? "order-first" : ""}`}
      >
        <div className="max-w-[720px] space-y-6 px-6 py-10 lg:px-12 lg:py-12">
          <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            About this work
          </h2>
          {homageSkin ? (
            contractDescription && (
              <p className="text-sm leading-relaxed text-fg-muted">{contractDescription}</p>
            )
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="px-6 py-10 lg:px-10 lg:py-12">
          {homageMinter ? (
            // Constrained + left-aligned so the instrument sits against the
            // centered divider instead of stretching the full half-column.
            <div className="w-full max-w-[460px]">
              <HomageMint collection={addr} minter={homageMinter} />
            </div>
          ) : (
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
          )}
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

      </div>{/* /field+band order wrapper */}

      {/* ── The record: mints (read live from chain), and the load-bearing facts. ── */}
      {homageSkin ? (
        <section className="border-t border-gray-200">
          <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-16 gap-y-10 px-6 py-10 md:grid-cols-2 lg:px-12 lg:py-14">
            {/* Mints ARE readable onchain (Transfer scan) — show them, don't defer to an indexer. */}
            <HomageMintLog collection={addr} chainId={PND_CHAIN_ID} />
            <div className="space-y-2 text-[11px] font-mono md:w-full md:max-w-[360px] md:justify-self-end">
              <Fact label="Contract" value={<AddrLink addr={addr} />} />
              <Fact label="Owner" value={<AddrLink addr={c.owner} />} />
              <Fact
                label="Payout"
                value={<AddrLink addr={c.cfg.payoutAddress === ZERO_ADDRESS ? c.owner : c.cfg.payoutAddress} />}
              />
              <Fact
                label="Renderer"
                value={c.isRendererLocked ? "Locked forever" : "Swappable by the artist"}
              />
              <Fact
                label="Royalty"
                value={c.cfg.royaltyBps > 0 ? formatBps(c.cfg.royaltyBps) : "none"}
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
      ) : (
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
      )}

      {/* Generic sticky bar bails on pooled collections, so homage ships its own
          quote-aware variant (appears only while the instrument is off-screen). */}
      {homageMinter ? (
        <HomageStickyMintBar minter={homageMinter} anchorId="mint-instrument" chipId="mint-chip" />
      ) : (
        <StickyMintBar snapshot={placard} anchorId="mint-instrument" />
      )}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-gray-400 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="tabular-nums text-right">{value}</span>
    </div>
  )
}

/** A short address that links out to the explorer (evm.now) — used in the record facts. */
function AddrLink({ addr }: { addr: string }) {
  return (
    <a
      href={evmNowAddressUrl(addr, PND_CHAIN_ID)}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-gray-300 underline-offset-2 hover:text-fg"
    >
      {shortAddress(addr)}
    </a>
  )
}
