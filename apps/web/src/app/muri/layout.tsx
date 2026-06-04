import type { Metadata } from "next"

const description =
  "Mint a new token whose media is preserved onchain: multiple fallback links plus an integrity hash, so the artwork stays verifiable even if a source goes offline."

export const metadata: Metadata = {
  title: "Preserve onchain",
  description,
  openGraph: {
    title: "Preserve onchain",
    description,
    images: ["/opengraph-image"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Preserve onchain",
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
