import Link from "next/link"
import { notFound } from "next/navigation"
import { SitePanel } from "@/components/sites/SitePanel"

/**
 * The artist's self-hosted site: live-site link when the ENS `url`
 * record is set, otherwise the Vercel/Netlify deploy buttons. The
 * panel is the same component that used to sit on the artist page.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export default async function StudioSitePage({
  params,
}: {
  params: Params
}) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  if (!ADDRESS_RE.test(address)) notFound()

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">Artist site</h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          A standalone site you own, built from the open-source template.
          It reads your Sovereign auction house straight from the chain —
          no backend, no platform.
        </p>
      </header>

      <SitePanel artistAddress={address} />

      <p className="text-xs text-gray-500">
        <Link
          href="/sites"
          className="underline underline-offset-4 hover:text-fg transition-colors"
        >
          About the template →
        </Link>
      </p>
    </div>
  )
}
