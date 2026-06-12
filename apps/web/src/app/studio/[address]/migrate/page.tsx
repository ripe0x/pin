import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { MigratePanel } from "@/components/migrate/MigratePanel"

/**
 * Guided cancel-on-marketplace, relist-on-your-house flow (moved from
 * /artist/[address]/migrate, which now redirects here). Reached from
 * the studio listings tab and the StudioBar chip on the artist page.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export const metadata: Metadata = {
  title: "Migrate to Sovereign auction house",
  robots: { index: false, follow: false },
}

export default async function StudioMigratePage({
  params,
}: {
  params: Params
}) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!ADDRESS_RE.test(address)) notFound()

  return <MigratePanel artistAddress={address} />
}
