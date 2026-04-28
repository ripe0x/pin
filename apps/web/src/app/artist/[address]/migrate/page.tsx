import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { resolveEnsAddress } from "@/lib/artist-queries"
import { MigratePanel } from "@/components/migrate/MigratePanel"

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

async function resolveParam(raw: string): Promise<string | null> {
  const decoded = decodeURIComponent(raw)
  if (ADDRESS_RE.test(decoded)) return decoded
  const resolved = await resolveEnsAddress(decoded)
  return resolved ?? null
}

export const metadata: Metadata = {
  title: "Migrate to Sovereign auction house",
}

export default async function MigratePage({ params }: { params: Params }) {
  const { address: raw } = await params
  const decoded = decodeURIComponent(raw)
  const address = await resolveParam(raw)

  if (!address) {
    return (
      <div className="mx-auto max-w-[2000px] px-6 py-12 text-center">
        <h1 className="text-2xl font-semibold">Not Found</h1>
        <p className="text-gray-500 mt-2">
          Could not resolve &ldquo;{decoded}&rdquo; to an Ethereum address.
        </p>
      </div>
    )
  }

  if (!ADDRESS_RE.test(decoded)) {
    redirect(`/artist/${address}/migrate`)
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <MigratePanel artistAddress={address} />
    </div>
  )
}
