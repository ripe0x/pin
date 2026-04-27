import { ImageResponse } from "next/og"
import { ipfsToHttp } from "@pin/shared"
import { getArtistIdentity, resolveEnsAddress } from "@/lib/artist-queries"
import {
  getCachedTokenRefs,
  getCachedEnrichedPage,
} from "@/lib/artist-cache"

export const alt = "Artist portfolio on pin"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export default async function OGImage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address: raw } = await params
  const decoded = decodeURIComponent(raw)

  // Crawlers usually follow the page's ENS→address redirect, but resolve
  // here too so a direct hit on /artist/dave.eth/opengraph-image still works.
  const resolved = ADDRESS_RE.test(decoded)
    ? decoded
    : await resolveEnsAddress(decoded)

  if (!resolved) {
    return renderCard({
      displayName: decoded,
      total: 0,
      thumbnails: [],
      address: "0x0000000000000000000000000000000000000000",
    })
  }

  const identity = await getArtistIdentity(resolved)

  // Pull the same cached refs + first-page enrichment the gallery uses, but
  // capped at 4 thumbnails. Tolerate failure: a bad gateway or a slow RPC
  // shouldn't break the social card — fall back to the no-artwork branch.
  let total = 0
  let thumbnails: string[] = []
  try {
    const refs = await getCachedTokenRefs(resolved)
    total = refs.length
    // Enrich the same first-page slice the gallery uses (24) so we share its
    // cache entry, then take the first 4 tokens that actually have a media
    // URL — some tokens enrich to null and we don't want gaps in the grid.
    const slice = refs.slice(0, 24)
    if (slice.length > 0) {
      const enriched = await getCachedEnrichedPage(slice)
      thumbnails = enriched
        .map((t) =>
          t.mediaHttpUrl ??
          (t.metadata?.image ? ipfsToHttp(t.metadata.image) : null),
        )
        .filter((u): u is string => !!u)
        .slice(0, 4)
    }
  } catch {
    thumbnails = []
  }

  return renderCard({
    displayName: identity.displayName,
    total,
    thumbnails,
    address: resolved,
  })
}

function renderCard({
  displayName,
  total,
  thumbnails,
  address,
}: {
  displayName: string
  total: number
  thumbnails: string[]
  address: string
}) {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: "#ffffff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Left side: artist info */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "60px",
            width: "50%",
          }}
        >
          <div
            style={{
              display: "flex",
              width: "80px",
              height: "80px",
              borderRadius: "50%",
              background: `linear-gradient(135deg, hsl(${parseInt(address.slice(2, 8), 16) % 360}, 60%, 70%) 0%, hsl(${parseInt(address.slice(8, 14), 16) % 360}, 60%, 70%) 100%)`,
              marginBottom: "24px",
            }}
          />
          <div
            style={{
              fontSize: "40px",
              fontWeight: "700",
              letterSpacing: "-0.02em",
              marginBottom: "8px",
            }}
          >
            {displayName}
          </div>
          <div
            style={{
              fontSize: "20px",
              color: "#666666",
            }}
          >
            {`${total} ${total === 1 ? "work" : "works"}`}
          </div>
          <div
            style={{
              fontSize: "16px",
              color: "#999999",
              marginTop: "24px",
            }}
          >
            pin
          </div>
        </div>

        {/* Right side: artwork grid (fixed px — Satori doesn't support calc()) */}
        {thumbnails.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              width: "600px",
              height: "630px",
              padding: "20px",
              gap: "8px",
            }}
          >
            {thumbnails.map((url, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  width: thumbnails.length <= 1 ? "560px" : "276px",
                  height: thumbnails.length <= 2 ? "590px" : "291px",
                  overflow: "hidden",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt=""
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    ),
    { ...size },
  )
}
