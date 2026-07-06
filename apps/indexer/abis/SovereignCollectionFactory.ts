// Auto-extracted from contracts/out/SovereignCollectionFactory.sol/SovereignCollectionFactory.json.
// Re-run: node scripts/emit-collection-abi.mjs
export const sovereignCollectionFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "implementation_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "defaultRenderer_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "attribution_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "allCollections",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
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
    "name": "attribution",
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
    "name": "createCollection",
    "inputs": [
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "symbol",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
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
            "name": "kind",
            "type": "uint8",
            "internalType": "enum CollectionKind"
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
        "name": "workCfg",
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
      },
      {
        "name": "initialMinters",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "artists",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "outputs": [
      {
        "name": "collection",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "defaultRenderer",
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
    "name": "implementation",
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
    "name": "isCollection",
    "inputs": [
      {
        "name": "",
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
    "name": "totalCollections",
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
    "type": "event",
    "name": "CollectionCreated",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "collection",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "FailedDeployment",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientBalance",
    "inputs": [
      {
        "name": "balance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  }
] as const;
