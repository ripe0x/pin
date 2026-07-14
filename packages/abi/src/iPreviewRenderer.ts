// Auto-extracted from contracts/out/IPreviewRenderer.sol/IPreviewRenderer.json.
// Re-run: node scripts/emit-surface-abi.mjs
export const iPreviewRendererAbi = [
  {
    "type": "function",
    "name": "previewURI",
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
      },
      {
        "name": "seed",
        "type": "bytes32",
        "internalType": "bytes32"
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
  }
] as const;
