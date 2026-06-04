/**
 * MURI Protocol singleton ABI — the subset PND's indexer needs.
 *
 * Events drive the `muri_tokens` / `muri_contracts` tables. `getArtwork`
 * is read once per data-changing event to recompute authoritative URI
 * counts (the `TokenDataInitialized` event carries no count). Reads are
 * bounded to MURI events, which are low-volume — see ponder.config.ts.
 *
 * Source: github.com/ygtdmn/muri-protocol (verified against the on-chain
 * singleton 0x0000000000C2A0B63ab4aA971B08B905E5875b01).
 */
export const muriProtocolAbi = [
  // ── Events ──────────────────────────────────────────────────────────
  {
    type: "event",
    name: "ContractRegistered",
    inputs: [
      { name: "contractAddress", type: "address", indexed: true, internalType: "address" },
      { name: "implementationAddress", type: "address", indexed: true, internalType: "address" },
      { name: "registerer", type: "address", indexed: true, internalType: "address" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TokenDataInitialized",
    inputs: [
      { name: "creator", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ArtworkUrisAdded",
    inputs: [
      { name: "creator", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "actor", type: "address", indexed: true, internalType: "address" },
      { name: "count", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ArtworkUriRemoved",
    inputs: [
      { name: "creator", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "actor", type: "address", indexed: true, internalType: "address" },
      { name: "index", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SelectedArtworkUriChanged",
    inputs: [
      { name: "creator", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "newIndex", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DisplayModeUpdated",
    inputs: [
      { name: "creator", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "displayMode", type: "uint8", indexed: false, internalType: "enum IMURIProtocol.DisplayMode" },
    ],
    anonymous: false,
  },

  // ── Views ───────────────────────────────────────────────────────────
  {
    type: "function",
    name: "getArtwork",
    inputs: [
      { name: "contractAddress", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct IMURIProtocol.Artwork",
        components: [
          { name: "artistUris", type: "string[]", internalType: "string[]" },
          { name: "collectorUris", type: "string[]", internalType: "string[]" },
          { name: "mimeType", type: "string", internalType: "string" },
          { name: "fileHash", type: "string", internalType: "string" },
          { name: "isAnimationUri", type: "bool", internalType: "bool" },
          { name: "selectedArtistUriIndex", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const
