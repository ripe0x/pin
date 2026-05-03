/**
 * Browser-side wagmi config for connect + bid txs.
 *
 * The same RPC URLs that power our server-side viem client are passed to
 * wagmi's `http` transport with `fallback`, so wallet-issued reads (e.g.
 * `useReadContract`) get the same failover behavior as our server reads.
 */
"use client"

import { getDefaultConfig } from "@rainbow-me/rainbowkit"
import { fallback, http } from "wagmi"
import { mainnet } from "wagmi/chains"
import { getConfig } from "./config"

const PUBLIC_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://eth.llamarpc.com",
  "https://cloudflare-eth.com",
]

let _wagmiConfig: ReturnType<typeof getDefaultConfig> | null = null

export function getWagmiConfig() {
  if (_wagmiConfig) return _wagmiConfig

  const cfg = getConfig()
  const urls =
    cfg.userRpcUrls && cfg.userRpcUrls.length > 0
      ? [...cfg.userRpcUrls, ...PUBLIC_RPCS]
      : PUBLIC_RPCS

  // RainbowKit's appName is shown in the Connect modal. We don't have access
  // to the ENS-resolved name here (that's server-only), so fall back to a
  // generic label when the env var is unset. This isn't user-visible until
  // they actually open the wallet picker.
  _wagmiConfig = getDefaultConfig({
    appName: cfg.artistName ?? "Auctions",
    projectId: cfg.walletConnectProjectId,
    chains: [mainnet],
    transports: {
      [mainnet.id]: fallback(
        urls.map((url) => http(url, { retryCount: 1, timeout: 15_000 })),
      ),
    },
    ssr: true,
  })
  return _wagmiConfig
}
