import { encodeAbiParameters, type Address, type Hex } from "viem"
import { fixedPriceMinterAbi } from "@pin/abi"
import { ZERO_ADDRESS, quoteFixedPrice } from "./lifecycle.ts"
import type { PreparedTransaction } from "./types.ts"

export const EMPTY_ALLOWLIST_ROOT = `0x${"0".repeat(64)}` as Hex

export type FixedPriceMintInput = {
  chainId: number
  minter: Address
  recipient: Address
  quantity: bigint
  referrer?: Address
  totalValue: bigint
  allowlistProof?: readonly Hex[]
}

export function encodeAllowlistProof(proof?: readonly Hex[]): Hex {
  return proof?.length
    ? encodeAbiParameters([{ type: "bytes32[]" }], [proof])
    : "0x"
}

/**
 * Builds the canonical FixedPriceMinter call without submitting it. The
 * caller owns quote freshness and wallet submission; both PND and an
 * artist-owned site therefore send identical calldata for identical input.
 */
export function prepareFixedPriceMint(input: FixedPriceMintInput): PreparedTransaction {
  if (input.quantity < 1n) throw new RangeError("Mint quantity must be at least one")
  return {
    chainId: input.chainId,
    target: input.minter,
    abi: fixedPriceMinterAbi,
    functionName: "mint",
    args: [
      input.recipient,
      input.quantity,
      input.referrer ?? ZERO_ADDRESS,
      encodeAllowlistProof(input.allowlistProof),
    ],
    value: input.totalValue,
    effects: ["mint", "settle", "referral"],
  }
}

export function prepareFixedUnitPriceMint(
  input: Omit<FixedPriceMintInput, "totalValue"> & { unitPrice: bigint },
): PreparedTransaction {
  return prepareFixedPriceMint({
    ...input,
    totalValue: quoteFixedPrice(input.unitPrice, input.quantity),
  })
}
