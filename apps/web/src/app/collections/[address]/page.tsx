import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { MintCollectionCTA } from "@/components/collections/MintCollectionCTA"
import { HomageMint } from "@/components/collections/homage/HomageMint"
import { FitHeadline } from "@/components/collections/homage/FitHeadline"
import { HomageMastheadStat, HomageStickyMintBar } from "@/components/collections/homage/HomageMintChip"
import { ArtistName } from "@/components/collections/homage/ArtistName"
import { HomageMintLog } from "@/components/collections/homage/HomageMintLog"
import { HomageField } from "@/components/collections/homage/HomageField"
import { HomageAbout } from "@/components/collections/homage/HomageAbout"
import { getHomageMintFeed, getHomageMintedIds } from "@/lib/homage/collection.server"
import { WithdrawPanel } from "@/components/collections/WithdrawPanel"
import { CollectionMintHistory } from "@/components/collections/CollectionMintHistory"
import { AttributionRoster } from "@/components/collections/AttributionRoster"
import { ParityMosaic, OnchainMosaic } from "@/components/collections/CollectionMosaic"
import { PlacardStats, StickyMintBar } from "@/components/collections/CollectionPlacard"
import { CollectionFocusRefresh } from "@/components/collections/CollectionFocusRefresh"
import { BatchGrid } from "@/components/collections/BatchGrid"
import { EditionMintLayout } from "@/components/collections/edition/EditionMintLayout"
import { TokenMedia } from "@/components/token/TokenMedia"
import {
  getAttribution,
  getCollection,
  getCollectionMintHistory,
  getCollectionTokenRenders,
  getRecentTokenMarks,
  getRendererSamplePreview,
  getContractMetadata,
  getRendererTokenPreview,
  getRouterBatches,
  isBatchRenderRouter,
  type RenderableSample,
} from "@/lib/collection-onchain"
import { getCollectionMintedIdsFromIndexer } from "@/lib/indexer-queries"
import { selectCollectionHeroMode, selectPreMintHero } from "@/lib/collection-hero"
import type { ContractMetadata } from "@/lib/collection-preview"
import { selectGridTokenIds } from "@/lib/collection-grid-tokens"
import { detectHomageMinter } from "@/lib/homage/detect.server"
import { isEscapeRenderer, ESCAPE_DESCRIPTION, ESCAPE_PIECE_TITLE } from "@/lib/escape-render"
import { getLayoutKindForCollection } from "@/lib/launch-descriptors"
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
  openSeaAddressUrl,
  formatBps,
  hasPriceStrategy,
  ipfsToHttp,
  lifecycleStatus,
  saleWindowOf,
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

// Grid tile ceiling: the post-mint OnchainMosaic never fetches or shows
// more than this many minted ids.
const GRID_TOKEN_CAP = 12

/** A short address, linked to the explorer (evm.now). Used in the two
 *  single-visual layout branches' facts lists. */
function addressLink(a: Address) {
  return (
    <a
      href={evmNowAddressUrl(a, PND_CHAIN_ID)}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-gray-300 underline-offset-2 hover:text-fg"
    >
      {shortAddress(a)}
    </a>
  )
}

/** Whether the renderer is locked, a fact about the Surface protocol
 *  rather than the collection's own content. Shown in both hero layouts. */
function RendererPermanenceNote({ permanent }: { permanent: boolean }) {
  return (
    <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
      {permanent
        ? "The renderer is locked: this collection renders through its current contract forever. The contract itself has had no upgrade path since deploy."
        : "The contract is immutable from deploy. The renderer can change until the artist locks it."}
    </p>
  )
}

/** How to mint this collection from another interface, routing the
 *  referral share to the caller instead of PND. Shown only when the
 *  collection sells through a primary minter. */
