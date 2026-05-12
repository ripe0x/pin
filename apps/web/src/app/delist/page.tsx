import type { Metadata } from "next"
import { Suspense } from "react"
import { resolveEnsAddress } from "@/lib/artist-queries"
import { DelistClient } from "./DelistClient"

const TITLE = "Delist from platforms"
const DESCRIPTION =
  "Cancel your active Foundation and SuperRare listings in one transaction. Gas only, no fees, nothing routes through this site."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

async function resolveInput(raw: string | undefined): Promise<string | null> {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (ADDRESS_RE.test(trimmed)) return trimmed
  const resolved = await resolveEnsAddress(trimmed)
  return resolved ?? null
}

type SearchParams = Promise<{ address?: string }>

export default async function DelistPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const { address: raw } = await searchParams
  const resolved = await resolveInput(raw)

  return (
    <Suspense>
      <DelistClient initialAddress={resolved} initialInput={raw ?? ""} />
    </Suspense>
  )
}
