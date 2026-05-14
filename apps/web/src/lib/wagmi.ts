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
// `http://127.0.0.1:8545` AND uses chain id 31337 — same id Hardhat
// nodes use. If a developer already has a "Hardhat Local" network in
// MetaMask at 31337, `wallet_addEthereumChain` for our anvil refuses
// to overwrite it; the user ends up signing transactions against the
// wrong node. We give the dev anvil a deliberately distinct chain id
// (31338) so it lands as a brand-new MetaMask entry, and override the
// default RPC URL so reads, writes, mock-connector calls, and wallet
// labels all agree on the same endpoint.
export const FORK_CHAIN_ID = 31339
export const FORK_CHAIN_NAME = "Anvil fork (PND)"
// Cast through `unknown` because the upstream `foundry` chain object
// has `id: 31337` as a literal — TypeScript correctly notices we're
// overriding to a different literal. Runtime shape is identical; the
// strict literal type is the only thing in the way.
const foundry = {
  ...foundryBase,
  id: FORK_CHAIN_ID,
  name: FORK_CHAIN_NAME,
  rpcUrls: {
    ...foundryBase.rpcUrls,
    default: { ...foundryBase.rpcUrls.default, http: [anvilUrl] },
  },
} as unknown as typeof foundryBase

// Re-export the customized chain so dapp code (ChainSwitcher etc.) sees
// the same id/name/RPC the wagmi config uses. Importing the wagmi/chains
// `foundry` directly would resolve to the unmodified upstream version
// (id 31337, RPC localhost:8545) and silently disagree with the active
// config.
export const forkChain = foundry

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
