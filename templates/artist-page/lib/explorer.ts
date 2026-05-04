export const explorerAddressUrl = (address: string): string =>
  `https://evm.now/address/${address}`

export const explorerTxUrl = (txHash: string): string =>
  `https://evm.now/tx/${txHash}`
