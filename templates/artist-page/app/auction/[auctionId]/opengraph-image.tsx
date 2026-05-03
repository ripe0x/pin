import { ImageResponse } from "next/og"
import { getAuctionById } from "@/lib/auctions"
import { getTokenMetadata } from "@/lib/metadata"
import { getConfig } from "@/lib/config"
import { getArtistDisplayName } from "@/lib/artist"
import { formatEth, formatTimeRemaining } from "@/lib/format"

// Note: ImageResponse can't run on edge in our app because lib/auctions
// imports server-only and uses Next's unstable_cache. Use the Node runtime;
// it's still free on Vercel/Netlify and has no cold-start issue worth
// optimizing for an OG endpoint.
export const runtime = "nodejs"

export const alt = "Auction"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

// Cache the rendered preview for a minute. Per-auction OGs are cheap to
// regenerate but are hit on every link unfurl, so caching here saves Reservoir
// + RPC reads when a popular tweet/post fires off many crawler requests.
export const revalidate = 60

export default async function Image({
  params,
}: {
  params: { auctionId: string }
}) {
  const cfg = getConfig()
  const displayName = await getArtistDisplayName()
  const auction = await getAuctionById(params.auctionId)
  const metadata = auction
    ? await getTokenMetadata(auction.tokenContract, auction.tokenId)
    : null

  const title = metadata?.name ?? `Auction #${params.auctionId}`
  const image = metadata?.image ?? null

  let priceLabel = ""
  let statusLabel = ""
  if (auction) {
    if (auction.status === "settled" && auction.finalPrice) {
      priceLabel = `Sold for ${formatEth(auction.finalPrice)} ETH`
      statusLabel = "Settled"
    } else if (auction.status === "cancelled") {
      priceLabel = "Cancelled"
      statusLabel = "Cancelled"
    } else if (auction.amount === "0") {
      priceLabel = `Reserve ${formatEth(auction.reservePrice)} ETH`
      statusLabel = "Live"
    } else {
      priceLabel = `Current bid: ${formatEth(auction.amount)} ETH`
      const endTime = Number(auction.endTime)
      if (endTime > 0) {
        const remaining = endTime - Math.floor(Date.now() / 1000)
        statusLabel =
          remaining > 0 ? formatTimeRemaining(remaining) + " left" : "Ended"
      } else {
        statusLabel = "Live"
      }
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#0a0a0a",
          color: "#fafafa",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            width: 630,
            height: 630,
            background: "#1a1a1a",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              width={630}
              height={630}
              style={{ width: 630, height: 630, objectFit: "cover" }}
              alt=""
            />
          ) : (
            <div style={{ fontSize: 28, color: "#525252", display: "flex" }}>
              No preview
            </div>
          )}
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: 56,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {cfg.artistAvatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={cfg.artistAvatarUrl}
                width={48}
                height={48}
                alt=""
              />
            ) : (
              <div
                style={{
                  width: 48,
                  height: 48,
                  background: "#262626",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 24,
                  fontWeight: 600,
                }}
              >
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div style={{ fontSize: 28, fontWeight: 600, display: "flex" }}>
              {displayName}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div
              style={{
                fontSize: 56,
                fontWeight: 700,
                letterSpacing: -2,
                lineHeight: 1.05,
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {title}
            </div>
            {priceLabel ? (
              <div style={{ fontSize: 36, color: "#fafafa", display: "flex" }}>
                {priceLabel}
              </div>
            ) : null}
            {statusLabel ? (
              <div
                style={{
                  fontSize: 22,
                  color: "#a3a3a3",
                  display: "flex",
                }}
              >
                {statusLabel}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}
