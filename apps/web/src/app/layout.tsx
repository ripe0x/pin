import type { Metadata } from "next"
import Script from "next/script"
import { SITE_TITLE, SITE_DESCRIPTION, SITE_URL } from "@pin/shared"
import { Providers } from "@/components/Providers"
import { Navbar } from "@/components/Navbar"
import { Footer } from "@/components/Footer"
import "./globals.css"

const PLAUSIBLE_DOMAIN = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: `%s | ${SITE_TITLE}`,
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
    url: SITE_URL,
    siteName: SITE_TITLE,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Switzer from Fontshare — closest free match to Suisse Int'l */}
        <link
          href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600&display=swap"
          rel="stylesheet"
        />
        {/* IBM Plex Mono for prices / technical text */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {PLAUSIBLE_DOMAIN ? (
          <Script
            src="https://plausible.io/js/script.js"
            data-domain={PLAUSIBLE_DOMAIN}
            strategy="afterInteractive"
          />
        ) : null}
      </head>
      {/* `suppressHydrationWarning` guards against browser extensions
          (Phantom, MetaMask, Kapture, etc.) appending classes/attributes to
          <body> before React hydrates. Without it, the resulting className
          mismatch bails out hydration on the entire client tree, which
          breaks any client component below — most visibly the RainbowKit
          Connect button (renders during SSR, then disappears). */}
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <Providers>
          <Navbar />
          {/* pt clears the fixed navbar: a 64px nav row on every viewport,
              plus the mobile-only search row that stacks below it. */}
          <main className="pt-28 md:pt-16">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  )
}
