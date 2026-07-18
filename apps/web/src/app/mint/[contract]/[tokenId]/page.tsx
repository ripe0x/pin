import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { OnchainArt } from "@/components/mint/OnchainArt"
import { LifecyclePanelSlot } from "@/components/mint/mint-slots"
import { TokenAttributes } from "@/components/mint/TokenAttributes"
import { MetadataDrawer } from "@/components/mint/MetadataDrawer"
import { HomageProvenance } from "@/components/mint/HomageProvenance"
import { getMintSnapshot, getPieceToken } from "@/lib/mint-onchain"
import { getHomageProvenance, type HomageActivityEntry } from "@/lib/homage-queries"
import { resolveMintCollection } from "@/lib/mint-collections"
import { evmNowAddressUrl, shortAddress } from "@/lib/collection"

type Params = Promise<{ contract: string; tokenId: string }>

// Token id 0 is legitimate (Homage: tokenId == punkId, ids run 0..9999); a
// collection with no token 0 (Vouch) just fails the read and 404s as before.
function parseTokenId(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null
  return BigInt(raw)
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { contract, tokenId } = await params
  const desc = resolveMintCollection(contract)
  const id = parseTokenId(tokenId)
  if (!desc || id === null) return { title: "Token" }
  const piece = await getPieceToken(desc, id)
  const title = piece?.name ?? `${desc.name} #${tokenId}`
  return { title, twitter: { card: "summary_large_image", title } }
}

export default async function MintPiecePage({ params }: { params: Params }) {
  const { contract, tokenId } = await params
  const desc = resolveMintCollection(contract)
  if (!desc) notFound()
  const id = parseTokenId(tokenId)
  if (id === null) notFound()

  // Provenance is descriptor-driven (`provenanceSource`), never hardcoded to a
  // slug; it reads from the indexer and degrades to `[]` (section omitted) when
  // the tables don't exist yet — so this branch ships before the contract does.
  const [piece, snapshot, provenance] = await Promise.all([
    getPieceToken(desc, id),
    getMintSnapshot(desc),
    desc.provenanceSource === "homage"
      ? getHomageProvenance(desc.address, id.toString())
      : Promise.resolve([] as HomageActivityEntry[]),
  ])
  if (!piece) notFound()

  const title = piece.name ?? `${desc.name} #${tokenId}`
  const pieceAspect = desc.pieceAspect ?? "1 / 1"

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        {/* Artwork */}
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 dark:bg-bg p-6 lg:p-10">
          <OnchainArt
            imageUrl={piece.imageUrl}
            animationUrl={piece.animationUrl}
            title={title}
            className="h-[64vh] max-h-[78vh] w-auto"
            aspectRatio={pieceAspect}
          />
        </div>

        {/* Sidebar */}
        <aside className="lg:border-l border-gray-200 px-6 py-8 lg:px-8 lg:py-10">
          <nav className="mb-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <Link href={`/mint/${contract}`} className="underline hover:text-fg">
              ← {desc.name}
            </Link>
          </nav>

          <header className="pb-5 border-b border-gray-100 space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
            {piece.description && (
              <p className="text-[11px] font-mono text-gray-500 leading-relaxed">{piece.description}</p>
            )}
          </header>

          {/* Per-collection lifecycle panel (2.6): rendered from the registry
              keyed by the descriptor, not hardcoded to Vouch's seat shape. */}
          {desc.lifecyclePanel && (
            <LifecyclePanelSlot
              panelKey={desc.lifecyclePanel}
              collectionId={contract}
              tokenId={piece.tokenId}
              owner={piece.owner}
              active={piece.active}
              expiresAt={piece.expiresAt}
              freshnessBps={piece.freshnessBps}
              priceWei={snapshot.priceWei}
            />
          )}

          <TokenAttributes metadata={piece.metadata} />

          {/* Indexer-backed provenance timeline (mint phase, transfers,
              redeems, re-mints). Renders nothing until indexing is live. */}
          <HomageProvenance entries={provenance} />

          <section className="py-5 border-b border-gray-100 space-y-2 text-[11px] font-mono">
            <Fact label={`${desc.tokenNoun} #`} value={String(piece.tokenId)} />
            <Fact label="Owner" value={piece.owner ? shortAddress(piece.owner) : "—"} />
            {/* The NFT contract this token lives on — Homage's separate pooled
                collection, not the mint engine `desc.address` resolves to. */}
            <Fact label="Contract" value={shortAddress(desc.tokenContract?.address ?? desc.address)} />
            <Fact label="Art" value="Fully onchain" />
            <div className="pt-1">
              <a
                href={evmNowAddressUrl(desc.tokenContract?.address ?? desc.address, desc.chainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] uppercase tracking-wider text-gray-400 underline hover:text-fg"
              >
                View contract ↗
              </a>
            </div>
          </section>

          <MetadataDrawer rawTokenUri={piece.rawTokenUri} metadata={piece.metadata} />
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
