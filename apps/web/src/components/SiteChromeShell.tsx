"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"
import { chromeForPath } from "@/lib/curated-chrome"

/**
 * Client wrappers that let curated immersive pages (curated-chrome.ts) drop
 * the default shell. usePathname() is available during SSR, so the variant
 * renders correctly on the server — no flash of the wrong chrome.
 */

/** <main> with the fixed-navbar offset, dropped on immersive pages. */
export function MainShell({ children }: { children: ReactNode }) {
  const { padTop } = chromeForPath(usePathname())
  return <main className={padTop ? "pt-16" : undefined}>{children}</main>
}

/**
 * Gates the site footer. The footer stays a server component — it crosses
 * this client boundary as `children`, so gating costs nothing server-side.
 */
export function FooterGate({ children }: { children: ReactNode }) {
  const { footer } = chromeForPath(usePathname())
  return footer ? <>{children}</> : null
}
