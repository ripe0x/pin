import type { Metadata } from "next"
import { Providers } from "./providers"
import { getConfig } from "@/lib/config"
import { getArtistDisplayName } from "@/lib/artist"
import "./globals.css"

export async function generateMetadata(): Promise<Metadata> {
  const cfg = getConfig()
  const name = await getArtistDisplayName()
  const description =
    cfg.artistBio ?? `Live and past on-chain auctions by ${name}.`
  return {
    title: {
      default: `${name} — Auctions`,
      template: `%s — ${name}`,
    },
    description,
    openGraph: {
      type: "website",
      title: `${name} — Auctions`,
      description,
      siteName: name,
    },
    twitter: {
      card: "summary_large_image",
      title: `${name} — Auctions`,
      description,
    },
  }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
