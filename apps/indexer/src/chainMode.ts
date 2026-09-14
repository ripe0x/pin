import { ponder } from "ponder:registry"
import { readSurfaceV2Deployment } from "./surfaceV2Deployment"

/**
 * Network/contract-set gate shared by every handler file.
 *
 * ponder.config.ts computes SEPOLIA_MODE from the same env var
 * (PONDER_CHAIN_ID) but does not export it here: importing this module
 * from ponder.config.ts would pull in the "ponder:registry" virtual
 * module before the registry exists, since the registry's types are
 * generated FROM the config. So the two files each read the env var
 * independently; this module is for handler files only.
 *
 * Registering a ponder.on(...) handler for a contract absent from the
 * active config's `contracts` is a Ponder build error, not a no-op. In
 * SEPOLIA_MODE, ponder.config.ts's contracts are Surface v2 ONLY (no
 * SovereignAuctionHouse, Foundation, Catalog, SuperRare, discovery
 * factories, MURI, or Surface v1), so every handler for those contracts
 * must gate on MAINNET_MODE via `onIf` below instead of calling
 * `ponder.on` directly.
 */
export const SEPOLIA_MODE = Number(process.env.PONDER_CHAIN_ID ?? 1) === 11_155_111
export const MAINNET_MODE = !SEPOLIA_MODE

const NETWORK: "mainnet" | "sepolia" = SEPOLIA_MODE ? "sepolia" : "mainnet"

// Whether the Surface v2 factory is wired into the active network's
// config (contracts/deployments.<network>.json carries a
// surfaceFactoryV2). True in SEPOLIA_MODE (ponder.config.ts throws
// otherwise) and false in mainnet mode until the mainnet v2 broadcast
// lands.
export const SURFACE_V2_WIRED = Boolean(readSurfaceV2Deployment(NETWORK))

type Handler = (args: { event: any; context: any }) => Promise<void> | void

// Registers `fn` for `name` only when `enabled`, a no-op otherwise. Takes
// `name` as a plain string (not the ponder:registry event-name union)
// because that union changes shape between mainnet mode and
// SEPOLIA_MODE, and a gated handler must compile under both.
export function onIf(enabled: boolean, name: string, fn: Handler): void {
  if (enabled) {
    ;(ponder.on as unknown as (n: string, f: Handler) => void)(name, fn)
  }
}
