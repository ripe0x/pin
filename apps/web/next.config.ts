import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@pin/abi", "@pin/addresses", "@pin/shared"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.ipfs.w3s.link" },
      { protocol: "https", hostname: "cloudflare-ipfs.com" },
      { protocol: "https", hostname: "ipfs.io" },
      { protocol: "https", hostname: "dweb.link" },
    ],
  },
  async redirects() {
    // `/record` was the previous name for the catalog UI. Permanent
    // redirect so any pre-rename bookmarks, dependency-report
    // `addContract` deep links, or external mentions keep working.
    return [
      { source: "/record", destination: "/catalog", permanent: true },
      { source: "/record/:address", destination: "/catalog/:address", permanent: true },
      { source: "/api/record/:address", destination: "/api/catalog/:address", permanent: true },
      { source: "/api/record/:address/revalidate", destination: "/api/catalog/:address/revalidate", permanent: true },
    ]
  },
}

export default nextConfig
