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
import { getHomageMintFeed, getHomageMintedIds } from "@/lib/homage/collection.server"
import { detectHomageMinter } from "@/lib/homage/detect.server"
import { getLayoutKindForCollection } from "@/lib/launch-descriptors"
import { PND_CHAIN_ID, ipfsToHttp } from "@/lib/collection"

/**
 * The Surface collection page: data loading plus a layout switch. The page
 * itself carries no presentation. Which layout renders is selected by data,
 * not a per-address branch (see AGENTS.md's note on the Homage anti-pattern):
 *
 *   1. explicit config: a launch descriptor's `layoutKind === "edition"`
 *      (launch-descriptors.ts) selects CollectionEditionLayout.
 *   2. interface / registry detection: the registered Homage collection
 *      (detectHomageMinter) renders the default layout in its terminal skin.
 *      Batch view within the edition layout is itself interface-driven
 *      (isBatchRenderRouter), inside CollectionEditionLayout.
 *   3. default: every other collection renders CollectionDefaultLayout.
 *
 * A new launch is a descriptor entry, not a component-tree edit — see the
 * field docs on LaunchDescriptor.
 */

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

  // Homage is a pooled collection driven by a bespoke HomageMinter — the
  // generic direct-sale path can't drive it, so the registered homage
  // collection (verified onchain) renders the default layout in its terminal
  // skin. `?skin=homage` forces the skin on for previewing on any collection.
  const homageMinter = await detectHomageMinter(addr, PND_CHAIN_ID)
  const homageSkin = !!homageMinter || skin === "homage"
  // Alt arrangement (?layout=mint-first): lifts the editorial band above the
  // field via CSS order.
  const mintFirst = homageSkin && layout === "mint-first"

  // Homage field: the minted set (indexer SELECT; chain scan only as
  // fallback). Fetched once and passed to both HomageMintLog mounts.
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

  // Layout selection: explicit descriptor config first, then the Homage skin,
  // then default. An edition-layout collection is never also homage-skinned.
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
