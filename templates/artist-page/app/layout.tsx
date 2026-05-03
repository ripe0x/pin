import type { Metadata } from "next"
import { Providers } from "./providers"
import { getConfig } from "@/lib/config"
import { getArtistDisplayName } from "@/lib/artist"
import { Navbar } from "@/components/Navbar"
import "./globals.css"

export async function generateMetadata(): Promise<Metadata> {
  const cfg = getConfig()
  const name = await getArtistDisplayName()
  const description =
    cfg.artistBio ?? `Live and past on-chain auctions by ${name}.`
  return {
    title: {
      default: `${name} — Auctions`,
      template: `%s | ${name}`,
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
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Switzer from Fontshare — primary sans face. */}
        <link
          href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600&display=swap"
          rel="stylesheet"
        />
        {/* IBM Plex Mono for prices / technical text. */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>
          <Navbar />
          {/* pt mirrors PND's nav offset (logo row only — no search row here). */}
          <main className="pt-16">{children}</main>
        </Providers>
      </body>
    </html>
  )
}
