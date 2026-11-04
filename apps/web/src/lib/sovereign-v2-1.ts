import { isAddress, type Address } from "viem"
import {
  SOVEREIGN_AUCTION_HOUSE_V2_1_FACTORY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"

/**
 * The Sovereign Auction House V2.1 factory, or null while V2.1 is not
 * deployed (the @pin/addresses value is the zero address until then, and
 * every V2.1 surface folds off on that null).
 *
 * NEXT_PUBLIC_SOVEREIGN_V2_1_FACTORY overrides it for local fork testing,
 * like NEXT_PUBLIC_SURFACE_FACTORY in lib/collection.ts. Read through
 * `process.env.NEXT_PUBLIC_...` literally so Next inlines it into client
 * bundles. A set-but-invalid (or zero) override resolves to null rather
 * than falling back to the package value, so a typo in a fork env can't
 * silently point the UI at mainnet.
 */
export function sovereignV2_1Factory(
  env: string | undefined = process.env.NEXT_PUBLIC_SOVEREIGN_V2_1_FACTORY,
): Address | null {
  if (env !== undefined && env !== "") {
    return isAddress(env) && !/^0x0{40}$/i.test(env) ? (env as Address) : null
  }
  return getAddressOrNull(SOVEREIGN_AUCTION_HOUSE_V2_1_FACTORY, MAINNET_CHAIN_ID)
}
