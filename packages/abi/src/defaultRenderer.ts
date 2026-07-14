// Auto-extracted from contracts/out/DefaultRenderer.sol/DefaultRenderer.json.
// Re-run: node scripts/emit-surface-abi.mjs
export const defaultRendererAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "renderAssets_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "contractURI",
    "inputs": [
      {
        "name": "collection",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renderAssets",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract RenderAssets"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tokenURI",
    "inputs": [
      {
        "name": "collection",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "error",
    "name": "AssetsRequired",
    "inputs": []
  }
] as const;
