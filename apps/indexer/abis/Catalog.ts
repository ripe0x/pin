// Events-only ABI for the Catalog contract — Ponder doesn't need the
// view/write functions for event indexing, and the slim shape keeps
// codegen output small. The canonical full ABI used by the web app
// lives in `packages/abi/src/catalog.ts`; mirror any future event
// additions here.
//
// Source: contracts/src/Catalog.sol — see the event declarations at
// lines 170-265 for the authoritative shape, and contracts/out/Catalog
// .sol/Catalog.json (Foundry build output, gitignored) for the wire-
// compatible JSON encoding.
export const catalogAbi = [
  {
    type: "event",
    name: "ContractAdded",
    inputs: [
      { name: "artist", type: "address", indexed: true, internalType: "address" },
      { name: "actor", type: "address", indexed: true, internalType: "address" },
      {
        name: "contractAddress",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ContractRemoved",
    inputs: [
      { name: "artist", type: "address", indexed: true, internalType: "address" },
      { name: "actor", type: "address", indexed: true, internalType: "address" },
      {
        name: "contractAddress",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TokenAdded",
    inputs: [
      { name: "artist", type: "address", indexed: true, internalType: "address" },
      { name: "actor", type: "address", indexed: true, internalType: "address" },
      {
        name: "contractAddress",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      { name: "tokenId", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TokenRemoved",
    inputs: [
      { name: "artist", type: "address", indexed: true, internalType: "address" },
      { name: "actor", type: "address", indexed: true, internalType: "address" },
      {
        name: "contractAddress",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      { name: "tokenId", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TokenRangeAdded",
    inputs: [
      { name: "artist", type: "address", indexed: true, internalType: "address" },
      { name: "actor", type: "address", indexed: true, internalType: "address" },
      {
        name: "contractAddress",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "startTokenId",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "endTokenId",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TokenRangeRemoved",
    inputs: [
      { name: "artist", type: "address", indexed: true, internalType: "address" },
      { name: "actor", type: "address", indexed: true, internalType: "address" },
      {
        name: "contractAddress",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "startTokenId",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "endTokenId",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
] as const
