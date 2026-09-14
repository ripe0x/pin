/**
 * URL-based media classification by file extension. Some tokens put a
 * video in the metadata `image` field with no extension; `isAmbiguousMediaUrl`
 * flags those so a failed image can escalate to a video element.
 */
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"] as const
export const IMAGE_EXTENSIONS = [
  ".gif",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
] as const

export function extOf(url: string): string {
  const path = url.split("?")[0].split("#")[0].toLowerCase()
  const dot = path.lastIndexOf(".")
  const slash = path.lastIndexOf("/")
  return dot > slash ? path.slice(dot) : ""
}

export function isVideoUrl(url: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(extOf(url))
}

/** True when the extension is neither a known image nor a known video. */
export function isAmbiguousMediaUrl(url: string): boolean {
  const ext = extOf(url)
  return (
    !(VIDEO_EXTENSIONS as readonly string[]).includes(ext) &&
    !(IMAGE_EXTENSIONS as readonly string[]).includes(ext)
  )
}
