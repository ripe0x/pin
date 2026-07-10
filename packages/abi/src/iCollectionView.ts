// Auto-extracted from contracts/out/IRenderer.sol/ICollectionView.json.
// Re-run: node scripts/emit-collection-abi.mjs
export const iCollectionViewAbi = [
  {
    "type": "function",
    "name": "artwork",
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
    "name": "config",
    "inputs": [],
    "outputs": [
      {
        "name": "cfg",
        "type": "tuple",
        "internalType": "struct CollectionConfig",
        "components": [
          {
            "name": "artworkURI",
            "type": "string",
            "internalType": "string"
          },
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
            "name": "idMode",
            "type": "uint8",
            "internalType": "enum IdMode"
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
    "name": "isWorkLocked",
    "inputs": [],
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
    "name": "tokenArtwork",
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
  },
  {
    "type": "function",
    "name": "workConfig",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct WorkConfig",
        "components": [
          {
            "name": "code",
            "type": "tuple[]",
            "internalType": "struct CodeRef[]",
            "components": [
              {
                "name": "store",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "name",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "kind",
                "type": "uint8",
                "internalType": "enum CodeKind"
              }
            ]
          },
          {
            "name": "deps",
            "type": "tuple[]",
            "internalType": "struct CodeRef[]",
            "components": [
              {
                "name": "store",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "name",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "kind",
                "type": "uint8",
                "internalType": "enum CodeKind"
              }
            ]
          },
          {
            "name": "codeURI",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "codeHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "liveness",
            "type": "uint8",
            "internalType": "enum Liveness"
          },
          {
            "name": "injectionVersion",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "renderParams",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "stateMutability": "view"
  }
] as const;
