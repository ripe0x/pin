import type {Metadata} from "next"
import {redirect} from "next/navigation"
import {isAddress} from "viem"
import {HomagePreview} from "@/components/collections/homage/HomagePreview"
// Terminal-skin tokens/fonts (homage-gallery.css) + the masthead mapping
// (homage-skin.css), the same pair the live /collections/[address] page imports.
import "@/components/mint/homage-gallery/homage-gallery.css"
import "../[address]/homage-skin.css"

/**
 * /collections/homage — the stable homage landing URL, shared before launch.
 *
 * Pre-deploy (NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS unset): this static segment
 * shadows the [address] dynamic route and renders the coming-soon landing with
 * zero RPC — there is no onchain collection to read.
 *
 * Post-launch (address set): a `beforeFiles` rewrite (next.config.ts) serves the
 * live /collections/<address> page AT this URL, so the shared link keeps working
 * and stays canonical (no redirect to the raw address). The redirect below is a
 * defensive fallback for the case the rewrite isn't applied; normally the rewrite
 * pre-empts this component post-deploy.
 */

const HOMAGE_COLLECTION_ADDRESS = process.env.NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS

const DESCRIPTION =
  "Ten thousand generative artworks, one for every CryptoPunk. Each is composed from the punk's onchain data and its live market state, rendered fully onchain. Every piece is backed by $111, redeemable at any time."

// opengraph-image.tsx in this segment supplies the og:image / twitter:image (1200×630);
// Next merges it into the tags below.
export const metadata: Metadata = {
  title: "Homage to the Punk",
  description: DESCRIPTION,
  openGraph: {
    title: "Homage to the Punk",
    description: DESCRIPTION,
    type: "website",
    siteName: "PND",
  },
  twitter: {
    card: "summary_large_image",
    title: "Homage to the Punk",
    description: DESCRIPTION,
  },
}

export default function HomageLandingPage() {
  if (HOMAGE_COLLECTION_ADDRESS && isAddress(HOMAGE_COLLECTION_ADDRESS)) {
    redirect(`/collections/${HOMAGE_COLLECTION_ADDRESS}`)
  }
  return (
    <div className="dark homage-terminal collection-homage-skin">
      <HomagePreview />
    </div>
  )
}
