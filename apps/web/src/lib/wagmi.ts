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
    [mainnet.id]: http(
      process.env.NEXT_PUBLIC_ALCHEMY_MAINNET_URL ??
        "https://eth.llamarpc.com"
    ),
    [foundry.id]: http(anvilUrl),
  },
  ssr: true,
})
