/**
 * Test seeds for studio preview. A test seed is an ordinary tokenData
 * with a synthetic hash; nothing else may differ from production
 * injection (parity rule from docs/injection-convention.md).
 */

import { keccak256, toHex } from "viem";

import type { TokenData } from "./types";

/** Deterministic synthetic seed i (stable across sessions and surfaces). */
export function testSeed(i: number): string {
  return keccak256(toHex(`sovereign-test-seed:${i}`, { size: 32 }));
}

export function makeTestTokenData(params: {
  index: number;
  collection?: string;
  chainId?: number;
  injectionVersion?: number;
}): TokenData {
  const { index } = params;
  return {
    hash: testSeed(index),
    tokenId: String(index + 1),
    mintIndex: index,
    mintBlock: 0,
    collection: (params.collection ?? "0x" + "0".repeat(40)).toLowerCase(),
    chainId: params.chainId ?? 1,
    version: params.injectionVersion ?? 1,
  };
}
