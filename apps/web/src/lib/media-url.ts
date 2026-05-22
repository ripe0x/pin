/**
 * URL-based media classification shared by the token detail view and the
 * grid/thumbnail surfaces. Classification is by file extension only; some
 * tokens defeat it by stuffing a video into the `image` field with no
 * extension (e.g. uri() => {"image":"ipfs://<mp4 cid>"}), which is what
 * `isAmbiguousMediaUrl` flags so callers can escalate a failed <img> to a
 * <video>.
 */

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]
const IMAGE_EXTENSIONS = [
  ".gif",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
]

export function extOf(url: string): string {
  const path = url.split("?")[0].split("#")[0].toLowerCase()
  const dot = path.lastIndexOf(".")
  const slash = path.lastIndexOf("/")
  return dot > slash ? path.slice(dot) : ""
}

export function isVideoUrl(url: string): boolean {
  return VIDEO_EXTENSIONS.includes(extOf(url))
}

/**
 * True when the extension is neither a known image nor a known video —
 * i.e. classification is impossible. A bare `image` URL like this may
 * actually be a video, so a failed <img> on such a URL is the signal to
 * escalate to <video> rather than showing a broken image.
 */
export function isAmbiguousMediaUrl(url: string): boolean {
  const ext = extOf(url)
  return !VIDEO_EXTENSIONS.includes(ext) && !IMAGE_EXTENSIONS.includes(ext)
}
