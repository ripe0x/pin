/**
 * Vouch — onchain-generative ERC-721 (cubes-witness / `Vouch.sol`).
 *
 * One seat per token (52 max), no-arg one-per-wallet `mint()` inside a fixed
 * 24h window at a contract-read price (`MINT_PRICE`), then a seat lifecycle:
 * free `renew()` keeps the 30-day clock alive, a lapsed seat is reclaimable by
 * anyone via `claim()` at the mint price. Art is fully onchain — `tokenURI`
 * delegates to a swappable renderer that returns a `data:application/json`
 * blob with an inline SVG.
 *
 * NOTE: hand-synced from the cubes-witness working tree (commit 6e48a75 + local
 * edits). That contract is still in flux — regenerate this ABI from the
 * compiled artifact when it's finalized. The `RenderState` tuple in particular
 * recently gained a trailing `owner` field; keep the components in lockstep
 * with `src/VouchTypes.sol`.
 */
export const vouchAbi = [
  // ── Events ──────────────────────────────────────────────────────────
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true, internalType: "address" },
      { name: "to", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Renewed",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "by", type: "address", indexed: true, internalType: "address" },
      { name: "newLastRenewedAt", type: "uint64", indexed: false, internalType: "uint64" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "from", type: "address", indexed: true, internalType: "address" },
      { name: "to", type: "address", indexed: true, internalType: "address" },
      { name: "newPositionKey", type: "uint64", indexed: false, internalType: "uint64" },
    ],
    anonymous: false,
  },

  // ── Mint / lifecycle (writes) ───────────────────────────────────────
  { type: "function", name: "mint", inputs: [], outputs: [], stateMutability: "payable" },
  {
    type: "function",
    name: "renew",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claim",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "payable",
  },

  // ── Constants / config (views) ──────────────────────────────────────
  {
    type: "function",
    name: "MAX_SUPPLY",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MINT_PRICE",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MINT_WINDOW",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ACTIVE_PERIOD",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "mintStart",
    inputs: [],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },

  // ── State reads (views) ─────────────────────────────────────────────
  {
    type: "function",
    name: "totalMinted",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hasMinted",
    inputs: [{ name: "", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "exists",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "expiresAt",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isActive",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "freshnessBps",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint16", internalType: "uint16" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lastRenewedAt",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "generation",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint32", internalType: "uint32" }],
    stateMutability: "view",
  },

  // ── Render state (struct; keep in lockstep with VouchTypes.sol) ──────
  {
    type: "function",
    name: "getRenderState",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [
      {
        name: "s",
        type: "tuple",
        internalType: "struct RenderState",
        components: [
          { name: "minted", type: "bool", internalType: "bool" },
          { name: "active", type: "bool", internalType: "bool" },
          { name: "freshnessBps", type: "uint16", internalType: "uint16" },
          { name: "expiresAt", type: "uint64", internalType: "uint64" },
          { name: "positionKey", type: "uint64", internalType: "uint64" },
          { name: "owner", type: "address", internalType: "address" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRenderStates",
    inputs: [
      { name: "from", type: "uint256", internalType: "uint256" },
      { name: "to", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      {
        name: "states",
        type: "tuple[]",
        internalType: "struct RenderState[]",
        components: [
          { name: "minted", type: "bool", internalType: "bool" },
          { name: "active", type: "bool", internalType: "bool" },
          { name: "freshnessBps", type: "uint16", internalType: "uint16" },
          { name: "expiresAt", type: "uint64", internalType: "uint64" },
          { name: "positionKey", type: "uint64", internalType: "uint64" },
          { name: "owner", type: "address", internalType: "address" },
        ],
      },
    ],
    stateMutability: "view",
  },

  // ── ERC-721 surface used by the UI ──────────────────────────────────
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "owner", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "tokenId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
] as const;
