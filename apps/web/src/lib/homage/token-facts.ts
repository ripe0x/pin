// Pure decode of a homage token's on-chain metadata attributes. The token page
// already fetches the raw tokenURI (a `data:application/json` URI from the
// renderer); this pulls the homage-relevant traits out of it with NO extra RPC.
//
// The renderer emits: Punk Type, Punk Accessory (repeated), Accessory Count,
// Color Count, Status — see homage-gallery/local.ts `toMeta`.

export type HomageTokenFacts = {
  punkType: string | null
  accessories: string[]
  colorCount: number | null
  status: string | null
}

type Attr = {trait_type?: string; value?: string | number}

function decodeDataUriJson(uri: string): {attributes?: Attr[]} | null {
  try {
    if (uri.startsWith("data:application/json;base64,")) {
      const b64 = uri.slice("data:application/json;base64,".length)
      const json =
        typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8")
      return JSON.parse(json)
    }
    const comma = uri.indexOf(",")
    if (uri.startsWith("data:application/json") && comma !== -1) {
      return JSON.parse(decodeURIComponent(uri.slice(comma + 1)))
    }
    return JSON.parse(uri)
  } catch {
    return null
  }
}

// The homage art is an Albers composition on a solid per-token ground: its SVG
// opens with `<rect width="240" height="240" fill="#<ground>"/>` (see
// homage-gallery/render.ts `svg`). Pull that ground hex out of the token's image
// data URI so the source-punk thumbnail can sit on the SAME ground — the two
// images read as a matched pair instead of the punk floating on the terminal
// black. Returns null (→ caller falls back to the page ground) if anything is off.
export function extractHomageGround(image: string | null): string | null {
  if (!image) return null
  try {
    let svg = image
    if (image.startsWith("data:")) {
      const comma = image.indexOf(",")
      if (comma === -1) return null
      const meta = image.slice(0, comma)
      const body = image.slice(comma + 1)
      svg = meta.includes(";base64")
        ? typeof atob === "function"
          ? atob(body)
          : Buffer.from(body, "base64").toString("utf8")
        : decodeURIComponent(body)
    }
    // First full-canvas rect fill is the ground; fall back to the first fill.
    const m =
      svg.match(/<rect\b[^>]*\bfill="(#[0-9a-fA-F]{3,8})"/) ??
      svg.match(/\bfill="(#[0-9a-fA-F]{3,8})"/)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

export function parseHomageFacts(tokenURI: string | null): HomageTokenFacts {
  const meta = tokenURI ? decodeDataUriJson(tokenURI) : null
  const attrs: Attr[] = Array.isArray(meta?.attributes) ? meta!.attributes! : []
  const first = (t: string) => attrs.find((a) => a.trait_type === t)?.value
  const punkType = first("Punk Type")
  const colorCount = first("Color Count")
  const status = first("Status")
  return {
    punkType: punkType != null ? String(punkType) : null,
    accessories: attrs
      .filter((a) => a.trait_type === "Punk Accessory")
      .map((a) => String(a.value)),
    colorCount: colorCount != null && Number.isFinite(Number(colorCount)) ? Number(colorCount) : null,
    status: status != null ? String(status) : null,
  }
}
