/**
 * Foundation-specific ABI entries beyond standard ERC-721.
 *
 * These are extensions on the FoundationNFT contract
 * (0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405) that are needed
 * for discovering which tokens an artist minted.
 *
 * Source: https://github.com/f8n/fnd-protocol
 */
export const foundationNftAbi = [
  // Emitted when a new token is minted on the shared contract
  {
    type: "event",
    name: "Minted",
    inputs: [
      { name: "creator", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "indexedTokenIPFSPath", type: "string", indexed: true },
      { name: "tokenIPFSPath", type: "string", indexed: false },
    ],
  },
  // Returns the creator/artist of a given token
  {
    type: "function",
    name: "tokenCreator",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "creator", type: "address" }],
  },
  // Standard tokenURI (included for convenience — also in erc721Abi)
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const

/** ABI for the NFTCollectionFactory (V1 and V2) */
export const collectionFactoryAbi = [
  // Emitted when an artist deploys a new 1/1 collection contract
  {
    type: "event",
    name: "NFTCollectionCreated",
    inputs: [
      { name: "collection", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "version", type: "uint256", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  // Legacy pre-rename event — V1 factory originally emitted this name.
  // Identical indexed layout; only the event name (and therefore topic0)
  // differs. Early collections (before Foundation's rename) emit this one.
  {
    type: "event",
    name: "CollectionCreated",
    inputs: [
      { name: "collection", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "version", type: "uint256", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  // Emitted when an artist deploys a drop collection
  {
    type: "event",
    name: "NFTDropCollectionCreated",
    inputs: [
      { name: "collection", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "approvedMinter", type: "address", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "baseURI", type: "string", indexed: false },
      { name: "isRevealed", type: "bool", indexed: false },
      { name: "maxTokenId", type: "uint256", indexed: false },
      { name: "paymentAddress", type: "address", indexed: false },
      { name: "version", type: "uint256", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
] as const
