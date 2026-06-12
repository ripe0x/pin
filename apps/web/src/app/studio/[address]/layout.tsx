import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { getArtistIdentity, resolveEnsAddress } from "@/lib/artist-queries"
import { AddressZorb } from "@/components/AddressZorb"
import { CopyAddressButton } from "@/components/CopyAddressButton"
import { StudioNav } from "@/components/studio/StudioNav"
import { OwnerGate } from "@/components/studio/OwnerGate"

/**
 * The studio shell: identity header + registry-driven tool nav around
 * every /studio/[address]/* page. The whole tree is noindex (see also
 * the /studio disallow in app/robots.ts) — these are owner workspaces,
 * not crawlable content, and keeping bots out is part of the
 * crawl-cost budget.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

async function resolveParam(raw: string): Promise<string | null> {
  const decoded = decodeURIComponent(raw)
  if (ADDRESS_RE.test(decoded)) return decoded
  const resolved = await resolveEnsAddress(decoded)
  return resolved ?? null
}

export const metadata: Metadata = {
  title: "Studio",
  robots: { index: false, follow: false },
}

export default async function StudioLayout({
  params,
  children,
}: {
  params: Params
  children: React.ReactNode
}) {
  const { address: raw } = await params
  const decoded = decodeURIComponent(raw)
  const address = await resolveParam(raw)

  if (!address) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-12 text-center">
        <h1 className="text-2xl font-semibold">Not Found</h1>
        <p className="text-gray-500 mt-2">
          Could not resolve &ldquo;{decoded}&rdquo; to an Ethereum address.
        </p>
      </div>
    )
  }

  // ENS slugs and checksummed paths normalize to the canonical
  // lowercase 0x URL, same as /artist and /catalog.
  if (decoded !== address.toLowerCase()) {
    redirect(`/studio/${address.toLowerCase()}`)
  }

  const identity = await getArtistIdentity(address)

  return (
    <div className="mx-auto max-w-5xl px-6 py-12 space-y-8">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          {identity.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={identity.avatarUrl}
              alt={identity.displayName}
              className="h-12 w-12 shrink-0 rounded-full object-cover"
            />
          ) : (
            <AddressZorb
              address={address}
              className="h-12 w-12 shrink-0 rounded-full"
            />
          )}
          <div className="min-w-0 space-y-0.5">
            <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
              Studio
            </p>
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-base font-mono font-medium tracking-tight truncate">
                {identity.displayName}
              </h1>
              <CopyAddressButton address={address} />
            </div>
          </div>
        </div>
        <Link
          href={`/artist/${address.toLowerCase()}`}
          className="shrink-0 text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
        >
          View public page →
        </Link>
      </header>

      <div className="md:grid md:grid-cols-[10rem_1fr] md:gap-10 space-y-6 md:space-y-0">
        <StudioNav address={address} />
        <div className="min-w-0">
          <OwnerGate address={address} displayName={identity.displayName}>
            {children}
          </OwnerGate>
        </div>
      </div>
    </div>
  )
}
