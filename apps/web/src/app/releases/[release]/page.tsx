import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isAddress, type Address } from "viem"
import { MintReleaseCTA } from "@/components/releases/MintReleaseCTA"
import { ReleaseAdminPanel } from "@/components/releases/ReleaseAdminPanel"
import {
  getRecentTokenOwners,
  getRelease,
  getReleaseImage,
} from "@/lib/releases-onchain"
import {
  GATE_MODE_LABELS,
  GateMode,
  ZERO_ADDRESS,
  evmNowAddressUrl,
  formatPriceLabel,
  shortAddress,
  toSnapshot,
} from "@/lib/releases"

type Params = Promise<{ release: string }>

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { release } = await params
  if (!isAddress(release)) return { title: "Release" }
  const r = await getRelease(release as Address)
  if (!r) return { title: "Release" }
  const meta = await getReleaseImage(r.uri, r.uriPerToken)
  return {
    title: r.name,
    description: meta.description ?? undefined,
    openGraph: meta.image
      ? { title: r.name, images: [{ url: meta.image }] }
      : { title: r.name },
    twitter: { card: "summary_large_image", title: r.name },
  }
}

function formatWindow(startTime: string, endTime: string): string {
  const start = Number(startTime)
  const end = Number(endTime)
  const fmt = (s: number) =>
    new Date(s * 1000).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    })
  const from = start === 0 ? "deploy" : fmt(start)
  return end === 0 ? `${from} until closed` : `${from} to ${fmt(end)}`
}

export default async function ReleasePage({ params }: { params: Params }) {
  const { release } = await params
  if (!isAddress(release)) notFound()
  const addr = release as Address

  const r = await getRelease(addr)
  if (!r) notFound()

  const [meta, owners] = await Promise.all([
    getReleaseImage(r.uri, r.uriPerToken),
    getRecentTokenOwners(addr, BigInt(r.totalMinted), 12),
  ])

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:py-16 space-y-8">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        <Link href="/releases" className="hover:text-fg transition-colors">
          Releases
        </Link>{" "}
        / {shortAddress(addr)}
      </p>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[2fr_1fr]">
        {/* Artwork + identity */}
        <div className="space-y-6">
          {meta.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={meta.image}
              alt={r.name}
              className="w-full rounded-lg border border-gray-200 bg-surface-muted object-contain"
            />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-gray-200 bg-surface-muted">
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                No preview
              </span>
            </div>
          )}

          <header className="space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{r.name}</h1>
            <p className="text-[11px] font-mono text-gray-500">
              {r.symbol} · by{" "}
              <a
                href={evmNowAddressUrl(r.artist)}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-gray-300 hover:decoration-gray-500"
              >
                {shortAddress(r.artist)}
              </a>
            </p>
            {meta.description && (
              <p className="max-w-xl text-sm leading-relaxed text-fg-muted">
                {meta.description}
              </p>
            )}
          </header>

          {/* The terms, as fixed in bytecode */}
          <section className="space-y-2">
            <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              Terms (fixed at deploy)
            </h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[11px] font-mono text-gray-600 sm:grid-cols-2">
              <div className="flex justify-between gap-3">
                <dt className="text-gray-400">Price</dt>
                <dd>{formatPriceLabel(BigInt(r.price))}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-400">Supply</dt>
                <dd>
                  {BigInt(r.maxSupply) === 0n
                    ? "Open (window decides)"
                    : r.maxSupply}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-400">Window</dt>
                <dd className="text-right">
                  {formatWindow(r.startTime, r.endTime)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-400">Royalty</dt>
                <dd>{(r.royaltyBps / 100).toFixed(1).replace(/\.0$/, "")}%</dd>
              </div>
              {r.gateMode !== GateMode.None && (
                <div className="flex justify-between gap-3 sm:col-span-2">
                  <dt className="text-gray-400">
                    {GATE_MODE_LABELS[r.gateMode]}
                  </dt>
                  <dd>
                    <a
                      href={evmNowAddressUrl(r.gateToken)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-gray-300 hover:decoration-gray-500"
                    >
                      {shortAddress(r.gateToken)}
                    </a>
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-3 sm:col-span-2">
                <dt className="text-gray-400">Contract</dt>
                <dd>
                  <a
                    href={evmNowAddressUrl(addr)}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-gray-300 hover:decoration-gray-500"
                  >
                    {addr}
                  </a>
                </dd>
              </div>
            </dl>
            <p className="text-[10px] font-mono leading-relaxed text-gray-400">
              The artist owns this contract outright
              {r.metadataFrozen ? "; metadata is frozen forever" : ""}. It
              keeps working even if this page disappears.
            </p>
          </section>

          {/* Recent tokens */}
          {owners.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Recent tokens
              </h2>
              <ul className="space-y-1 text-[11px] font-mono text-gray-600">
                {owners.map((t) => (
                  <li key={t.tokenId} className="flex justify-between gap-3">
                    <Link
                      href={`/releases/${addr}/${t.tokenId}`}
                      className="hover:text-fg transition-colors"
                    >
                      #{t.tokenId}
                    </Link>
                    <span className={t.owner ? "" : "text-gray-400"}>
                      {t.owner ? shortAddress(t.owner) : "burned"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Mint + admin sidebar */}
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <MintReleaseCTA
            release={addr}
            snapshot={toSnapshot(r)}
            initialStatus={r.status}
          />
          <ReleaseAdminPanel
            release={addr}
            owner={r.owner}
            payout={r.payout}
            artistBalance={r.artistBalance}
            closed={r.closed}
            metadataFrozen={r.metadataFrozen}
          />
          {BigInt(r.surfaceFee) > 0n && BigInt(r.price) > 0n && (
            <p className="px-1 text-[10px] font-mono leading-relaxed text-gray-400">
              Minting here adds a flat fee per token that goes to PND for
              serving the mint. Mint straight from the contract and you pay
              the artist&apos;s price only. The artist gets{" "}
              {formatPriceLabel(BigInt(r.price))} per token either way.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
