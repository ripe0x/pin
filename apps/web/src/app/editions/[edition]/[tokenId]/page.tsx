import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { MintMarkCard } from "@/components/editions/MintMarkCard"
import { getEdition, getEditionToken } from "@/lib/editions-onchain"
import {
  PATH_TYPE_LABEL,
  PND_CHAIN_ID,
  PathType,
  RefKind,
  evmNowAddressUrl,
  ipfsToHttp,
  pndUrn,
  refToHref,
  shortAddress,
} from "@/lib/pnd-editions"

type Params = Promise<{ edition: string; tokenId: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { edition, tokenId } = await params
  if (!isAddress(edition)) return { title: "Token" }
  const e = await getEdition(edition as Address)
  const title = e ? `${e.name} #${tokenId}` : `Token #${tokenId}`
  const image = e ? ipfsToHttp(e.cfg.artworkURI) : undefined
  return {
    title,
    openGraph: image ? { title, images: [{ url: image }] } : { title },
    twitter: { card: "summary_large_image", title },
  }
}

export default async function TokenPage({ params }: { params: Params }) {
  const { edition, tokenId: tokenIdStr } = await params
  if (!isAddress(edition)) notFound()
  const addr = edition as Address
  let tokenId: bigint
  try {
    tokenId = BigInt(tokenIdStr)
  } catch {
    notFound()
  }

  const t = await getEditionToken(addr, tokenId!)
  if (!t || !t.edition) notFound()
  const e = t.edition

  const pathHref = t.path.pathType !== PathType.None ? refToHref(t.path.target) : null
  const pathUrn =
    t.path.pathType !== PathType.None
      ? pndUrn(
          t.path.target.chainId,
          t.path.target.contractAddress,
          t.path.target.kind === RefKind.Edition
            ? "e"
            : t.path.target.kind === RefKind.Token
              ? "t"
              : "x",
          t.path.target.id,
        )
      : null

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:py-12">
      <nav className="mb-6 text-[10px] font-mono uppercase tracking-wider text-gray-400">
        <Link href="/editions" className="underline hover:text-fg">
          Editions
        </Link>{" "}
        /{" "}
        <Link href={`/editions/${addr}`} className="underline hover:text-fg">
          {e.name}
        </Link>{" "}
        / #{tokenId!.toString()}
      </nav>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-10">
        <div className="md:sticky md:top-20 md:self-start">
          <div className="aspect-square w-full overflow-hidden rounded-lg border border-gray-200 bg-surface-muted">
            <OptimizedImage
              src={t.artwork}
              alt={`${e.name} #${tokenId!.toString()}`}
              width={1200}
              loading="eager"
              className="h-full w-full object-contain"
            />
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <header className="space-y-1">
            <h1 className="text-2xl font-medium tracking-tight">
              {e.name} <span className="text-gray-400">#{tokenId!.toString()}</span>
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

          <MintMarkCard mark={t.mark} chainId={PND_CHAIN_ID} />

          <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-100">
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                Token Path
              </span>
            </div>
            <div className="px-4 py-3 text-[11px] font-mono">
              {t.path.pathType === PathType.None ? (
                <p className="text-gray-400 leading-relaxed">
                  No forward path set. This token can be pointed at a
                  continuation, migration, claim, reveal, or burn later. The
                  pointer slot exists onchain today.
                </p>
              ) : (
                <p className="leading-relaxed">
                  <span className="px-2 py-1 mr-2 uppercase tracking-wider border border-gray-200 text-gray-600">
                    {PATH_TYPE_LABEL[t.path.pathType]}
                  </span>
                  <span className="text-gray-400">→ </span>
                  {pathHref ? (
                    <Link href={pathHref} className="underline hover:text-fg break-all">
                      {pathUrn}
                    </Link>
                  ) : (
                    <span className="break-all text-gray-500">{pathUrn}</span>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
