import type { Metadata } from "next"
import { AuctionNewClient } from "./AuctionNewClient"

export const metadata: Metadata = {
  title: "Start an auction",
  description: "List any ERC-721 you own through your sovereign auction house.",
}

export default function AuctionNewPage() {
  return <AuctionNewClient />
}
