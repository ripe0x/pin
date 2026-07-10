import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { TokenStage } from "@/components/token/TokenStage"
import { CopyAddressButton } from "@/components/CopyAddressButton"
import { CollectionMintMarkCard } from "@/components/collections/CollectionMintMarkCard"
import { getCollection, getCollectionToken } from "@/lib/collection-onchain"
import { PND_CHAIN_ID, evmNowAddressUrl, ipfsToHttp, shortAddress } from "@/lib/collection"

type Params = Promise<{ address: string; tokenId: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address, tokenId } = await params
  if (!isAddress(address)) return { title: "Token" }
  const c = await getCollection(address as Address)
  const title = c ? `${c.name} #${tokenId}` : `Token #${tokenId}`
  const image = c ? ipfsToHttp(c.cover) : undefined
  return {
    title,
    openGraph: image ? { title, images: [{ url: image }] } : { title },
    twitter: { card: "summary_large_image", title },
  }
}

export default async function CollectionTokenPage({ params }: { params: Params }) {
  const { address, tokenId: tokenIdStr } = await params
  if (!isAddress(address)) notFound()
  const addr = address as Address
  let tokenId: bigint
  try {
    tokenId = BigInt(tokenIdStr)
  } catch {
    notFound()
  }

  const t = await getCollectionToken(addr, tokenId!)
  if (!t) notFound()
  const c = await getCollection(addr)
  if (!c) notFound()

  const id = tokenId!
  const prevId = id > 1n ? id - 1n : null
  const nextId = id < c.minted ? id + 1n : null
  const hasLiveDoc = !!t.animationUrl && t.animationUrl.startsWith("data:text/html")

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 dark:bg-bg p-8 lg:p-12">
          <TokenStage
            imageUrl={ipfsToHttp(t.image)}
            animationUrl={t.animationUrl ? ipfsToHttp(t.animationUrl) : null}
            title={`${c.name} #${id.toString()}`}
            liveHref={hasLiveDoc ? `/collections/${addr}/${id.toString()}/live` : null}
          />
        </div>

        <aside className="lg:border-l border-gray-200 px-6 py-8 lg:px-8 lg:py-10 space-y-5">
          <nav className="flex items-baseline justify-between gap-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <span>
              <Link href="/collections" className="underline hover:text-fg">
                Collections
              </Link>{" "}
              /{" "}
              <Link href={`/collections/${addr}`} className="underline hover:text-fg">
                {c.name}
              </Link>
            </span>
            <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
              {prevId !== null ? (
                <Link
                  href={`/collections/${addr}/${prevId.toString()}`}
                  className="underline hover:text-fg"
                >
                  ← #{prevId.toString()}
                </Link>
              ) : (
                <span className="text-gray-300 dark:text-gray-700">← first</span>
              )}
              {nextId !== null ? (
                <Link
                  href={`/collections/${addr}/${nextId.toString()}`}
                  className="underline hover:text-fg"
                >
                  #{nextId.toString()} →
                </Link>
              ) : (
                <span className="text-gray-300 dark:text-gray-700">latest →</span>
              )}
            </span>
          </nav>

          <header className="space-y-1">
            <h1 className="text-2xl font-medium tracking-tight">
              {c.name} <span className="text-gray-400">#{tokenId!.toString()}</span>
            </h1>
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              {t.owner ? (
                <>
                  Held by{" "}
                  <a
                    href={evmNowAddressUrl(t.owner, PND_CHAIN_ID)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-fg"
                  >
                    {shortAddress(t.owner)} ↗
                  </a>
                </>
              ) : (
                "Owner unknown"
              )}
            </p>
          </header>

          <CollectionMintMarkCard
            mintOrder={t.mintOrder}
            seed={null /* the dedicated Seed card below shows it in full */}
            status={c.status}
            minted={c.minted}
          />

          {t.seed && (
            <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100">
                <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                  Seed
                </span>
              </div>
              <div className="px-4 py-3 flex items-center gap-2">
                <span className="text-[11px] font-mono break-all text-fg-muted">{t.seed}</span>
                <CopyAddressButton address={t.seed} />
              </div>
            </div>
          )}

          <section className="pt-2 space-y-2 text-[11px] font-mono">
            <TokenFact label="Collection" value={c.name} />
            <TokenFact label="Standard" value="ERC721" />
            <TokenFact
              label="Renderer"
              value={c.isRendererLocked ? "Locked forever" : "Swappable by the artist"}
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
            <p className="pt-2 text-[10px] font-mono text-gray-400 leading-relaxed">
              The render is a pure function of chain state: this seed, this
              code, forever. No server keeps this artwork alive.
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}

function TokenFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-gray-400 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="tabular-nums text-right">{value}</span>
    </div>
  )
}
