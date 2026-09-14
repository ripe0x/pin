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
      { protocol: "https", hostname: "ipfs.filebase.io" },
      { protocol: "https", hostname: "gateway.pinata.cloud" },
      { protocol: "https", hostname: "dweb.link" },
      { protocol: "https", hostname: "nftstorage.link" },
      { protocol: "https", hostname: "**.nftstorage.link" },
    ],
  },
  webpack(config) {
    // These are optional runtime adapters referenced by wallet packages. The
    // browser build never uses React Native storage or pino's CLI formatter,
    // so resolving them to false removes noisy false-positive build warnings.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
      "@x402/core/client": false,
      "@x402/evm": false,
      "@x402/evm/exact/client": false,
      "@x402/evm/upto/client": false,
      "@x402/svm/exact/client": false,
    }
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      // viem's optional Tempo virtual-module loader is not used on mainnet,
      // but webpack still parses its dynamic import expression.
      { module: /ox.*virtualMasterPool/, message: /Critical dependency/ },
    ]
    return config
  },
}

export default nextConfig
