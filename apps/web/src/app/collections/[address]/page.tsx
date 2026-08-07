import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { CollectionDefaultLayout } from "@/components/collections/CollectionDefaultLayout"
import { CollectionEditionLayout } from "@/components/collections/CollectionEditionLayout"
import {
  getAttribution,
  getCollection,
  getCollectionMintHistory,
  getRecentTokenMarks,
} from "@/lib/collection-onchain"
import { collectionMediaUrl } from "@/lib/collection-media-url"
import { getHomageMintFeed, getHomageMintedIds } from "@/lib/homage/collection.server"
import { detectHomageMinter } from "@/lib/homage/detect.server"
import { getLayoutKindForCollection } from "@/lib/launch-descriptors"
import { PND_CHAIN_ID } from "@/lib/collection"

/**
 * The Surface collection page is data loading plus a layout switch. Which
 * layout renders is selected by a launch descriptor, interface detection,
 * or the generic default, never by copying the page for one collection.
 */
type Params = Promise<{ address: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address } = await params
  if (!isAddress(address)) return { title: "Collection" }
  const c = await getCollection(address as Address)
  if (!c) return { title: "Collection" }
  const image = c.cover ? collectionMediaUrl(address, c.cover) : ""
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

  const homageMinter = await detectHomageMinter(addr, PND_CHAIN_ID)
  const homageSkin = !!homageMinter || skin === "homage"
  const mintFirst = homageSkin && layout === "mint-first"

  const [homageMintedIds, homageMintFeed] = homageSkin
    ? await Promise.all([getHomageMintedIds(addr), getHomageMintFeed(addr)])
    : [[], []]
  const [history, attribution, recent] = await Promise.all([
    getCollectionMintHistory(addr, c.minted, c.cfg.idMode),
    getAttribution(addr),
    getRecentTokenMarks(addr, c.minted, c.cfg.idMode),
  ])

  const hasCover = c.cover.length > 0
  const hasWork = c.work.code.length > 0
  const layoutKind = getLayoutKindForCollection(addr)
  if (!homageSkin && layoutKind === "edition") {
    return (
      <CollectionEditionLayout
        addr={addr}
        c={c}
        hasWork={hasWork}
        hasCover={hasCover}
        history={history}
        attribution={attribution}
      />
    )
  }

  return (
    <CollectionDefaultLayout
      addr={addr}
      c={c}
      homageSkin={homageSkin}
      mintFirst={mintFirst}
      homageMinter={homageMinter}
      homageMintedIds={homageMintedIds}
      homageMintFeed={homageMintFeed}
      hasWork={hasWork}
      hasCover={hasCover}
      history={history}
      attribution={attribution}
      recent={recent}
    />
  )
}
