import type { Address } from "viem"
import { ArtistName } from "@/components/collections/homage/ArtistName"
import { BatchGrid } from "@/components/collections/BatchGrid"
import { CollectionMintHistory } from "@/components/collections/CollectionMintHistory"
import { EditionMintLayout } from "@/components/collections/edition/EditionMintLayout"
import { MintCollectionCTA } from "@/components/collections/MintCollectionCTA"
import { PreservationCard } from "@/components/collections/PreservationCard"
import { TokenMedia } from "@/components/token/TokenMedia"
import {
  getAttribution,
  getCollectionMintHistory,
  getContractDescription,
  getRendererCodeOnchain,
  getRendererTokenPreview,
  getRouterBatches,
  isBatchRenderRouter,
} from "@/lib/collection-onchain"
import { collectionMediaUrl, rendererMediaUrl } from "@/lib/collection-media-url"
import { isEscapeRenderer, ESCAPE_DESCRIPTION, ESCAPE_PIECE_TITLE } from "@/lib/escape-render"
import { gradePreservation, preservationOverride } from "@/lib/preservation"
import {
  PND_CHAIN_ID,
  REFERRAL_SHARE_BPS,
  ZERO_ADDRESS,
  evmNowAddressUrl,
  formatBps,
  sellsViaMinterOnly,
  shortAddress,
  type Collection,
} from "@/lib/collection"

/**
 * The edition collection layout: one artwork for every token, shown as the
 * hero (or a batch grid for a multi-batch release). Selected by the launch
 * descriptor's `layoutKind === "edition"`. Owns its own layout-specific
 * reads (the batch list + shared-artwork previews + the escape description
 * fallback), all cached, so the page component only loads shared data.
 */
export async function CollectionEditionLayout({
  addr,
  c,
  hasWork,
  hasCover,
  history,
  attribution,
}: {
  addr: Address
  c: Collection
  hasWork: boolean
  hasCover: boolean
  history: Awaited<ReturnType<typeof getCollectionMintHistory>>
  attribution: Awaited<ReturnType<typeof getAttribution>>
}) {
  // Batch view (docs/pnd-surface-second-launch.md): interface-driven — a
  // renderer that advertises IBatchRenderRouter lights up the batch grid.
  // One cached supportsInterface read, then (only when true) the router's
  // batch list plus one cached getRendererTokenPreview per batch.
  const isRouter = await isBatchRenderRouter(c.renderer)
  const batches = isRouter ? await getRouterBatches(c.renderer) : []
  const batchImages: Record<number, string> = {}
  let firstBatchArt: Awaited<ReturnType<typeof getRendererTokenPreview>> = null
  if (batches.length > 0) {
    const imgs = await Promise.all(batches.map((b) => getRendererTokenPreview(addr, c.renderer, b.startId)))
    batches.forEach((b, i) => {
      batchImages[b.index] = imgs[i]?.image
        ? rendererMediaUrl(addr, b.startId, imgs[i]!.image!)
        : ""
    })
    firstBatchArt = imgs[0] ?? null
  }

  // Sidebar description: the collection's own contractURI description, else
  // the mirrored escape blurb (its tokenURI, where the literal lives, cannot
  // be read). Null shows no blurb rather than inventing one.
  const contractDescription = await getContractDescription(addr)
  const isEscape = await isEscapeRenderer(c.renderer)
  const editionDescription = contractDescription ?? (isEscape ? ESCAPE_DESCRIPTION : null)
  const pieceTitle = isEscape ? ESCAPE_PIECE_TITLE : null

  // The number a collector reads as "the edition": the collection's cap when
  // it has one, otherwise the minter's ceiling (what bounds an open-supply
  // release run in batches). 0 when nothing bounds it.
  const minterCap = c.sale?.maxMints ?? 0n
  const editionSize =
    c.cfg.supplyCap > 0n && minterCap > 0n
      ? c.cfg.supplyCap < minterCap
        ? c.cfg.supplyCap
        : minterCap
      : c.cfg.supplyCap > 0n
        ? c.cfg.supplyCap
        : minterCap

  const pooled = sellsViaMinterOnly(c.cfg.idMode) || !c.primaryMinter

  const editionArtists = attribution.length > 0 ? attribution.map((a) => a.creator) : [c.owner]
  const sharedArt = batches.length > 0 ? firstBatchArt : await getRendererTokenPreview(addr, c.renderer, 1n)
  const sharedTokenId = batches[0]?.startId ?? 1n
  const sharedImage = sharedArt?.image
    ? rendererMediaUrl(addr, sharedTokenId, sharedArt.image)
    : ""
  const coverUrl = hasCover ? collectionMediaUrl(addr, c.cover) : ""
  const preservation = gradePreservation({
    rendererLocked: c.isRendererLocked,
    runtime: "unknown",
    codeOnchain: await getRendererCodeOnchain(c.renderer),
    hasCapture: null,
    hasCover,
    declared: preservationOverride(addr),
  })
  const editionHero =
    batches.length > 1 ? (
      <BatchGrid collection={addr} batches={batches} images={batchImages} />
    ) : sharedArt?.animationUrl || sharedArt?.image || hasCover ? (
      <TokenMedia
        imageUrl={hasCover ? coverUrl : sharedImage}
        animationUrl={sharedArt?.animationUrl ?? null}
        title={c.name}
      />
    ) : (
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        No artwork yet
      </p>
    )
  const addressLink = (a: Address) => (
    <a
      href={evmNowAddressUrl(a, PND_CHAIN_ID)}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-gray-300 underline-offset-2 hover:text-fg"
    >
      {shortAddress(a)}
    </a>
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
      description={editionDescription ? <p>{editionDescription}</p> : undefined}
      history={<CollectionMintHistory history={history} chainId={PND_CHAIN_ID} />}
      preservation={<PreservationCard grade={preservation} />}
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
