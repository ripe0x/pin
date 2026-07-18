"use client"

/**
 * Curated full-page layouts for the mint surface — the third registry in the
 * mint-slots.tsx family. A collection that owns its entire page (Homage's
 * gallery wall) declares `customLayout: "<key>"` in its descriptor;
 * `/mint/[contract]` then delegates the whole page body to the component
 * registered here, still passing the standard server-fetched data (snapshot,
 * hero art, selector context) so the mint machinery works unchanged.
 * generateMetadata / OG are untouched by the delegation.
 *
 * Register with next/dynamic so each curated layout is its own client chunk —
 * the standard surface (Vouch) never downloads gallery code.
 *
 * Site chrome for these pages (transparent navbar, no footer, no pt-16) is
 * the separate, bundle-lean map in lib/curated-chrome.ts; its test asserts it
 * stays in sync with descriptors that set `customLayout`.
 */

import dynamic from "next/dynamic"
import type { ComponentType } from "react"
import type { MintSnapshot, TokenArt } from "@/lib/mint-onchain"

export type CuratedLayoutProps = {
  /** Slug or address — resolved against the registry client-side. */
  collectionId: string
  snapshot: MintSnapshot
  art: TokenArt | null
  /**
   * Server-fetched selector context (the same pass-through MintPanel's
   * `selectorData` gets — Vouch's seats; empty for Homage today).
   */
  selectorData?: unknown
}

const curatedLayouts = new Map<string, ComponentType<CuratedLayoutProps>>()

export function registerCuratedLayout(
  key: string,
  layout: ComponentType<CuratedLayoutProps>,
): void {
  curatedLayouts.set(key, layout)
}

/**
 * Renders the registered layout, or nothing when the key is unknown — same
 * soft-fail contract as LifecyclePanelSlot (a descriptor referencing an
 * unregistered layout doesn't crash the route).
 */
export function CuratedLayoutSlot({
  layoutKey,
  ...props
}: CuratedLayoutProps & { layoutKey: string }) {
  const Layout = curatedLayouts.get(layoutKey)
  if (!Layout) return null
  return <Layout {...props} />
}

// Homage's gallery-wall mint page — referenced by its descriptor via
// `customLayout: "homage-gallery"`. Dynamic import keeps the wall (and the
// punks-sdk render path behind it) out of every other route's bundle.
registerCuratedLayout(
  "homage-gallery",
  dynamic(() => import("./homage-gallery/HomageGalleryLayout")),
)
