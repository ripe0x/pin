import type { Metadata } from "next"

const description =
  "Mint a new token whose media is preserved on-chain: multiple fallback links plus an integrity hash, so the artwork stays verifiable even if a source goes offline."

export const metadata: Metadata = {
  title: "Preserve on-chain",
  description,
  openGraph: {
    title: "Preserve on-chain",
    description,
    images: ["/opengraph-image"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Preserve on-chain",
    description,
    images: ["/opengraph-image"],
  },
}

export default function MuriLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
