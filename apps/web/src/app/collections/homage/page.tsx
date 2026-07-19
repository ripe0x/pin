import type {Metadata} from "next"
import {redirect} from "next/navigation"
import {isAddress} from "viem"
import {HomagePreview} from "@/components/collections/homage/HomagePreview"
// Terminal-skin tokens/fonts (homage-gallery.css) + the masthead mapping
// (homage-skin.css), the same pair the live /collections/[address] page imports.
import "@/components/mint/homage-gallery/homage-gallery.css"
import "../[address]/homage-skin.css"

/**
 * /collections/homage — the stable homage landing URL. This static segment
 * shadows the [address] dynamic route (Next resolves static before dynamic), so
 * it serves the homage page whether or not a mainnet collection exists yet.
 *
 * Pre-deploy (NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS unset): render the coming-soon
 * landing with zero RPC — there is no onchain collection to read.
 *
 * Post-launch (address set): redirect to /collections/<address>, which detects
 * the homage minter onchain and renders the same terminal skin. Launch is the env
 * flip; this route stays as the permanent entry point rather than being deleted.
 */

const HOMAGE_COLLECTION_ADDRESS = process.env.NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS

export const metadata: Metadata = {
  title: "Homage to the Punk",
  openGraph: {title: "Homage to the Punk"},
  twitter: {card: "summary_large_image", title: "Homage to the Punk"},
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
