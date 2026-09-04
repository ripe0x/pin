import { gatewayCandidates, resolveMediaUrl } from "./media-fallback"

export type TokenPreviewMetadata = {
  image: string | null
  animationUrl: string | null
  kind: "image" | "video" | "html"
}

function mediaKind(url: string | null): TokenPreviewMetadata["kind"] {
  if (!url) return "image"
  if (url.toLowerCase().startsWith("data:image/")) return "image"
  const path = url.split("?")[0].split("#")[0].toLowerCase()
  return /\.(mp4|mov|webm|ogv)$/.test(path) ? "video" : /\.(png|jpe?g|gif|svg|webp|avif)$/.test(path) ? "image" : "html"
}

function decodeDataJson(uri: string): Record<string, unknown> | null {
  const comma = uri.indexOf(",")
  if (comma < 0) return null
  const body = uri.slice(comma + 1)
  try {
    const raw = uri.slice(0, comma).toLowerCase().includes(";base64")
      ? atob(body)
      : decodeURIComponent(body)
    const value: unknown = JSON.parse(raw)
    return value && typeof value === "object" ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

async function loadJson(uri: string): Promise<Record<string, unknown> | null> {
  if (uri.startsWith("data:")) return decodeDataJson(uri)
  for (const candidate of gatewayCandidates(uri)) {
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(8_000) })
      if (!response.ok) continue
      const value: unknown = await response.json()
      if (value && typeof value === "object") return value as Record<string, unknown>
    } catch {
      // Try the next content-addressed gateway.
    }
  }
  return null
}

export async function resolveTokenPreview(uri: string | null): Promise<TokenPreviewMetadata | null> {
  if (!uri) return null
  const json = await loadJson(uri)
  if (!json) return null
  const image = typeof json.image === "string" && json.image ? resolveMediaUrl(json.image) : null
  const animationUrl = typeof json.animation_url === "string" && json.animation_url
    ? resolveMediaUrl(json.animation_url)
    : null
  if (!image && !animationUrl) return null
  return { image, animationUrl, kind: mediaKind(animationUrl ?? image) }
}
