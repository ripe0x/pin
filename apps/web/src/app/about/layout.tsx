import type { Metadata } from "next"

const description =
  "Independent artist infrastructure for Ethereum. Artist owned auctions, contracts, and sites."

export const metadata: Metadata = {
  title: "About",
  description,
  openGraph: {
    title: "About",
    description,
    images: ["/opengraph-image"],
  },
  twitter: {
    card: "summary_large_image",
    title: "About",
    description,
    images: ["/opengraph-image"],
  },
}

export default function AboutLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
