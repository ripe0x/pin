import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Allow Reservoir CDN + common IPFS gateways for token media.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "img.reservoir.tools" },
      { protocol: "https", hostname: "**.reservoir.tools" },
      { protocol: "https", hostname: "**.ipfs.w3s.link" },
      { protocol: "https", hostname: "cloudflare-ipfs.com" },
      { protocol: "https", hostname: "ipfs.io" },
      { protocol: "https", hostname: "dweb.link" },
      { protocol: "https", hostname: "nftstorage.link" },
      { protocol: "https", hostname: "**.nftstorage.link" },
    ],
  },
}

export default nextConfig
