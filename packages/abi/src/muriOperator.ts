// Auto-extracted from contracts/out/MuriOperator.sol/MuriOperator.json.
// Re-run: node scripts/emit-collection-abi.mjs
export const muriOperatorAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "muri_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "initializeTokenData",
    "inputs": [
      {
        "name": "contractAddress",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "config",
        "type": "tuple",
        "internalType": "struct IMURIProtocol.InitConfig",
        "components": [
          {
            "name": "metadata",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "artwork",
            "type": "tuple",
            "internalType": "struct IMURIProtocol.Artwork",
            "components": [
              {
                "name": "artistUris",
                "type": "string[]",
                "internalType": "string[]"
              },
              {
                "name": "collectorUris",
                "type": "string[]",
                "internalType": "string[]"
              },
              {
                "name": "mimeType",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "fileHash",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "isAnimationUri",
                "type": "bool",
                "internalType": "bool"
              },
              {
                "name": "selectedArtistUriIndex",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "thumbnail",
            "type": "tuple",
            "internalType": "struct IMURIProtocol.Thumbnail",
            "components": [
              {
                "name": "kind",
                "type": "uint8",
                "internalType": "enum IMURIProtocol.ThumbnailKind"
              },
              {
                "name": "onChain",
                "type": "tuple",
                "internalType": "struct IMURIProtocol.OnChainThumbnail",
                "components": [
                  {
                    "name": "mimeType",
                    "type": "string",
                    "internalType": "string"
                  },
                  {
                    "name": "chunks",
                    "type": "address[]",
                    "internalType": "address[]"
                  },
                  {
                    "name": "zipped",
                    "type": "bool",
                    "internalType": "bool"
                  }
                ]
              },
              {
                "name": "offChain",
                "type": "tuple",
                "internalType": "struct IMURIProtocol.OffChainThumbnail",
                "components": [
                  {
                    "name": "uris",
                    "type": "string[]",
                    "internalType": "string[]"
                  },
                  {
                    "name": "selectedUriIndex",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              }
            ]
          },
          {
            "name": "displayMode",
            "type": "uint8",
            "internalType": "enum IMURIProtocol.DisplayMode"
          },
          {
            "name": "permissions",
            "type": "tuple",
            "internalType": "struct IMURIProtocol.Permissions",
            "components": [
              {
                "name": "flags",
                "type": "uint16",
                "internalType": "uint16"
              }
            ]
          },
          {
            "name": "htmlTemplate",
            "type": "tuple",
            "internalType": "struct IMURIProtocol.HtmlTemplate",
            "components": [
              {
                "name": "chunks",
                "type": "address[]",
                "internalType": "address[]"
              },
              {
                "name": "zipped",
                "type": "bool",
                "internalType": "bool"
              }
            ]
          }
        ]
      },
      {
        "name": "thumbnailChunks",
        "type": "bytes[]",
        "internalType": "bytes[]"
      },
      {
        "name": "htmlTemplateChunks",
        "type": "string[]",
        "internalType": "string[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isTokenOwner",
    "inputs": [
      {
        "name": "creatorContract",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "account",
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
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "muri",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IMURIProtocol"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "supportsInterface",
    "inputs": [
      {
        "name": "interfaceId",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "error",
    "name": "MuriRequired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotContractAdmin",
    "inputs": []
  }
] as const;
