// Auto-extracted from contracts/out/GenerativeRenderer.sol/GenerativeRenderer.json.
// Re-run: node scripts/emit-collection-abi.mjs
export const generativeRendererAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "scriptyBuilder_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "renderAssets_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "gunzipStore_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "gunzipFile_",
        "type": "string",
        "internalType": "string"
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
    "name": "gunzipFile",
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
    "name": "gunzipStore",
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
    "name": "lockWork",
    "inputs": [
      {
        "name": "collection",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
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
    "name": "scriptyBuilder",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IScriptyBuilderV2"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setWork",
    "inputs": [
      {
        "name": "collection",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "work",
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
    "outputs": [],
    "stateMutability": "nonpayable"
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
    "type": "function",
    "name": "workLockedOf",
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
    "name": "workOf",
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
  },
  {
    "type": "event",
    "name": "WorkLocked",
    "inputs": [
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
    "type": "event",
    "name": "WorkSet",
    "inputs": [
      {
        "name": "collection",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "codeHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "NotCollectionAdmin",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WorkIsLocked",
    "inputs": []
  }
] as const;
