"use client"

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

/**
 * Centered media renderer for the auction detail page. Mirrors PND's
 * `apps/web/src/components/token/TokenMedia.tsx`: max-h-80vh, w-auto,
 * object-contain — so the artwork dominates the viewport without spilling
 * out of the sticky column it sits in.
 */
export function TokenMedia({
  src,
  title,
}: {
  src: string | null
  title: string
}) {
  if (!src) {
    return (
      <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400">
        No preview
      </div>
    )
  }
  const path = src.split("?")[0].toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext))
  if (isVideo) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return (
      <video
        src={src}
        className="max-h-[80vh] w-auto object-contain"
        autoPlay
        loop
        muted
        playsInline
        controls
      />
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={title}
      className="max-h-[80vh] w-auto object-contain"
    />
  )
}
