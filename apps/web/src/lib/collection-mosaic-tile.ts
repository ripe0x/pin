/**
 * Pure selection of what one OnchainMosaic grid tile shows, given a token's
 * own decoded tokenURI (an image, or inline HTML from animation_url) and
 * the collection's cover. A renderer can answer with animation_url only
 * and no image field (the ScriptyRenderer/anton shape). Without a defined
 * fallback, every such tile rendered as a bare, empty div.
 *
 * Order: the token's own image; else the collection cover, with the
 * token's number overlaid so same-cover tiles stay distinguishable; else a
 * live sandboxed iframe of the token's HTML, limited to the first
 * `iframeLimit` tiles by grid position to bound an eager grid's
 * WebGL/canvas cost; else a numbered neutral placeholder.
 */
export type MosaicTileVisual =
  | { kind: "image"; src: string }
  | { kind: "cover"; src: string; number: number }
  | { kind: "iframe"; html: string }
  | { kind: "number"; number: number }

export function selectMosaicTileVisual(params: {
  image: string | null
  /** Inline HTML from the token's decoded animation_url, not a URL. */
  html: string | null
  cover: string | null
  /** The token id (or grid position) shown on a cover or neutral tile. */
  number: number
  /** 0-based position in the grid; only tiles below `iframeLimit` get a live iframe. */
  position: number
  iframeLimit?: number
}): MosaicTileVisual {
  const { image, html, cover, number, position, iframeLimit = 4 } = params
  if (image) return { kind: "image", src: image }
  if (cover) return { kind: "cover", src: cover, number }
  if (html && position < iframeLimit) return { kind: "iframe", html }
  return { kind: "number", number }
}
