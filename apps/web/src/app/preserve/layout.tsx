import type { Metadata } from "next"

const description =
  "Pin your collected and created NFTs to IPFS so the artwork stays available even if the original gateway disappears."

export const metadata: Metadata = {
  title: "Preserve",
  description,
  openGraph: {
    title: "Preserve",
    description,
    images: ["/opengraph-image"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Preserve",
    description,
    images: ["/opengraph-image"],
  },
}

export default function PreserveLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
