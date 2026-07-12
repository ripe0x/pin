// Auto-extracted from contracts/out/IRenderer.sol/ICollectionView.json.
// Re-run: node scripts/emit-collection-abi.mjs
export const iCollectionViewAbi = [
  {
    "type": "function",
    "name": "config",
    "inputs": [],
    "outputs": [
      {
        "name": "cfg",
        "type": "tuple",
        "internalType": "struct CollectionConfig",
        "components": [
          {
            "name": "price",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "supplyCap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "mintStart",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "mintEnd",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "royaltyBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "royaltyReceiver",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "payoutAddress",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "renderer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "mintHook",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "priceStrategy",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "rendererLocked",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "supplyLocked",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      },
      {
        "name": "status",
        "type": "uint8",
        "internalType": "enum CollectionStatus"
      },
      {
        "name": "minted",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "idMode",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "enum IdMode"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isAdmin",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "name",
    "inputs": [],
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
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "symbol",
    "inputs": [],
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
    "name": "tokenSeed",
    "inputs": [
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalSupply",
    "inputs": [],
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
