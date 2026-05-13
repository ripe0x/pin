import { connectorsForWallets, getDefaultConfig } from "@rainbow-me/rainbowkit"
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  safeWallet,
} from "@rainbow-me/rainbowkit/wallets"
import { foundry as foundryBase, mainnet } from "wagmi/chains"
import { createConfig, http } from "wagmi"
import { mock } from "wagmi/connectors"
import type { Address } from "viem"

// WalletConnect requires a real projectId. Get one free at
// https://cloud.walletconnect.com. When the env var is unset (most dev
// machines) we skip WalletConnect entirely so the Reown AppKit init
// doesn't hit api.web3modal.org with a bad id and noise up the console
// with a 403. Injected wallets (MetaMask, Rabby, Brave, Coinbase, Safe)
// still work without it.
const rawProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
const hasRealProjectId = Boolean(rawProjectId) && rawProjectId !== "PLACEHOLDER_DEV_ID"
const projectId = rawProjectId || "PLACEHOLDER_DEV_ID"

// Include the local Anvil chain (31337) when an Anvil RPC is configured so
// MetaMask labels fork txs as "Foundry"/"Anvil" rather than "Ethereum Mainnet"
// — eliminates the "is this a real mainnet tx?" anxiety during local testing.
const anvilUrl = process.env.NEXT_PUBLIC_ANVIL_RPC_URL ?? "http://localhost:8545"

// viem's built-in `foundry` chain hardcodes `rpcUrls.default.http` to
// `http://127.0.0.1:8545`. The wagmi `mock` connector reads that URL
// directly for `eth_sendTransaction` (it bypasses the configured
// `transports` map for writes), so if the anvil fork is on a non-default
// port — or if another process owns 8545 — every write from the
// impersonation harness lands on the wrong node and comes back as
// "Missing or invalid parameters." Patching the chain object here so
// reads, writes, and the wallet-label all agree on the same URL.
const foundry = {
  ...foundryBase,
  rpcUrls: {
    ...foundryBase.rpcUrls,
    default: { ...foundryBase.rpcUrls.default, http: [anvilUrl] },
  },
} as typeof foundryBase

// When running against a local fork the mainnet transport also goes
// straight to anvil. Anvil holds the full mainnet state at fork-block, so
// chain-1 reads (ENS, ERC721 metadata, etc.) return correct data without
// burning the proxy's rate-limit budget — and writes against chain 1 (a
// rare wagmi auto-route) stay on the fork instead of bouncing off
// `/api/rpc`'s eth_sendTransaction block.
//
// Detection is a dedicated boolean flag, NOT inferred from the Alchemy
// URL env var. Reason: anything Next.js inlines at build time (any
// `NEXT_PUBLIC_*` value referenced anywhere in an import graph reachable
// from a client component) ends up as a literal string in the client JS
// bundle. Reading `NEXT_PUBLIC_ALCHEMY_MAINNET_URL` here — even just to
// `.match()` against it — would bake the URL, including the API key
// segment, into every visitor's browser. The flag stays a flag (`"1"`
// or unset), so there's nothing in the bundle worth scraping.
const isLocalRpc = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const mainnetTransport = isLocalRpc
  ? http(anvilUrl)
  : // In production, route browser RPC through our server-side
    // `/api/rpc` proxy so the Alchemy API key never reaches the bundle.
    // The proxy enforces a method allowlist + per-IP rate limit, which
    // keeps anonymous abuse from burning through the monthly CU cap.
    http("/api/rpc")

const transports = {
  [mainnet.id]: mainnetTransport,
  [foundry.id]: http(anvilUrl),
}

/**
 * Dev impersonation: when `NEXT_PUBLIC_DEV_IMPERSONATE` is set to a 0x…
 * address AND the dapp is running against a local Anvil fork, we replace
 * the rainbowkit-managed connector list with a single wagmi `mock`
 * connector that "is" that address. Combined with anvil's
 * `--auto-impersonate` flag, this lets the migrate / bulk-delist flows
 * run as a real mainnet artist (e.g. one with FND + SR V2 listings)
 * without their private key.
 *
 * Strict guards: only honored when NODE_ENV !== "production" AND the
 * mainnet RPC URL is a localhost address. Even if a stray env var leaks
 * to a prod build, the impersonation path won't activate unless both
 * fences pass.
 */
const impersonateAddr = (process.env.NEXT_PUBLIC_DEV_IMPERSONATE ?? "").trim()
const allowImpersonation =
  process.env.NODE_ENV !== "production" &&
  isLocalRpc &&
  /^0x[0-9a-fA-F]{40}$/.test(impersonateAddr)

export const config = allowImpersonation
  ? createConfig({
      // Put foundry first so the mock connector defaults to chain 31337.
      // The mainnet entry stays in the list (some app code still reads from
      // mainnet for ENS / off-chain calls), but writes flow through the
      // foundry transport — which points at the local Anvil fork — instead
      // of through `/api/rpc` (Alchemy proxy, blocks eth_sendTransaction).
      chains: [foundry, mainnet],
      transports,
      ssr: true,
      connectors: [
        mock({
          accounts: [impersonateAddr as Address],
          features: {
            defaultConnected: true,
            reconnect: true,
          },
        }),
      ],
    })
  : hasRealProjectId
    ? getDefaultConfig({
        appName: "PND",
        projectId,
        chains: [mainnet, foundry],
        transports,
        ssr: true,
      })
    : createConfig({
        chains: [mainnet, foundry],
        transports,
        ssr: true,
        connectors: connectorsForWallets(
          [
            {
              groupName: "Recommended",
              wallets: [
                injectedWallet,
                metaMaskWallet,
                rabbyWallet,
                coinbaseWallet,
                safeWallet,
              ],
            },
          ],
          { appName: "PND", projectId },
        ),
      })
