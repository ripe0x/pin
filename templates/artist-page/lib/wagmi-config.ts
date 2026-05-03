/**
 * Browser-side wagmi config for connect + bid txs.
 *
 * Two reasons we don't just call `getDefaultConfig()` and accept the full
 * default wallet list:
 *
 * 1. **WalletConnect requires a real project ID.** The default we ship as a
 *    fallback (in `lib/config.ts`) is a placeholder; Reown's API rejects
 *    it with HTTP 403, which historically caused RainbowKit's Connect
 *    button to fail to hydrate (button stays empty). We detect the
 *    placeholder and skip the WalletConnect connector when it's in use.
 *    Artists who set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to a real ID
 *    from cloud.reown.com get the full wallet list (including WC mobile).
 *
 * 2. The same RPC URLs that power our server-side viem client are passed to
 *    wagmi's `http` transport with `fallback`, so wallet-issued reads (e.g.
 *    `useReadContract`) get the same failover behavior as our server reads.
 */
"use client"

import { getDefaultConfig, connectorsForWallets } from "@rainbow-me/rainbowkit"
import {
  injectedWallet,
  metaMaskWallet,
  coinbaseWallet,
  rainbowWallet,
  walletConnectWallet,
  safeWallet,
} from "@rainbow-me/rainbowkit/wallets"
import { fallback, http, createConfig } from "wagmi"
import { mainnet } from "wagmi/chains"
import { DEFAULT_WALLETCONNECT_PROJECT_ID, getConfig } from "./config"

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

  const transports = {
    [mainnet.id]: fallback(
      urls.map((url) => http(url, { retryCount: 1, timeout: 15_000 })),
    ),
  }

  // Are we using the placeholder WalletConnect project ID? If so, skip the
  // WC mobile connector — its initialization fails with the placeholder and
  // prevents the rest of the connector list from rendering.
  const hasRealWcProjectId =
    cfg.walletConnectProjectId !== DEFAULT_WALLETCONNECT_PROJECT_ID &&
    cfg.walletConnectProjectId.length > 0

  // Build the explicit wallet list. injected + Coinbase + Safe work without a
  // WC project ID; WalletConnect mobile and Rainbow are opt-in once a real
  // project ID is provided.
  const baseWallets = [injectedWallet, metaMaskWallet, coinbaseWallet, safeWallet]
  const wallets = hasRealWcProjectId
    ? [...baseWallets, walletConnectWallet, rainbowWallet]
    : baseWallets

  const connectors = connectorsForWallets(
    [{ groupName: "Wallets", wallets }],
    {
      appName: cfg.artistName ?? "Auctions",
      // RainbowKit still requires this even when WC isn't in the wallet list.
      // It just gets passed to any connector that needs it; if none do, it's
      // unused.
      projectId: cfg.walletConnectProjectId,
    },
  )

  _wagmiConfig = createConfig({
    chains: [mainnet],
    connectors,
    transports,
    ssr: true,
  }) as unknown as ReturnType<typeof getDefaultConfig>
  return _wagmiConfig
}
