import { keccak256, toHex } from "viem"
import type { TokenData } from "./types.ts"

export function testSeed(index: number): string {
  return keccak256(toHex(`sovereign-test-seed:${index}`, { size: 32 }))
}

export function makeTestTokenData(options: {
  index: number
  collection?: string
  chainId?: number
  injectionVersion?: number
}): TokenData {
  return {
    hash: testSeed(options.index),
    tokenId: String(options.index + 1),
    collection: (options.collection ?? `0x${"0".repeat(40)}`).toLowerCase(),
    chainId: options.chainId ?? 1,
    version: options.injectionVersion ?? 1,
    context: "preview",
  }
}
