import type { Address } from "viem"
import { surfaceAbi } from "./abi"

export function buildMintWithRewardsRequest({
  collectionAddress,
  artistAddress,
  priceWei,
}: {
  collectionAddress: Address
  artistAddress: Address
  priceWei: bigint
}) {
  return {
    address: collectionAddress,
    abi: surfaceAbi,
    functionName: "mintWithRewards" as const,
    args: [1n, artistAddress, "0x"] as const,
    value: priceWei,
  }
}
