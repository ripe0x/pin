/**
 * Homage ("Homage to the Punk") — redeemable, $111-backed Albers homages,
 * one per CryptoPunk (`tokenId == punkId`, supply 10,000).
 *
 * Homage is a SOVEREIGN TWO-CONTRACT protocol (rebuilt from the earlier
 * single-monolith `Homage.sol`): the token lives in a pooled PND Collection
 * (a plain ERC-721 core), and minting/economics/redeem run through a
 * separate `HomageMinter` engine that mints INTO that collection.
 *
 *   - `homageMinterAbi`     — HomageMinter: the three phased mint writes
 *     (`claim` / `claimFor` / `claimTo` / `allowlistMint` / `mint`), `redeem`,
 *     every view the quote / eligibility / schedule / reveal plumbing reads,
 *     the `Minted`/`Claimed`/`Redeemed` events, and — critically — ALL 13
 *     custom `error` definitions, so viem decodes a revert selector to a
 *     named reason (`NotPunkOwner()`) instead of a bare `0x…` on a failed
 *     mint.
 *   - `homageCollectionAbi` — the pooled PND Collection (the ERC-721 core
 *     itself): `ownerOf` / `balanceOf` / `tokenURI` / `Transfer` ONLY.
 *     Ownership, transfers, and metadata live here; economics/schedule/
 *     supply/redeem do NOT — read those from the minter.
 *
 * The indexer keeps its own events-focused subset in
 * `apps/indexer/abis/Homage.ts` (still targeting the pre-rebuild monolith as
 * of this sync — see the note there); this one adds the writes for the web
 * `/mint/homage` venue.
 *
 * HAND-SYNCED SNAPSHOT — PENDING AUDIT FREEZE (launch-plan gate G1).
 * Synced from the Homage repo working tree
 * (/Users/dd/CascadeProjects/homage to the punk, sovereign-rebuild branch:
 * `contracts/src/HomageMinter.sol`), cross-checked against
 * `web/lib/homage.ts`'s `homageMinterAbi`/`homageCollectionAbi` (parseAbi
 * form — this file mirrors the same surface as PIN's raw-JSON-array ABI
 * style). Re-derive this file (and the renderer ABI below) from the audited
 * build before the mainnet deploy.
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

  // ── Reveal (views) ──────────────────────────────────────────────────
  // The escalating blank -> revealed curve: each homage is stamped at mint
  // with how much of it is revealed, keyed by MINT ORDER (not by which punk
  // was drawn) — the first mint is fully blank, the last fully revealed, and
  // later mints reveal faster (a staircase of quickening reveal across ten
  // 1,000-mint bands). Cleared on `redeem` so a re-drawn id starts blank
  // again under its own future mint order.
  {
    type: "function",
    name: "revealBpsOf",
    inputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "revealBpsFor",
    inputs: [{ name: "seq", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "bps", type: "uint256", internalType: "uint256" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "REVEAL_BPS_DENOM",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },

  // ── Custom errors ───────────────────────────────────────────────────
  // All 13, mirrored from HomageMinter.sol, so viem decodes a revert to its
  // name (e.g. `NotPunkOwner()`) and formatWriteError can surface it verbatim.
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
  { type: "error", name: "NotDelegated", inputs: [] },
  { type: "error", name: "AlreadyMinted", inputs: [] },
  { type: "error", name: "NotAllowlisted", inputs: [] },
  { type: "error", name: "AllowlistCapReached", inputs: [] },
  { type: "error", name: "BadSchedule", inputs: [] },
] as const

/**
 * The pooled PND Collection — the ERC-721 Homage mints INTO. Ownership,
 * transfers, and metadata (tokenURI delegates to the renderer slot) live
 * here; economics/schedule/redeem do NOT (see `homageMinterAbi`). This is
 * the ONLY contract whose `Transfer` events are the mint-reveal signal.
 */
export const homageCollectionAbi = [
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
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true, internalType: "address" },
      { name: "to", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
    ],
    anonymous: false,
  },
] as const

/**
 * HomageRendererSovereign — the shared punk-derived renderer behind the
 * collection's `tokenURI` (its base, `HomageRenderer`, does the actual Albers
 * art / color distillation / attributes; the Sovereign adapter only maps the
 * PND Collection renderer-slot calling convention onto it — see
 * `contracts/src/HomageRendererSovereign.sol`). Renders ANY punk id 0..9999
 * (minted or not) from the onchain punk pixels + live market status, so the
 * collection hero — and a future "explore before you mint" preview — can
 * show a representative homage without a token existing.
 *
 * Two call surfaces, both on this one renderer address:
 *   - the base `HomageRenderer` punk-id surface (`tokenURI(uint256)`,
 *     `renderSVG`, the PFP variants, `previewSVG`/`previewTokenURI`,
 *     `colorCount`, `collectionName`/`collectionDescription`) — what PIN's
 *     hero/sample reads use directly, unchanged in shape from before the
 *     rebuild except `previewSVG`/`previewTokenURI` DROPPED their `holder`
 *     param (now `(id, status)`, not `(id, status, holder)`).
 *   - the `IPreviewRenderer`/`IRenderer` adapter surface the PND Collection
 *     itself calls (`tokenURI(address,uint256)`, `contractURI(address)`,
 *     `previewURI(address,uint256,bytes32)` — a random-punk preview keyed by
 *     seed, ignoring the `collection`/`tokenId` args). Included here for
 *     completeness / a future direct-preview UI; PIN's descriptor hero read
 *     uses the punk-id `tokenURI(uint256)` overload today.
 *
 * Same hand-synced / pre-audit-freeze caveat as `homageMinterAbi` above.
 */
export const homageRendererAbi = [
  // ── base HomageRenderer punk-id surface ────────────────────────────
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
    // NOTE: (id, status) only — the pre-rebuild ABI had a third `holder`
    // param that no longer exists on HomageRenderer.previewSVG.
    type: "function",
    name: "previewSVG",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
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
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewSVGPfp",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewTokenURIPfp",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
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
  {
    type: "function",
    name: "collectionName",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "collectionDescription",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },

  // ── IPreviewRenderer / IRenderer adapter surface (PND Collection calls
  //    these; `collection` is ignored — the art derives only from the punk
  //    id / seed) ─────────────────────────────────────────────────────
  {
    type: "function",
    name: "tokenURI",
    inputs: [
      { name: "", type: "address", internalType: "address" },
      { name: "id", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "contractURI",
    inputs: [{ name: "", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewURI",
    inputs: [
      { name: "", type: "address", internalType: "address" },
      { name: "", type: "uint256", internalType: "uint256" },
      { name: "seed", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
] as const
