import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@pin/abi", "@pin/addresses", "@pin/shared", "@pin/token-metadata"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.ipfs.w3s.link" },
      { protocol: "https", hostname: "cloudflare-ipfs.com" },
      { protocol: "https", hostname: "ipfs.io" },
      { protocol: "https", hostname: "dweb.link" },
    ],
  },
  // No Next-level proxy to the worker — the web app calls it directly via fetch
  // from its own server-side code. `WORKER_URL` is set in the Railway environment.
  async redirects() {
    return [
      { source: "/record", destination: "/catalog", permanent: true },
      { source: "/record/:address", destination: "/catalog/:address", permanent: true },
      { source: "/api/record/:address", destination: "/api/catalog/:address", permanent: true },
      { source: "/api/record/:address/revalidate", destination: "/api/catalog/:address/revalidate", permanent: true },
    ]
  },
}

export default nextConfig
