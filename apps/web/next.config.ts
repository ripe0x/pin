import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@pin/abi", "@pin/addresses", "@pin/shared", "@pin/token-metadata"],
  // @networked-art/punks-sdk (the Homage gallery's local punk renderer) has a
  // node:fs directory-loader in its main entry that the browser path never
  // calls (we pass the bundled dataset). Webpack can't bundle `node:` URIs in
  // client code, so strip the scheme and resolve the bare fs modules to empty
  // for the browser build — same recipe the Homage site's next.config uses.
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^node:(fs\/promises|fs|path|os|url)$/,
          (r: { request: string }) => {
            r.request = r.request.replace(/^node:/, "")
          },
        ),
      )
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        "fs/promises": false,
        path: false,
        os: false,
        url: false,
      }
    }
    return config
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.ipfs.w3s.link" },
      { protocol: "https", hostname: "cloudflare-ipfs.com" },
      { protocol: "https", hostname: "ipfs.io" },
      { protocol: "https", hostname: "dweb.link" },
    ],
  },
  // Keep the shared /collections/homage URL canonical after launch: once the homage
  // collection address is configured, serve the live /collections/<address> page AT
  // /collections/homage (URL unchanged) instead of redirecting to the raw address —
  // the slug will have been shared pre-launch. `beforeFiles` runs before the filesystem
  // homage/page.tsx, so post-deploy this wins and pre-deploy (address unset) the
  // coming-soon page renders. The [address] page auto-detects the homage skin; the
  // immersive chrome already keys off the /collections/homage path (curated-chrome.ts).
  async rewrites() {
    const homage = (process.env.NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS ?? "").trim()
    const beforeFiles = /^0x[0-9a-fA-F]{40}$/.test(homage)
      ? [{ source: "/collections/homage", destination: `/collections/${homage}` }]
      : []
    return { beforeFiles }
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
