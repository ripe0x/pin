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
        {/* Preconnect so the .woff2 hits start as soon as the HTML lands —
            Fontshare serves the @font-face CSS, then redirects to
            cdn.fontshare.com for the actual font binaries. */}
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="" />
        <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
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
      {/* `suppressHydrationWarning` is necessary because browser extensions
          (Phantom, Kapture, MetaMask, etc.) commonly append classes/attributes
          to <body> before React hydrates. Without this, the className diff
          would bail out hydration on the entire client tree and the
          RainbowKit Connect button — which is a client component — would
          render briefly during SSR then disappear. */}
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <Providers>
          <Navbar />
          {/* pt mirrors PND's nav offset (logo row only — no search row here). */}
          <main className="pt-16">{children}</main>
        </Providers>
      </body>
    </html>
  )
}
