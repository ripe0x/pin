import { ImageResponse } from "next/og"
import { getAuctionById } from "@/lib/auctions"
import { getTokenMetadata } from "@/lib/metadata"
import { getConfig } from "@/lib/config"
import { getArtistDisplayName } from "@/lib/artist"
import { formatEth, formatTimeRemaining } from "@/lib/format"

export const runtime = "nodejs"
export const alt = "Auction"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

// Cache the rendered preview for a minute. Hit on every link unfurl, so
// caching saves RPC reads when a popular post fires off many crawler
// requests.
export const revalidate = 60

/**
 * Per-auction OG. Split layout: token thumbnail on the left, auction
 * metadata on the right. White surface, black text, gray support copy
 * to match the PND palette. Status uses the same "tiny mono caps"
 * treatment as the main app's status pills.
 */
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

  const title = metadata?.name ?? `#${params.auctionId}`
  const image = metadata?.image ?? null

  let priceLabel = ""
  let statusLabel = ""
  let statusColor = "#666666"
  if (auction) {
    if (auction.status === "settled" && auction.finalPrice) {
      priceLabel = `${formatEth(auction.finalPrice)} ETH`
      statusLabel = "Sold"
      statusColor = "#C6248B"
    } else if (auction.status === "cancelled") {
      priceLabel = ""
      statusLabel = "Cancelled"
      statusColor = "#999999"
    } else if (auction.amount === "0") {
      priceLabel = `${formatEth(auction.reservePrice)} ETH reserve`
      statusLabel = "Live"
      statusColor = "#CBA1FC"
    } else {
      priceLabel = `${formatEth(auction.amount)} ETH`
      const endTime = Number(auction.endTime)
      if (endTime > 0) {
        const remaining = endTime - Math.floor(Date.now() / 1000)
        statusLabel =
          remaining > 0 ? formatTimeRemaining(remaining) + " left" : "Ended"
      } else {
        statusLabel = "Live"
      }
      statusColor = "#CBA1FC"
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#FFFFFF",
          color: "#000000",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            width: 630,
            height: 630,
            background: "#F2F2F2",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            borderRight: "1px solid #E6E6E6",
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
            <div
              style={{
                fontSize: 14,
                color: "#999999",
                fontFamily: "monospace",
                textTransform: "uppercase",
                letterSpacing: 1.5,
                display: "flex",
              }}
            >
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
                width={40}
                height={40}
                style={{ borderRadius: "100%", objectFit: "cover" }}
                alt=""
              />
            ) : (
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "100%",
                  background: `linear-gradient(135deg, ${addressToColor(cfg.artistAddress, 0)} 0%, ${addressToColor(cfg.artistAddress, 10)} 100%)`,
                }}
              />
            )}
            <div style={{ fontSize: 22, fontWeight: 500, display: "flex" }}>
              {displayName}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {statusLabel ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "100%",
                    background: statusColor,
                  }}
                />
                <div
                  style={{
                    fontSize: 14,
                    color: "#666666",
                    fontFamily: "monospace",
                    textTransform: "uppercase",
                    letterSpacing: 1.5,
                    display: "flex",
                  }}
                >
                  {statusLabel}
                </div>
              </div>
            ) : null}
            <div
              style={{
                fontSize: 56,
                fontWeight: 600,
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
              <div
                style={{
                  fontSize: 36,
                  fontFamily: "monospace",
                  fontWeight: 500,
                  display: "flex",
                }}
              >
                {priceLabel}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}

function addressToColor(address: string, offset: number): string {
  const hex = address.slice(2, 8 + offset)
  const num = parseInt(hex, 16)
  const h = num % 360
  return `hsl(${h}, 60%, 70%)`
}
