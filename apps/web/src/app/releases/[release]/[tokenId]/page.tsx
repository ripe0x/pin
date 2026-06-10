import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import {
  getRelease,
  getReleaseImage,
  getReleaseToken,
} from "@/lib/releases-onchain"
import {
  evmNowAddressUrl,
  evmNowTokenUrl,
  shortAddress,
} from "@/lib/releases"

type Params = Promise<{ release: string; tokenId: string }>

function parseTokenId(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null
  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { release, tokenId } = await params
  if (!isAddress(release) || parseTokenId(tokenId) === null) {
    return { title: "Token" }
  }
  const r = await getRelease(release as Address)
  if (!r) return { title: "Token" }
  return { title: `${r.name} #${tokenId}` }
}

export default async function ReleaseTokenPage({
  params,
}: {
  params: Params
}) {
  const { release, tokenId } = await params
  if (!isAddress(release)) notFound()
  const id = parseTokenId(tokenId)
  if (id === null) notFound()
  const addr = release as Address

  const [r, token] = await Promise.all([
    getRelease(addr),
    getReleaseToken(addr, id),
  ])
  if (!r || !token) notFound()

  const meta = await getReleaseImage(r.uri, r.uriPerToken)

  return (
    <div className="mx-auto max-w-xl px-4 py-10 md:py-16 space-y-6">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        <Link href="/releases" className="hover:text-fg transition-colors">
          Releases
        </Link>{" "}
        /{" "}
        <Link
          href={`/releases/${addr}`}
          className="hover:text-fg transition-colors"
        >
          {r.name}
        </Link>{" "}
        / #{token.tokenId}
      </p>

      {meta.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={meta.image}
          alt={`${r.name} #${token.tokenId}`}
          className="w-full rounded-lg border border-gray-200 bg-surface-muted object-contain"
        />
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-gray-200 bg-surface-muted">
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            No preview
          </span>
        </div>
      )}

      <header className="space-y-1">
        <h1 className="text-xl font-medium tracking-tight">
          {r.name} #{token.tokenId}
        </h1>
        <p className="text-[11px] font-mono text-gray-500">
          {token.owner ? (
            <>
              held by{" "}
              <a
                href={evmNowAddressUrl(token.owner)}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-gray-300 hover:decoration-gray-500"
              >
                {shortAddress(token.owner)}
              </a>
            </>
          ) : (
            "burned"
          )}
        </p>
      </header>

      <dl className="space-y-1.5 text-[11px] font-mono text-gray-600">
        <div className="flex justify-between gap-3">
          <dt className="text-gray-400">Contract</dt>
          <dd>
            <a
              href={evmNowTokenUrl(addr)}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-gray-300 hover:decoration-gray-500"
            >
              {shortAddress(addr)}
            </a>
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-400">Artist</dt>
          <dd>
            <a
              href={evmNowAddressUrl(r.artist)}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-gray-300 hover:decoration-gray-500"
            >
              {shortAddress(r.artist)}
            </a>
          </dd>
        </div>
        {token.tokenURI && (
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">Token URI</dt>
            <dd className="max-w-[60%] truncate" title={token.tokenURI}>
              {token.tokenURI}
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}
