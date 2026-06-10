// Auto-extracted from contracts/out/ReleaseFactory.sol/ReleaseFactory.json.
// Re-run: node scripts/emit-releases-abi.mjs
export const releaseFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "owner_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "maxSurfaceFee_",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "surfaceFee_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "allReleases",
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
    "name": "createRelease",
    "inputs": [
      {
        "name": "params",
        "type": "tuple",
        "internalType": "struct ReleaseParams",
        "components": [
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
            "name": "price",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "startTime",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "endTime",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxSupply",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "gateToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "gateMode",
            "type": "uint8",
            "internalType": "enum GateMode"
          },
          {
            "name": "payout",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "royaltyReceiver",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "royaltyBps",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "uri",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "uriPerToken",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "renderer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "contractURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "release",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isRelease",
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
    "name": "maxSurfaceFee",
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
    "name": "pendingOwner",
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
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setSurfaceFee",
    "inputs": [
      {
        "name": "surfaceFee_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "surfaceFee",
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
    "name": "totalReleases",
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
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ReleaseCreated",
    "inputs": [
      {
        "name": "release",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "artist",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "surfaceFee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "params",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct ReleaseParams",
        "components": [
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
            "name": "price",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "startTime",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "endTime",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxSupply",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "gateToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "gateMode",
            "type": "uint8",
            "internalType": "enum GateMode"
          },
          {
            "name": "payout",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "royaltyReceiver",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "royaltyBps",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "uri",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "uriPerToken",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "renderer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "contractURI",
            "type": "string",
            "internalType": "string"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SurfaceFeeSet",
    "inputs": [
      {
        "name": "surfaceFee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  }
] as const;
