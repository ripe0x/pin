/**
 * The Preservation card's fact model (issue #265): verifiable facts in,
 * short plain-language facts out. Pure (no server-only imports) so the
 * whole matrix is unit-testable.
 *
 * A fact list, not a grade: every line is a fact a collector can check
 * onchain or in the token's metadata, and nothing claims more than the
 * facts support. In particular "onchain" is only said of a part that is a
 * data: URI the contract returned; an IPFS, Arweave or web-server URL is
 * named as exactly that.
 *
 * Inputs come from reads the collection and token pages already make
 * (getCollection's cached multicall, the renderer's tokenURI preview, the
 * indexed MURI tables). Forward hook: when a renderer template or registry
 * carries an onchain liveness declaration (docs/pnd-surface-system.md
 * section 3.1), it plugs in as one more optional input here.
 */
import { classifyUrl } from "./metadata-host"

export type StorageKind = "onchain" | "ipfs" | "arweave" | "web" | "unknown"

/**
 * Where one URI lives. Any data: URI is onchain (the contract returned the
 * bytes themselves; classifyUrl only knows the JSON and image data types,
 * and generative works return data:text/html). Everything else goes
 * through the shared metadata-host classifier: ipfs:// and IPFS gateways,
 * ar:// and arweave.net, any other http(s) host is a web server.
 */
export function classifyStorage(uri: string | null | undefined): StorageKind {
  if (!uri) return "unknown"
  const trimmed = uri.trim()
  if (/^data:/i.test(trimmed)) return "onchain"
  switch (classifyUrl(trimmed).bucket) {
    case "onchain":
      return "onchain"
    case "ipfs":
      return "ipfs"
    case "arweave":
      return "arweave"
    case "centralized":
      return "web"
    default:
      return "unknown"
  }
}

export type ArtStorage = {
  /** The tokenURI itself (the metadata JSON). */
  metadata: StorageKind
  /** null when the metadata carries no image / animation_url. */
  image: StorageKind | null
  animation: StorageKind | null
}

/**
 * Classify a token's render. `assembled` is for a work whose tokenURI is
 * a contract-built string too large for any eth_call (escape (blue)): PND
 * assembles the same document from the contract's own parts and serves it
 * from a same-origin route, so the route URL says nothing about storage.
 * The metadata is built onchain either way; the media follows the token's
 * mode: fully onchain in FOC mode, otherwise the document inlines the
 * still's own URL (Arweave for escape's hi-res mode), so it shares that
 * dependency.
 */
export function classifyArt(input: {
  tokenUri?: string | null
  image?: string | null
  animationUrl?: string | null
  assembled?: { focMode: boolean }
}): ArtStorage {
  if (input.assembled) {
    const image = input.image ? classifyStorage(input.image) : null
    return {
      metadata: "onchain",
      image,
      animation: input.assembled.focMode ? "onchain" : (image ?? "unknown"),
    }
  }
  return {
    metadata: classifyStorage(input.tokenUri),
    image: input.image ? classifyStorage(input.image) : null,
    animation: input.animationUrl ? classifyStorage(input.animationUrl) : null,
  }
}

/** True only when the metadata and every media part it names are onchain. */
export function isFullyOnchain(s: ArtStorage): boolean {
  if (s.metadata !== "onchain") return false
  if (s.image === null && s.animation === null) return false
  return (s.image === null || s.image === "onchain") && (s.animation === null || s.animation === "onchain")
}

const KIND_LABEL: Record<StorageKind, string> = {
  onchain: "onchain",
  ipfs: "IPFS",
  arweave: "Arweave",
  web: "a web server",
  unknown: "not determined",
}

/** "Fully onchain", or each part named, e.g. "Metadata onchain, image on IPFS". */
export function describeStorage(s: ArtStorage): string {
  if (isFullyOnchain(s)) return "Fully onchain"
  const part = (name: string, k: StorageKind) =>
    k === "onchain" ? `${name} onchain` : k === "unknown" ? `${name} not determined` : `${name} on ${KIND_LABEL[k]}`
  const parts = [part("Metadata", s.metadata)]
  // One media line when image and animation live in the same place.
  if (s.image !== null && s.animation !== null && s.image === s.animation) {
    parts.push(part("media", s.image))
  } else {
    if (s.image !== null) parts.push(part("image", s.image))
    if (s.animation !== null) parts.push(part("animation", s.animation))
  }
  return parts.join(", ")
}

