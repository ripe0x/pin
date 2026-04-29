import { getDefaultConfig } from "@rainbow-me/rainbowkit"
import { foundry, mainnet } from "wagmi/chains"
import { http } from "wagmi"

// WalletConnect requires a projectId. Get one free at https://cloud.walletconnect.com
// For local dev without one, we use a placeholder that disables WC but still allows injected wallets.
const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "PLACEHOLDER_DEV_ID"

// Include the local Anvil chain (31337) when an Anvil RPC is configured so
// MetaMask labels fork txs as "Foundry"/"Anvil" rather than "Ethereum Mainnet"
// — eliminates the "is this a real mainnet tx?" anxiety during local testing.
const anvilUrl = process.env.NEXT_PUBLIC_ANVIL_RPC_URL ?? "http://localhost:8545"

export const config = getDefaultConfig({
  appName: "PND",
  projectId,
  chains: [mainnet, foundry],
  transports: {
    // Route browser RPC through our server-side `/api/rpc` proxy so the
    // Alchemy API key never reaches the bundle. The proxy enforces a method
    // allowlist + per-IP rate limit, which keeps anonymous abuse from
    // burning through the monthly CU cap.
    [mainnet.id]: http("/api/rpc"),
    [foundry.id]: http(anvilUrl),
  },
  ssr: true,
})
