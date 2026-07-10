// Auto-extracted from contracts/out/IMintHook.sol/IMintHook.json.
// Re-run: node scripts/emit-collection-abi.mjs
export const iMintHookAbi = [
  {
    "type": "function",
    "name": "afterMint",
    "inputs": [
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
        "name": "firstTokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "referrer",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "hookData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeMint",
    "inputs": [
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
        "name": "firstTokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "referrer",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "hookData",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "nonpayable"
  }
] as const;
