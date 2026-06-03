import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { MintEditionCTA } from "@/components/editions/MintEditionCTA"
import { WithdrawPanel } from "@/components/editions/WithdrawPanel"
import { MintHistory } from "@/components/editions/MintHistory"
import { EditionGraphView } from "@/components/editions/EditionGraphView"
import { MuriAnchorPanel } from "@/components/editions/MuriAnchorPanel"
import { getEdition, getEditionEdges, getEditionMintHistory } from "@/lib/editions-onchain"
import {
  EDITION_KIND_LABEL,
  PND_CHAIN_ID,
  SURFACE_SHARE_BPS,
  ZERO_ADDRESS,
  evmNowAddressUrl,
  formatBps,
  ipfsToHttp,
  shortAddress,
} from "@/lib/pnd-editions"

type Params = Promise<{ edition: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { edition } = await params
  if (!isAddress(edition)) return { title: "Edition" }
  const e = await getEdition(edition as Address)
  if (!e) return { title: "Edition" }
  const image = ipfsToHttp(e.cfg.artworkURI)
  return {
    title: e.name,
    openGraph: image ? { title: e.name, images: [{ url: image }] } : { title: e.name },
    twitter: { card: "summary_large_image", title: e.name },
  }
}

export default async function EditionPage({ params }: { params: Params }) {
  const { edition } = await params
  if (!isAddress(edition)) notFound()
  const addr = edition as Address
  const e = await getEdition(addr)
  if (!e) notFound()
  const [edges, history] = await Promise.all([
    getEditionEdges(addr),
    getEditionMintHistory(addr, e.minted),
  ])

  const mutability = e.isSealed ? "Sealed (no upgrades)" : "Upgradeable by the artist"
  const metadataState = e.isMetadataFrozen ? "Frozen" : "Mutable by the artist"
  // Mirrors PNDEditions.isPermanent(): art is permanent only when the contract
  // is sealed (no upgrades) AND metadata is frozen. Freezing alone is not
  // permanence, an unsealed owner could still upgrade to change the art.
  const permanent = e.isSealed && e.isMetadataFrozen

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        {/* Artwork: full-bleed gray field, sticky on desktop. */}
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 dark:bg-bg p-8 lg:p-12">
          <OptimizedImage
            src={e.cfg.artworkURI}
            alt={e.name}
            width={1200}
            loading="eager"
            className="max-h-[78vh] max-w-full object-contain"
          />
        </div>

        {/* Sidebar */}
        <aside className="lg:border-l border-gray-200 px-6 py-8 lg:px-8 lg:py-10">
          <nav className="mb-4 text-[10px] font-mono uppercase tracking-wider text-gray-400">
            <Link href="/editions" className="underline hover:text-fg">
              Editions
            </Link>
          </nav>

          <header className="pb-5 border-b border-gray-100 space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{e.name}</h1>
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              {e.symbol} · {EDITION_KIND_LABEL[e.cfg.kind]}
            </p>
          </header>

          <MintEditionCTA
            edition={addr}
            snapshot={{
              price: e.cfg.price.toString(),
              supplyCap: e.cfg.supplyCap.toString(),
              mintStart: e.cfg.mintStart.toString(),
              mintEnd: e.cfg.mintEnd.toString(),
              minted: e.minted.toString(),
              status: e.status,
            }}
          />

          <WithdrawPanel edition={addr} />

          <MintHistory entries={history} chainId={PND_CHAIN_ID} />

          <EditionGraphView edges={edges} />

          <section className="py-5 border-b border-gray-100 space-y-2 text-[11px] font-mono">
            <Fact label="Contract" value={shortAddress(addr)} />
            <Fact label="Standard" value="ERC721 (ERC721A)" />
            <Fact label="Mutability" value={mutability} />
            <Fact label="Metadata" value={metadataState} />
            <Fact label="Permanence" value={permanent ? "Permanent" : "Not yet permanent"} />
            <Fact
              label="Royalty"
              value={e.cfg.royaltyBps > 0 ? formatBps(e.cfg.royaltyBps) : "none"}
            />
            <Fact
              label="Surface share"
              value={`${formatBps(SURFACE_SHARE_BPS)} (to the mint surface)`}
            />
            <Fact
              label="Payout"
              value={
                e.cfg.payoutAddress === ZERO_ADDRESS
                  ? shortAddress(e.owner)
                  : shortAddress(e.cfg.payoutAddress)
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
                Permanent: the contract is sealed (no further upgrades) and metadata is
                frozen, so the artwork and code cannot change.
              </p>
            ) : (
              <p className="pt-2 text-[10px] font-mono text-gray-400 normal-case leading-relaxed">
                {!e.isSealed ? "The artist can upgrade this contract until they seal it. " : ""}
                {!e.isMetadataFrozen ? "Artwork can change until the artist freezes metadata." : ""}
              </p>
            )}
          </section>

          <MuriAnchorPanel
            edition={addr}
            owner={e.owner}
            currentRenderer={e.cfg.renderer}
            artworkURI={e.cfg.artworkURI}
            editionName={e.name}
          />

          <section className="pt-5">
            <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-2">
              Self host this mint
            </h2>
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              This edition is your own contract and can be minted from any
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
