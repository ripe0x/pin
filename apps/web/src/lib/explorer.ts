/**
 * evm.now explorer URL helpers (chain-aware via the `chainId` query param).
 * Standing project rule: user-facing tx/address links use evm.now, never a
 * chain-specific explorer. Defaults to mainnet.
 */
import { MAINNET_CHAIN_ID } from "@pin/addresses"

export function getEvmNowTxUrl(hash: string, chainId: number = MAINNET_CHAIN_ID): string {
  return `https://evm.now/tx/${hash}?chainId=${chainId}`
}

export function getEvmNowAddressUrl(
  address: string,
  chainId: number = MAINNET_CHAIN_ID,
): string {
  return `https://evm.now/address/${address}?chainId=${chainId}`
}

export function getEvmNowTokenUrl(
  address: string,
  chainId: number = MAINNET_CHAIN_ID,
): string {
  return `https://evm.now/token/${address}?chainId=${chainId}`
}
