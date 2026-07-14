// Auto-extracted from contracts/out/IPriceStrategy.sol/IPriceStrategy.json.
// Re-run: node scripts/emit-surface-abi.mjs
export const iPriceStrategyAbi = [
  {
    "type": "function",
    "name": "priceOf",
    "inputs": [
      {
        "name": "collection",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "minter",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "quantity",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  }
] as const;
