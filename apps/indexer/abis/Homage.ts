/**
 * Homage ("Homage to the Punk") ABI — the subset PND's indexer needs.
 *
 * Fixed shared singleton (like MURI): one self-contained ERC-721 mint,
 * `tokenId == punkId`, supply 10,000, redeemable (redeem returns the id to
 * the mintable pool so tokens churn). Registered in ponder.config.ts ONLY
 * when HOMAGE_ADDRESS + HOMAGE_START_BLOCK are set (deploy-gated).
 *
 * Events drive the homage_tokens / homage_activity / homage_config tables.
 * View functions are included for parity/debug reads; the handlers derive
 * everything they need from event args + the indexed config row, so no
 * per-event contract reads are made (unlike MURI's getArtwork).
 *
 * HAND-SYNCED SNAPSHOT — pending final audit freeze (Phase 0 gate G1).
 * Generated from the Homage repo forge build output
 * (contracts/out/Homage.sol/Homage.json) at
 * /Users/dd/CascadeProjects/homage to the punk. The contract ABI is NOT
 * frozen yet: re-derive this file from the audited build before mainnet
 * deploy + Ponder redeploy. Event shapes assumed stable:
 *   Minted / Claimed  (address indexed to,  uint256 indexed punkId, uint256 ethSwapped, uint256 received111)
 *   Redeemed          (address indexed from, uint256 indexed punkId, uint256 amount111)
 *   ScheduleSet       (uint64 claimStart, uint64 allowlistStart, uint64 publicStart)
 *   AllowlistRootSet  (bytes32 root)
 *   MaxPerAllowlistedSet (uint256 max)
 *   FeeScheduleSet    (uint256 baseFee, uint256 feeGrowthBps)
 *   ExitFeeSet        (uint256 exitFee)
 *   plus standard ERC-721 Transfer.
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
  {
    type: "event",
    name: "ScheduleSet",
    inputs: [
      { name: "claimStart", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "allowlistStart", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "publicStart", type: "uint64", indexed: false, internalType: "uint64" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "AllowlistRootSet",
    inputs: [{ name: "root", type: "bytes32", indexed: false, internalType: "bytes32" }],
    anonymous: false,
  },
  {
    type: "event",
    name: "MaxPerAllowlistedSet",
    inputs: [{ name: "max", type: "uint256", indexed: false, internalType: "uint256" }],
    anonymous: false,
  },
  {
    type: "event",
    name: "FeeScheduleSet",
    inputs: [
      { name: "baseFee", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "feeGrowthBps", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ExitFeeSet",
    inputs: [{ name: "exitFee", type: "uint256", indexed: false, internalType: "uint256" }],
    anonymous: false,
  },
  {
    type: "event",
    name: "RendererSet",
    inputs: [{ name: "renderer", type: "address", indexed: false, internalType: "address" }],
    anonymous: false,
  },
  {
    type: "event",
    name: "FeeRecipientSet",
    inputs: [{ name: "feeRecipient", type: "address", indexed: false, internalType: "address" }],
    anonymous: false,
  },

  // ── Views (parity / debug — handlers do NOT read these per-event) ────
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
    name: "exitFee",
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
    name: "SUPPLY",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "THRESHOLD",
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
  {
    type: "function",
    name: "mintFeeOf",
    inputs: [{ name: "who", type: "address", internalType: "address" }],
    outputs: [{ name: "fee", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "renderer",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "contract IPermanenceRenderer" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "feeRecipient",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
] as const
