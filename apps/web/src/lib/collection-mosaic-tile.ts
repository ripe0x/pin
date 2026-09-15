/**
 * Pure selection of what one OnchainMosaic grid tile shows, given its own
 * decoded preview (image/animation_url) and the collection's cover. A
 * renderer's previewURI can answer with animation_url only and no image
 * field (the ScriptyRenderer/anton shape) — without a defined fallback
 * every such tile rendered as a bare, empty div.
 *
 * Order: the tile's own image; else the collection cover, with the tile's
 * position numbered so same-cover tiles stay distinguishable; else a live
 * sandboxed iframe of the animation, limited to the first `iframeLimit`
 * tiles by grid position to bound an eager grid's WebGL/canvas cost; else a
 * numbered neutral placeholder.
 */
export type MosaicTileVisual =
  | { kind: "image"; src: string }
  | { kind: "cover"; src: string; number: number }
  | { kind: "iframe"; src: string }
  | { kind: "number"; number: number }

export function selectMosaicTileVisual(params: {
  image: string | null
  animationUrl: string | null
  cover: string | null
  /** 1-based label shown on a cover or neutral placeholder tile. */
  number: number
  /** 0-based position in the grid; only tiles below `iframeLimit` get a live iframe. */
  position: number
  iframeLimit?: number
}): MosaicTileVisual {
  const { image, animationUrl, cover, number, position, iframeLimit = 4 } = params
  if (image) return { kind: "image", src: image }
  if (cover) return { kind: "cover", src: cover, number }
  if (animationUrl && position < iframeLimit) return { kind: "iframe", src: animationUrl }
  return { kind: "number", number }
}
