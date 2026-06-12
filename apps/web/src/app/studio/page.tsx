import type { Metadata } from "next"
import { StudioLanding } from "./StudioLanding"

const TITLE = "Studio"
const DESCRIPTION =
  "One place to manage your work: listings, your Sovereign auction house, your onchain catalog, and your artist site."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // The landing redirects connected wallets and the per-address studio
  // pages are owner workspaces — none of it is crawlable content.
  robots: { index: false, follow: false },
}

export default function StudioPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 space-y-8">
      <StudioLanding />
    </div>
  )
}
