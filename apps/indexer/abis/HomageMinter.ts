/**
 * HomageMinter ABI — the subset PND's indexer needs.
 *
 * Homage ("Homage to the Punk") was rebuilt from a single-contract monolith
 * into the sovereign two-contract shape: minting/economics live on
 * HomageMinter (this ABI); the token itself lives on a pooled PND Collection
 * (a clone of the shared `PooledCollection`/`CollectionCore` — see
 * abis/HomageCollection.ts), NOT a bespoke Homage-specific ERC721. HomageMinter
 * calls `IPooledCollection(collection).mintToId(to, punkId, referrer, hookData)`
 * to mint and `burn(punkId)` (from `ICollectionCore`) to redeem — it holds no
 * ERC721 storage of its own.
 *
 * Registered in ponder.config.ts as the `HomageMinter` contract, ONLY when
 * HOMAGE_MINTER_ADDRESS + HOMAGE_MINTER_START_BLOCK (+ the paired
 * HomageCollection env vars) are set (deploy-gated, same pattern as before).
 *
 * Events drive homage_tokens / homage_activity / homage_config (Transfer
 * comes from the separate HomageCollection contract — see that ABI/handler).
 * View functions are included for parity/debug reads; handlers derive
 * everything from event args + the indexed config row, so no per-event
 * contract reads are made.
 *
 * HAND-SYNCED SNAPSHOT — pending final audit freeze (Phase 0 gate G1).
 * Derived from /Users/dd/CascadeProjects/homage to the punk
 * (branch sovereign-rebuild), contracts/src/HomageMinter.sol (verbatim event
 * declarations) and web/lib/homage.ts's homageMinterAbi (view/write
 * functions). Re-derive from the audited build before mainnet deploy + Ponder
 * redeploy.
 *
 * Renamed/removed vs the old monolith `abis/Homage.ts`:
 *   - `IPermanenceRenderer` is gone; the renderer lives on the collection
 *     (HomageRendererSovereign, set via CollectionFactory at deploy). No
 *     `renderer()` view remains on HomageMinter — it reads the collection's
 *     renderer live via `IPooledCollection(collection).renderer()` inside
 *     svg()/svgPfp(), so there's nothing for the indexer to mirror.
 *   - `RendererSet` event dropped (never had an indexer handler; renderer
 *     config now belongs to the collection, not the minter).
 *   - `tokenURI` view dropped — lives on the collection, not the minter.
 *   - `RevealStamped` event ADDED — new in the sovereign rebuild, not present
 *     in the old monolith. Carries the progressive-reveal stamp
 *     (punkId, mintSeq, revealBps). NOT YET wired into a handler/schema
 *     column in this pass — see src/Homage.ts's top comment for why.
 */
export const homageMinterAbi = [
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
  // Not yet consumed by a handler (see file header) — included for parity /
  // future wiring. mintSeq is the 0-indexed mint order (SUPPLY - remaining
  // at mint time), NOT the punk id; revealBps is the stamped reveal fraction.
  {
    type: "event",
    name: "RevealStamped",
    inputs: [
      { name: "punkId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "mintSeq", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "revealBps", type: "uint256", indexed: false, internalType: "uint256" },
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
  // No handler (vestigial in the old ABI too) — kept for parity since the
  // event still exists on-chain (HomageMinter.setFeeRecipient).
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
    name: "feeRecipient",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
] as const
