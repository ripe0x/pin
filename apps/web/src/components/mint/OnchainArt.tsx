"use client"

/**
 * Renders fully-onchain generative art (a `data:` tokenURI image/animation).
 *
 * Onchain SVG/HTML often carries inline CSS animation AND a small script (the
 * Vouch cube uses click-to-pause). An `<img>`-embedded SVG runs the CSS but not
 * the script, so for SVG/HTML documents we use a sandboxed iframe (scripts run,
 * no same-origin access) — the same pattern OpenSea/Zora use for interactive
 * onchain art. Plain raster images fall back to `<img>`. Sizing is the caller's
 * job: pass a `className` that sets the box (e.g. `w-full aspect-[900/620]`).
 */
export function OnchainArt({
  imageUrl,
  animationUrl,
  title,
  className,
  aspectRatio,
}: {
  imageUrl: string
  animationUrl?: string | null
  title: string
  className?: string
  /** CSS aspect-ratio (e.g. "900 / 620"); width comes from `className`. */
  aspectRatio?: string
}) {
  const src = animationUrl || imageUrl
  const style = aspectRatio ? { aspectRatio } : undefined
  if (!src) {
    return (
      <div
        style={style}
        className={`flex items-center justify-center bg-gray-100 dark:bg-bg text-[10px] font-mono uppercase tracking-wider text-gray-400 ${className ?? ""}`}
      >
        No art
      </div>
    )
  }

  const isDataDoc =
    src.startsWith("data:") && /svg\+xml|text\/html|application\/xml/i.test(src.slice(0, 64))

  if (isDataDoc) {
    return (
      <iframe
        src={src}
        title={title}
        sandbox="allow-scripts"
        loading="lazy"
        referrerPolicy="no-referrer"
        style={style}
        className={`block border-0 bg-[#08090a] ${className ?? ""}`}
      />
    )
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={title} style={style} className={`object-contain ${className ?? ""}`} />
}
