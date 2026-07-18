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