function SelfHostNote({ minter, referralShareBps }: { minter: Address; referralShareBps: number }) {
  return (
    <div className="pt-2">
      <h3 className="mb-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        Self host this mint
      </h3>
      <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
        This collection sells through its own primary minter and can be
        minted from any interface. From your own page, call{" "}
        <code className="text-fg">mint(to, qty, yourAddress, 0x)</code> on{" "}
        <code className="break-all text-fg">{minter}</code> so the{" "}
        {formatBps(referralShareBps)} referral share routes to you, not PND.
      </p>
    </div>
  )
}

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
  // Homage field: the minted set (indexer SELECT; chain scan only as
  // fallback). With none minted the field shows the curated wall, which
  // generates its own samples. The mint feed is fetched once here and
  // passed to both HomageMintLog mounts (desktop sidebar + mobile record).
  const [homageMintedIds, homageMintFeed] = homageSkin
    ? await Promise.all([getHomageMintedIds(addr), getHomageMintFeed(addr)])
    : [[], []]
  const [history, attribution, recent] = await Promise.all([
    getCollectionMintHistory(addr, c.minted, c.cfg.idMode),
    getAttribution(addr),
    getRecentTokenMarks(addr, c.minted, c.cfg.idMode),
  ])

  // The collection's own contractURI() metadata: its description (shown
  // verbatim in place of any PND placeholder copy) and, when RenderAssets
  // has no cover, a fallback cover image. Skipped for the homage skin,
  // which owns its own art and copy. One eth_call, cached.
  const contractMeta: ContractMetadata = homageSkin
    ? { description: null, image: null }
    : await getContractMetadata(addr, c.renderer)
  const effectiveCover = c.cover.length > 0 ? c.cover : (contractMeta.image ?? "")
  const hasCover = effectiveCover.length > 0
  const hasWork = c.work.code.length > 0
  const preMint = c.minted === 0n
  // Layout selection: a data lookup (collection address -> layoutKind), not
  // a hardcoded per-address component branch (see AGENTS.md's note on the
  // Homage anti-pattern this deliberately avoids repeating). Read this early
  // (a pure lookup, no chain/indexer cost) so the default layout's hero
  // reads below can skip themselves entirely on an edition-layout collection,
  // which builds its own hero from sharedArt further down.
  const layoutKind = getLayoutKindForCollection(addr)
  const isDefaultLayout = !homageSkin && layoutKind !== "edition"

  // A renderer-native collection (no work config) may implement the
  // OPTIONAL previewURI extension. One cached probe (previewURI(collection,
  // 1, a seed fixed to the collection address), decoded with
  // decodePreviewURI) serves two needs: the "long-form generative work"
  // byline/about copy below, and the pre-mint hero's sample when there is
  // no cover. Fires once here on the collection page's server render,
  // never on the client and never per component render. Cached 20s at
  // sc-premint-sample:<collection>:<renderer> (see getRendererSamplePreview).
  const sample: RenderableSample | null =
    isDefaultLayout && !hasWork ? await getRendererSamplePreview(addr, c.renderer) : null

  // Post-mint grid: only ids that actually minted, never a speculative
  // "next N ids" guess (that used to fill the grid with previewURI samples
  // for ids nothing minted, some of which rendered as empty tiles for a
  // renderer answering animation_url with no image field). Ids come from
  // the indexer's collection_tokens for this collection, newest first, else
  // a sequential 1..min(minted, cap) fallback when the indexer has no rows
  // yet (selectGridTokenIds). hasWork collections use ParityMosaic's own
  // mint feed instead and skip this read entirely.
  const gridTokenIds =
    isDefaultLayout && !hasWork && !preMint
      ? selectGridTokenIds(
          (await getCollectionMintedIdsFromIndexer(addr, GRID_TOKEN_CAP)) ?? [],
          c.minted,
          GRID_TOKEN_CAP,
        )
      : []
  // Each grid id's real tokenURI, read server-side. One multicall covers
  // every id whose render isn't already cached; see getCollectionTokenRenders's
  // own doc comment for the cache key and TTL.
  const gridRenders =
    gridTokenIds.length > 0
      ? await getCollectionTokenRenders(addr, c.renderer, gridTokenIds)
      : new Map<number, RenderableSample | null>()

  // Which shape the hero renders in: one visual beside the title and mint
  // info (pre-mint, or a minted collection with no token grid to show), or
  // the wide banner plus token grid (see selectCollectionHeroMode).
  const heroMode = selectCollectionHeroMode(preMint, gridTokenIds.length)

  // The number a collector reads as "the edition": the collection's cap when
  // it has one, otherwise the minter's ceiling, which is what bounds an
  // open-supply release run in batches. 0 when nothing bounds it.
  const minterCap = c.sale?.maxMints ?? 0n
  const editionSize =
    c.cfg.supplyCap > 0n && minterCap > 0n
      ? c.cfg.supplyCap < minterCap
        ? c.cfg.supplyCap
        : minterCap
      : c.cfg.supplyCap > 0n
        ? c.cfg.supplyCap
        : minterCap

  // Sidebar description: the collection's own contractURI description when it
  // has one, else the work's mirrored description for the escape special case
  // (its tokenURI, where the literal lives, cannot be read). Null shows no
  // blurb rather than inventing one.
  const isEscape = await isEscapeRenderer(c.renderer)
  const description = contractMeta.description ?? (isEscape ? ESCAPE_DESCRIPTION : null)
  // The piece's own title, shown under the collection name when it differs.
  const pieceTitle = isEscape ? ESCAPE_PIECE_TITLE : null

  const permanent = c.isRendererLocked
  // sellsViaMinterOnly(idMode) covers the structural pooled case;
  // `!c.primaryMinter` additionally covers a sequential collection with no
  // primary minter on record (bring-your-own, or not yet indexed) — both
  // render the quiet "mints through its minter" notice instead of the
  // direct buy flow.
  const pooled = sellsViaMinterOnly(c.cfg.idMode) || !c.primaryMinter
  const strategy = hasPriceStrategy(c.sale?.priceStrategy ?? ZERO_ADDRESS)

  // Batch view (docs/pnd-surface-second-launch.md): interface-driven, not a
  // per-address registry — any collection whose live renderer advertises
  // IBatchRenderRouter lights this up. One cached supportsInterface read,
  // then (only when true) the router's batch list plus one cached
  // getRendererTokenPreview per batch for its shared artwork.
  const isRouter = !homageSkin ? await isBatchRenderRouter(c.renderer) : false
  const batches = isRouter ? await getRouterBatches(c.renderer) : []
  const batchImages: Record<number, string> = {}
  // The first batch's render, reused as the edition hero's shared artwork
  // (every token in a batch renders the same piece) without a second read.
  // Read from the renderer directly (not collection.tokenURI, which reverts
  // for an unminted id) so batch cards and the hero show art before any mint.
  let firstBatchArt: Awaited<ReturnType<typeof getRendererTokenPreview>> = null
  if (batches.length > 0) {
    const imgs = await Promise.all(batches.map((b) => getRendererTokenPreview(addr, c.renderer, b.startId)))
    batches.forEach((b, i) => {
      batchImages[b.index] = imgs[i]?.image ?? ""
    })
    firstBatchArt = imgs[0] ?? null
  }

  if (!homageSkin && layoutKind === "edition") {
    const editionArtists = attribution.length > 0 ? attribution.map((a) => a.creator) : [c.owner]
    // An edition shows one artwork for every token, so the hero renders the
    // shared piece (interactive when the renderer gives an animation_url),
    // shown pre-mint too since the renderer returns art for any id. A batch
    // grid is only for a multi-batch release; a single-artwork edition shows
    // the piece itself, not a one-card grid.
    const sharedArt = batches.length > 0 ? firstBatchArt : await getRendererTokenPreview(addr, c.renderer, 1n)
    const fallbackLine = (
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        Artwork renders per token
      </p>
    )
    // Pre-mint follows the same cover, then sample, then line order as the
    // default layout's PreMintHero (selectPreMintHero), so cover always wins
    // here too instead of an animation_url racing ahead of it.
    const preMintSource = selectPreMintHero(hasCover, !!(sharedArt?.image || sharedArt?.animationUrl))
    const editionHero =
      batches.length > 1 ? (
        <BatchGrid collection={addr} batches={batches} images={batchImages} />
      ) : preMint ? (
        preMintSource === "cover" ? (
          <TokenMedia imageUrl={effectiveCover} animationUrl={null} title={c.name} />
        ) : preMintSource === "sample" ? (
          <TokenMedia
            imageUrl={sharedArt?.image ?? ""}
            animationUrl={sharedArt?.animationUrl ?? null}
            title={c.name}
          />
        ) : (
          fallbackLine
        )
      ) : sharedArt?.animationUrl || sharedArt?.image || hasCover ? (
        <TokenMedia
          imageUrl={hasCover ? effectiveCover : sharedArt?.image ?? ""}
          animationUrl={sharedArt?.animationUrl ?? null}
          title={c.name}
        />
      ) : (
        fallbackLine
      )
    return (
      <EditionMintLayout
        name={c.name}
        byline={
          <>
            by{" "}
            {editionArtists.map((a, i) => (
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
            {editionSize > 0n && ` · ${editionSize.toString()} editions`}
          </>
        }
        hero={editionHero}
        mintInstrument={
          <MintCollectionCTA
            collection={addr}
            minter={c.primaryMinter}
            work={hasWork ? c.work : null}
            snapshot={{
              price: (c.sale?.price ?? 0n).toString(),
              priceStrategy: c.sale?.priceStrategy ?? ZERO_ADDRESS,
              mintStart: (c.sale?.mintStart ?? 0n).toString(),
              mintEnd: (c.sale?.mintEnd ?? 0n).toString(),
              payout: c.sale?.payout ?? ZERO_ADDRESS,
              allowlistRoot: c.sale?.allowlistRoot ?? ("0x" + "0".repeat(64) as `0x${string}`),
              walletCap: (c.sale?.walletCap ?? 0n).toString(),
              supplyCap: c.cfg.supplyCap.toString(),
              maxMints: (c.sale?.maxMints ?? 0n).toString(),
              minted: c.minted.toString(),
              referralShareBps: c.sale?.referralShareBps ?? REFERRAL_SHARE_BPS,
            }}
          />
        }
        subtitle={pieceTitle}
        description={
          description ? <p className="whitespace-pre-line">{description}</p> : undefined
        }
        history={<CollectionMintHistory history={history} chainId={PND_CHAIN_ID} />}
        about={
          batches.length > 0 ? (
            <p>
              Minted in batches: every token in a batch shares that batch&rsquo;s
              artwork. See the batch grid for the full release.
            </p>
          ) : undefined
        }
        facts={[
          { label: "Contract", value: addressLink(addr) },
          { label: "Owner", value: addressLink(c.owner) },
          { label: "Renderer", value: addressLink(c.renderer) },
          {
            label: "Royalty",
            value: c.cfg.royaltyBps > 0 ? formatBps(c.cfg.royaltyBps) : "none",
          },
          { label: "Sale mode", value: pooled ? "Pooled (via minter)" : "Sequential" },
        ]}
      />
    )
  }

  // A renderer-native collection whose hero is one visual rather than a
  // grid (selectCollectionHeroMode: pre-mint, or minted with no token grid
  // to show). Routes through the same two-column layout as the "edition"
  // layoutKind branch above instead of the banner+grid masthead below, so
  // the two single-visual cases render identically.
  if (!homageSkin && isDefaultLayout && !hasWork && heroMode === "single") {
    const singleArtists = attribution.length > 0 ? attribution.map((a) => a.creator) : [c.owner]
    return (
      <EditionMintLayout
        name={c.name}
        subtitle={pieceTitle}
        byline={
          <>
            by{" "}
            {singleArtists.map((a, i) => (
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
          </>
        }
        hero={<PreMintHero cover={hasCover ? effectiveCover : null} sample={sample} name={c.name} />}
        mintInstrument={
          <MintCollectionCTA
            collection={addr}
            minter={c.primaryMinter}
            work={null}
            snapshot={{
              price: (c.sale?.price ?? 0n).toString(),
              priceStrategy: c.sale?.priceStrategy ?? ZERO_ADDRESS,
              mintStart: (c.sale?.mintStart ?? 0n).toString(),
              mintEnd: (c.sale?.mintEnd ?? 0n).toString(),
              payout: c.sale?.payout ?? ZERO_ADDRESS,
              allowlistRoot: c.sale?.allowlistRoot ?? ("0x" + "0".repeat(64) as `0x${string}`),
              walletCap: (c.sale?.walletCap ?? 0n).toString(),
              supplyCap: c.cfg.supplyCap.toString(),
              maxMints: (c.sale?.maxMints ?? 0n).toString(),
              minted: c.minted.toString(),
              referralShareBps: c.sale?.referralShareBps ?? REFERRAL_SHARE_BPS,
            }}
          />
        }
        description={
          description ? <p className="whitespace-pre-line">{description}</p> : undefined
        }
        history={<CollectionMintHistory history={history} chainId={PND_CHAIN_ID} />}
        about={
          <div className="space-y-4">
            <RendererPermanenceNote permanent={permanent} />
            {c.primaryMinter && (
              <SelfHostNote
                minter={c.primaryMinter}
                referralShareBps={c.sale?.referralShareBps ?? REFERRAL_SHARE_BPS}
              />
            )}
          </div>
        }
        facts={[
          { label: "Contract", value: addressLink(addr) },
          { label: "Owner", value: addressLink(c.owner) },
          { label: "Renderer", value: addressLink(c.renderer) },
          {
            label: "Royalty",
            value: c.cfg.royaltyBps > 0 ? formatBps(c.cfg.royaltyBps) : "none",
          },
          { label: "Sale mode", value: pooled ? "Pooled (via minter)" : "Sequential" },
        ]}
      />
    )
  }

  // Lifecycle status is no longer stored on the token (thin-token
  // rearchitecture, §7.6): derive it here from the minter's sale window
  // (saleWindowOf folds in "no minter" as an always-open default) plus the
  // token's own cap state, same as every other client-side status read.
  const nowSec = Math.floor(Date.now() / 1000)
  const status = lifecycleStatus(saleWindowOf(c), c.minted, nowSec)
  const capReached = c.cfg.supplyCap > 0n && c.minted >= c.cfg.supplyCap
  const soldOut = status === SurfaceStatus.Closed && capReached
  const mintCouldBeLive = status === SurfaceStatus.Scheduled || status === SurfaceStatus.Open

  const placard = {
    price: (c.sale?.price ?? 0n).toString(),
    supplyCap: c.cfg.supplyCap.toString(),
              maxMints: (c.sale?.maxMints ?? 0n).toString(),
    mintStart: (c.sale?.mintStart ?? 0n).toString(),
    mintEnd: (c.sale?.mintEnd ?? 0n).toString(),
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
      supply={c.cfg.supplyCap > 0n ? Number(c.cfg.supplyCap) : 10_000}
      minted={Number(c.minted)}
      viewAllHref={`/collections/${addr}/gallery`}
    />
  ) : hasWork ? (
    <ParityMosaic
      collection={addr}
      work={c.work}
      entries={recent}
      minted={c.minted.toString()}
    />
  ) : preMint ? (
    <PreMintHero cover={hasCover ? effectiveCover : null} sample={sample} name={c.name} />
  ) : (
    <OnchainMosaic
      collection={addr}
      tokenIds={gridTokenIds}
      renders={Object.fromEntries(gridRenders)}
      cover={hasCover ? effectiveCover : null}
    />
  )

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
              {homageSkin ? (
                // Homage is ripe's work — the byline names the artist and links to
                // their X account.
                <a
                  href="https://x.com/ripe0x"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-gray-300 underline-offset-2 hover:text-fg"
                >
                  ripe
                </a>
              ) : (
                artists.map((a, i) => (
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
                ))
              )}
            </p>
          )
          return homageSkin ? (
            // Headline fills the width on one line (scales to the title length); one
            // tight metadata row beneath it — byline left, then the count + mint chip
            // inline on the right (the chip is the only place status lives).
            <div className="space-y-6">
              <FitHeadline text={c.name} className="w-full" max={260} />
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                {byline}
                {homageMinter ? (
                  <HomageMastheadStat
                    minter={homageMinter}
                    minted={c.minted.toLocaleString()}
                    supplyCap={c.cfg.supplyCap.toLocaleString()}
                    anchorId="mint-instrument"
                    chipId="mint-chip"
                  />
                ) : (
                  <p className="font-mono text-xl tabular-nums tracking-tight text-fg sm:text-2xl">
                    {c.minted.toLocaleString()}{" "}
                    <span className="text-gray-500">/ {c.cfg.supplyCap.toLocaleString()}</span>
                  </p>
                )}
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
            Artwork renders per token
          </p>
        </div>
      )}

      {/* ── Editorial band: the story beside the instrument, set in
             hairline-framed cells (the Feral File grammar) so the band
             reads as composed, not floated. ── */}
      <div
        id="mint-instrument"
        className={`scroll-mt-20 border-b border-gray-200 ${mintFirst ? "order-first" : ""}`}
      >
      <div
        className={`mx-auto grid w-full max-w-[1400px] grid-cols-1 ${
          // The band is a centered ≤1400px plate (the page's standard content width):
          // full-bleed columns let the About cell's 720px measure drift away from the
          // divider on wide screens, stranding the card in dead space. Right column is
          // sized TO the instrument (460px + px-12 gutters). The homage skin always
          // has the full editorial About content, so it always runs the two-column
          // layout (never collapses to a single centered column).
          homageSkin
            ? "lg:grid-cols-[1fr_556px] lg:divide-x lg:divide-gray-200"
            : "lg:grid-cols-[1fr_460px] lg:divide-x lg:divide-gray-200"
        }`}
      >
        <div
          className={`max-w-[720px] px-6 py-10 lg:px-12 lg:py-12 ${
            // Stacked on phones the instrument leads and the editorial follows, matching
            // the pre-deploy landing. Side by side, source order applies.
            homageSkin ? "order-2 lg:order-none" : ""
          }`}
        >
          {homageSkin ? (
            <HomageAbout headingClassName="text-[10px] font-mono uppercase tracking-wider text-gray-400" />
          ) : (
            <div className="space-y-6">
              {description && (
                <>
                  <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    About this work
                  </h2>
                  <p className="text-sm leading-relaxed text-fg-muted whitespace-pre-line">
                    {description}
                  </p>
                </>
              )}
              <RendererPermanenceNote permanent={permanent} />
              {c.primaryMinter && (
                <SelfHostNote
                  minter={c.primaryMinter}
                  referralShareBps={c.sale?.referralShareBps ?? REFERRAL_SHARE_BPS}
                />
              )}
            </div>
          )}
        </div>

        <div
          className={`mx-auto w-full max-w-[556px] px-6 py-10 lg:px-12 lg:py-12 ${
            homageSkin ? "order-1 lg:order-none" : ""
          }`}
        >
          {homageMinter ? (
            // The cell is capped at the instrument's width (556 = 460 + 2×48 gutters)
            // and centered by the grid when it stands alone, so the card never floats.
            <div className="mx-auto w-full max-w-[460px]">
              <HomageMint collection={addr} minter={homageMinter} mintFeed={homageMintFeed} />
            </div>
          ) : (
            <MintCollectionCTA
              collection={addr}
              minter={c.primaryMinter}
              work={hasWork ? c.work : null}
              snapshot={{
                price: (c.sale?.price ?? 0n).toString(),
                priceStrategy: c.sale?.priceStrategy ?? ZERO_ADDRESS,
                mintStart: (c.sale?.mintStart ?? 0n).toString(),
                mintEnd: (c.sale?.mintEnd ?? 0n).toString(),
                payout: c.sale?.payout ?? ZERO_ADDRESS,
                allowlistRoot:
                  c.sale?.allowlistRoot ?? ("0x" + "0".repeat(64) as `0x${string}`),
                walletCap: (c.sale?.walletCap ?? 0n).toString(),
                supplyCap: c.cfg.supplyCap.toString(),
              maxMints: (c.sale?.maxMints ?? 0n).toString(),
                minted: c.minted.toString(),
                referralShareBps: c.sale?.referralShareBps ?? REFERRAL_SHARE_BPS,
              }}
            />
          )}
          {/* Compact trust strip (§9): the load-bearing facts beside the
              mint action; the record section below carries the rest. */}
          <p className="flex items-center gap-4 pt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <a
              href={evmNowAddressUrl(addr, PND_CHAIN_ID)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-fg"
            >
              {shortAddress(addr)} ↗
            </a>
            {homageSkin && (
              <a
                href="https://opensea.io/collection/homage-to-the-punk"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-fg"
              >
                OpenSea ↗
              </a>
            )}
          </p>
        </div>
      </div>{/* /band inner plate */}
      </div>

      </div>{/* /field+band order wrapper */}

      {/* ── The record: mints (read live from chain), and the load-bearing facts. ── */}
      {homageSkin ? (
        <section className="border-t border-gray-200">
          <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-16 gap-y-10 px-6 py-10 md:grid-cols-2 lg:grid-cols-1 lg:px-12 lg:py-14">
            {/* Mints ARE readable onchain (Transfer scan) — show them, don't defer to an indexer.
                Hidden at lg: the sidebar (HomageMint) carries its own copy at the bottom of
                its stack there. Below lg the sidebar isn't a separate column, so this stays
                in its original spot. */}
            <div className="lg:hidden">
              <HomageMintLog collection={addr} chainId={PND_CHAIN_ID} mints={homageMintFeed} variant="mobile" />
            </div>
            {/* Contract details, matching the 1/1 auction token page's
                treatment (see src/app/[handle]/[tokenId]/page.tsx): a small
                caps header, then a definition list of load-bearing facts,
                then a plain stack of outbound links. */}
            <div className="text-[11px] font-mono md:w-full md:max-w-[360px] md:justify-self-end">
              <h3 className="mb-3 text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400">
                Contract
              </h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Address
                </dt>
                <dd className="truncate text-[10px] font-mono">
                  <a
                    href={evmNowAddressUrl(addr, PND_CHAIN_ID)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {addr}
                  </a>
                </dd>
                <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Standard
                </dt>
                <dd className="text-[10px] font-mono">ERC721</dd>
                <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Owner
                </dt>
                <dd className="text-[10px] font-mono">
                  <AddrLink addr={c.owner} />
                </dd>
                <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Payout
                </dt>
                <dd className="text-[10px] font-mono">
                  <AddrLink
                    addr={
                      !c.sale || c.sale.payout === ZERO_ADDRESS ? c.owner : c.sale.payout
                    }
                  />
                </dd>
                <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Renderer
                </dt>
                <dd className="text-[10px] font-mono">
                  <AddrLink addr={c.renderer} />
                  {c.isRendererLocked ? " · locked" : ""}
                </dd>
                <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Royalty
                </dt>
                <dd className="text-[10px] font-mono">
                  {c.cfg.royaltyBps > 0 ? formatBps(c.cfg.royaltyBps) : "none"}
                </dd>
              </dl>
              <div className="flex flex-col gap-2 pt-4">
                <div className="flex items-center gap-4">
                  <a
                    href={evmNowAddressUrl(addr, PND_CHAIN_ID)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] uppercase tracking-wider text-gray-400 underline hover:text-fg"
                  >
                    View contract ↗
                  </a>
                  <a
                    href={openSeaAddressUrl(addr, PND_CHAIN_ID)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] uppercase tracking-wider text-gray-400 underline hover:text-fg"
                  >
                    OpenSea ↗
                  </a>
                </div>
                <Link
                  href={`/collections/${addr}/redeem`}
                  className="text-[10px] uppercase tracking-wider text-gray-400 underline hover:text-fg"
                >
                  Redeem a homage →
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="border-t border-gray-200">
          <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-16 px-6 py-10 md:grid-cols-2 lg:grid-cols-3 lg:px-12 lg:py-14">
            <div>
              <AttributionRoster entries={attribution} chainId={PND_CHAIN_ID} />
              <WithdrawPanel minter={c.primaryMinter} />
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
              {c.protocolVersion === 2 && (
                <Fact
                  label="Royalty lock"
                  value={c.isRoyaltyLocked ? "Locked forever" : "Adjustable by the artist"}
                />
              )}
              {c.protocolVersion === 2 && (
                <Fact label="Sealed" value={c.sealed ? "Sealed, ownership renounced" : "Not sealed"} />
              )}
              <Fact
                label="Referral share"
                value={`${formatBps(c.sale?.referralShareBps ?? REFERRAL_SHARE_BPS)} (to the referrer)`}
              />
              <Fact label="Pricing" value={strategy ? "Live strategy" : "Fixed"} />
              <Fact label="Sale mode" value={pooled ? "Pooled (via minter)" : "Sequential"} />
              <Fact
                label="Payout"
                value={
                  !c.sale || c.sale.payout === ZERO_ADDRESS
                    ? shortAddress(c.owner)
                    : shortAddress(c.sale.payout)
                }
              />
              <div className="flex items-center gap-4 pt-1">
                <a
                  href={evmNowAddressUrl(addr, PND_CHAIN_ID)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] uppercase tracking-wider text-gray-400 underline hover:text-fg"
                >
                  View contract ↗
                </a>
                <a
                  href={openSeaAddressUrl(addr, PND_CHAIN_ID)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] uppercase tracking-wider text-gray-400 underline hover:text-fg"
                >
                  OpenSea ↗
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

/** Pre-mint hero: cover first, else one sample render from the renderer
 *  (getRendererSamplePreview's fixed-seed previewURI call), else the plain
 *  fallback line. See selectPreMintHero for the selection order. */
function PreMintHero({
  cover,
  sample,
  name,
}: {
  cover: string | null
  sample: RenderableSample | null
  name: string
}) {
  const source = selectPreMintHero(!!cover, !!sample)
  if (source === "fallback") {
    return (
      <div className="flex min-h-[50vh] items-center justify-center border-y border-gray-200 bg-gray-100 dark:bg-bg">
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Artwork renders per token
        </p>
      </div>
    )
  }
  return (
    <div className="flex justify-center border-y border-gray-200 bg-gray-100 px-6 py-10 dark:bg-bg lg:py-16">
      {source === "cover" ? (
        <OptimizedImage
          src={cover as string}
          alt={name}
          width={1600}
          loading="eager"
          className="max-h-[70vh] w-auto max-w-full object-contain"
        />
      ) : sample?.kind === "html" ? (
        <iframe
          sandbox="allow-scripts"
          srcDoc={sample.html}
          title={name}
          className="aspect-square h-[70vh] max-h-[70vh] w-auto max-w-full border-0"
        />
      ) : (
        <OptimizedImage
          src={(sample as { kind: "image"; src: string }).src}
          alt={name}
          width={1600}
          loading="eager"
          className="max-h-[70vh] w-auto max-w-full object-contain"
        />
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
