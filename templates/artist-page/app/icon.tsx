import { ImageResponse } from "next/og"
import { zorbDataURI } from "zero-deps-zorbs"
import { getConfig } from "@/lib/config"
import { getArtistAvatarUrl } from "@/lib/artist"

export const runtime = "nodejs"
export const size = { width: 32, height: 32 }
export const contentType = "image/png"

/**
 * Dynamic favicon. When the artist's ENS profile (or env override) has an
 * avatar, render it as a small rounded square. Otherwise fall back to the
 * same address-derived gradient the OG image uses, so every deploy gets a
 * recognizable, on-brand icon without the artist having to ship a file.
 */
export default async function Icon() {
  const cfg = getConfig()
  const avatarUrl = await getArtistAvatarUrl()
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl ?? zorbDataURI(cfg.artistAddress)}
          width={32}
          height={32}
          alt=""
          style={{ width: 32, height: 32, objectFit: "cover" }}
        />
      </div>
    ),
    { ...size },
  )
}