export type PreservationInput = {
  /** A primitive-first v2 Surface (no locks; permanence = renounced owner). */
  primitiveV2: boolean
  /** 1, or 2 for the superseded SurfaceV2 (which has a royalty lock). */
  protocolVersion: number
  isRendererLocked: boolean
  isSupplyLocked: boolean
  isRoyaltyLocked: boolean
  /** owner() == 0 (primitive v2: from the live owner read). */
  sealed: boolean
  supplyCap: bigint
  /** The sale can mint no more (closed, ended, or sold out). */
  saleClosed: boolean
  /** null when the render could not be read. */
  storage: ArtStorage | null
  /** Which token the storage was read from, when the card describes a whole
   *  collection from one sample (e.g. "token #1"); omitted on a token page. */
  storageSample?: string
  /** v1 only. Collection scope: registered + anchored token count. Token
   *  scope: tokens is 1 when this token carries a MURI record. null when MURI
   *  data is unavailable. */
  muri: { registered: boolean; tokens: number } | null
  muriScope?: "collection" | "token"
}

export type PreservationFact = {
  label: string
  value: string
  /** "fixed" for a fact that can no longer change, "open" for one the
   *  owner can still change, "info" otherwise. Drives a quiet marker only. */
  tone: "fixed" | "open" | "info"
}

const OWNER_CAN_CHANGE = "Owner can change"

export function preservationFacts(input: PreservationInput): PreservationFact[] {
  const facts: PreservationFact[] = []

  if (input.primitiveV2) {
    facts.push(
      input.sealed
        ? { label: "Ownership", value: "Renounced, nothing can change", tone: "fixed" }
        : { label: "Ownership", value: "Held, owner can change renderer, cap and royalty", tone: "open" },
    )
    const supply: string[] = []
    if (input.supplyCap > 0n) supply.push(`Capped at ${input.supplyCap.toString()}`)
    if (input.saleClosed) supply.push("sale closed")
    facts.push({
      label: "Supply",
      value: supply.length > 0 ? capitalize(supply.join(", ")) : "No cap set, sale open",
      tone: input.sealed && input.supplyCap > 0n ? "fixed" : input.saleClosed || input.supplyCap > 0n ? "info" : "open",
    })
  } else {
    facts.push(
      input.isRendererLocked
        ? { label: "Renderer", value: "Locked", tone: "fixed" }
        : { label: "Renderer", value: OWNER_CAN_CHANGE, tone: "open" },
    )
    facts.push(
      input.isSupplyLocked
        ? {
            label: "Supply",
            value: input.supplyCap > 0n ? `Locked at ${input.supplyCap.toString()}` : "Locked",
            tone: "fixed",
          }
        : { label: "Supply", value: OWNER_CAN_CHANGE, tone: "open" },
    )
    // Only the superseded SurfaceV2 has a royalty lock; a v1 royalty is
    // always settable by the owner or an admin.
    facts.push(
      input.protocolVersion === 2 && input.isRoyaltyLocked
        ? { label: "Royalty", value: "Locked", tone: "fixed" }
        : { label: "Royalty", value: OWNER_CAN_CHANGE, tone: "open" },
    )
  }

  if (input.storage) {
    // Onchain bytes are only fixed once the renderer that returns them is:
    // locked (v1) or behind a renounced owner (primitive v2).
    const rendererFixed = input.primitiveV2 ? input.sealed : input.isRendererLocked
    const value = describeStorage(input.storage)
    facts.push({
      label: "Art data",
      value: input.storageSample ? `${value} (${input.storageSample})` : value,
      tone: isFullyOnchain(input.storage) && rendererFixed ? "fixed" : "info",
    })
  }

  // MURI anchors are shown for v1 only until MURI can register v2
  // collections (issue #365), and only when the indexed data says so.
  if (!input.primitiveV2 && input.muri) {
    const { registered, tokens } = input.muri
    if (input.muriScope === "token") {
      if (tokens > 0) facts.push({ label: "MURI", value: "Anchored", tone: "info" })
    } else if (registered || tokens > 0) {
      facts.push({
        label: "MURI",
        value:
          tokens > 0
            ? `${tokens} ${tokens === 1 ? "token" : "tokens"} anchored`
            : "Registered, no tokens anchored yet",
        tone: "info",
      })
    }
  }

  return facts
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
