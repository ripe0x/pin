/**
 * Homage ("Homage to the Punk") — redeemable, $111-backed Albers homages,
 * one per CryptoPunk (`tokenId == punkId`, supply 10,000).
 *
 * The web-side ABI for the `/mint/homage` venue: the three phased mint writes
 * (`claim` / `allowlistMint` / `mint`), `redeem`, and every view the quote /
 * eligibility / schedule plumbing reads. The indexer keeps its own
 * events-focused subset in `apps/indexer/abis/Homage.ts`; this one adds the
 * writes and — critically — ALL 12 custom `error` definitions, so viem
 * decodes a revert selector to a named reason (`NotPunkOwner()`) instead of
 * a bare `0x…` when a mint fails.
 *
 * HAND-SYNCED SNAPSHOT — PENDING AUDIT FREEZE (launch-plan gate G1).
 * Synced from the Homage repo working tree
 * (/Users/dd/CascadeProjects/homage to the punk: `contracts/src/Homage.sol`,
 * cross-checked against `web/lib/homage.ts` and the forge artifact
 * `contracts/out/Homage.sol/Homage.json`). The contract ABI is NOT frozen
 * yet: re-derive this file (and the renderer ABI below) from the audited
 * build before the mainnet deploy.
 */
export const homageAbi = [
  // ── Events ──────────────────────────────────────────────────────────
  {
    type: "event",
    name: "Minted",
    inputs: [
      { name: "to", type: "address", indexed: true, internalType: "address" },
      { name: "punkId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "ethSwapped", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "received111", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "to", type: "address", indexed: true, internalType: "address" },
      { name: "punkId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "ethSwapped", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "received111", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Redeemed",
    inputs: [
      { name: "from", type: "address", indexed: true, internalType: "address" },
      { name: "punkId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "amount111", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
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

  // ── Mint / redeem (writes) ──────────────────────────────────────────
  {
    type: "function",
    name: "mint",
    inputs: [],
    outputs: [{ name: "punkId", type: "uint256", internalType: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "claim",
    inputs: [{ name: "punkId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "claimFor",
    inputs: [
      { name: "punkId", type: "uint256", internalType: "uint256" },
      { name: "vault", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "claimTo",
    inputs: [{ name: "punkId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "allowlistMint",
    inputs: [{ name: "proof", type: "bytes32[]", internalType: "bytes32[]" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "redeem",
    inputs: [{ name: "punkId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "payable",
  },

  // ── Economics (views) ───────────────────────────────────────────────
  {
    type: "function",
    name: "THRESHOLD",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "baseFee",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "feeGrowthBps",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "publicMints",
    inputs: [{ name: "who", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "mintFeeOf",
    inputs: [{ name: "who", type: "address", internalType: "address" }],
    outputs: [{ name: "fee", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "exitFee",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },

  // ── Schedule (views) ────────────────────────────────────────────────
  {
    type: "function",
    name: "claimStart",
    inputs: [],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowlistStart",
    inputs: [],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "publicStart",
    inputs: [],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },

  // ── Allowlist (views) ───────────────────────────────────────────────
  {
    type: "function",
    name: "allowlistRoot",
    inputs: [],
    outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "maxPerAllowlisted",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowlistMinted",
    inputs: [{ name: "who", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },

  // ── Supply / token state (views) ────────────────────────────────────
  {
    type: "function",
    name: "SUPPLY",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "remaining",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalMinted",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isMinted",
    inputs: [{ name: "punkId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
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
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
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
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "svg",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },

  // ── Custom errors ───────────────────────────────────────────────────
  // All 12, mirrored from Homage.sol, so viem decodes a revert to its name
  // (e.g. `NotPunkOwner()`) and formatWriteError can surface it verbatim.
  { type: "error", name: "NotManager", inputs: [] },
  { type: "error", name: "BadValue", inputs: [] },
  { type: "error", name: "SoldOut", inputs: [] },
  {
    type: "error",
    name: "Slippage",
    inputs: [
      { name: "received", type: "uint256", internalType: "uint256" },
      { name: "needed", type: "uint256", internalType: "uint256" },
    ],
  },
  { type: "error", name: "ClaimClosed", inputs: [] },
  { type: "error", name: "AllowlistClosed", inputs: [] },
  { type: "error", name: "PublicClosed", inputs: [] },
  { type: "error", name: "NotPunkOwner", inputs: [] },
  { type: "error", name: "AlreadyMinted", inputs: [] },
  { type: "error", name: "NotAllowlisted", inputs: [] },
  { type: "error", name: "AllowlistCapReached", inputs: [] },
  { type: "error", name: "BadSchedule", inputs: [] },
] as const

/**
 * PermanenceRenderer — the shared punk-derived renderer behind Homage's
 * `tokenURI`. Renders ANY punk id 0..9999 (minted or not) from the onchain
 * punk pixels + live market status, so the collection hero can show a
 * representative homage without a token existing. Same hand-synced /
 * pre-audit-freeze caveat as `homageAbi` above.
 */
export const permanenceRendererAbi = [
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURIPfp",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "renderSVG",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "renderSVGPfp",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewSVG",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
      { name: "holder", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewTokenURI",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
      { name: "holder", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "colorCount",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
] as const
