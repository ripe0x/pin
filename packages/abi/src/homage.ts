/**
 * Homage ("Homage to the Punk") — redeemable, $111-backed Albers homages,
 * one per CryptoPunk (`tokenId == punkId`, supply 10,000).
 *
 * Homage is a SOVEREIGN TWO-CONTRACT protocol (rebuilt from the earlier
 * single-monolith `Homage.sol`): the token lives in a pooled PND Collection
 * (a plain ERC-721 core), and minting/economics/redeem run through a
 * separate `HomageMinter` engine that mints INTO that collection.
 *
 *   - `homageMinterAbi`     — HomageMinter: the phased mint writes
 *     (`claim` / `claimFor` / `claimTo` / `allowlistMint` /
 *     `allowlistMintAsHolder` / `allowlistMintAsHolderFor` / `mint` /
 *     `mintBatch`), `redeem`,
 *     every view the quote / eligibility / schedule plumbing reads, every
 *     event the contract emits, and every custom `error` it defines, so
 *     viem decodes a revert selector to a named reason (`NotPunkOwner()`)
 *     instead of a bare `0x...` on a failed mint.
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
 * `homageMinterAbi`'s errors and events are generated from the compiled
 * `HomageMinter.sol` artifact (`out/HomageMinter.sol/HomageMinter.json`),
 * built from the Homage repo at commit f2d231f (origin/master), confirmed
 * byte-identical to the deployed sepolia bytecode at
 * `0xc9f3c81556fcb4cf70a37d1a7248d6ec68256b7c` outside of immutable slots.
 * Function entries are unchanged from the prior hand-synced set; re-run
 * `pnpm --filter web check:abi` and diff against a fresh artifact before the
 * mainnet deploy.
 */
export const homageMinterAbi = [
  // ── Events ──────────────────────────────────────────────────────────
  { type: "event", name: "Activated", inputs: [], anonymous: false },
  {
    type: "event",
    name: "AllowlistRootSet",
    inputs: [{ name: "root", type: "bytes32", indexed: false, internalType: "bytes32" }],
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
    name: "ExitFeeSet",
    inputs: [{ name: "exitFee", type: "uint256", indexed: false, internalType: "uint256" }],
    anonymous: false,
  },
  {
    type: "event",
    name: "FeeRecipientSet",
    inputs: [{ name: "feeRecipient", type: "address", indexed: false, internalType: "address" }],
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
    name: "OwnershipTransferred",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true, internalType: "address" },
      { name: "newOwner", type: "address", indexed: true, internalType: "address" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RedeemDelaySet",
    inputs: [{ name: "redeemDelay", type: "uint64", indexed: false, internalType: "uint64" }],
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
    name: "ReservationReleased",
    inputs: [{ name: "punkId", type: "uint256", indexed: true, internalType: "uint256" }],
    anonymous: false,
  },
  {
    type: "event",
    name: "Reserved",
    inputs: [
      { name: "punkId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "by", type: "address", indexed: true, internalType: "address" },
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
    name: "ThresholdSet",
    inputs: [{ name: "threshold", type: "uint256", indexed: false, internalType: "uint256" }],
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
    name: "mintBatch",
    inputs: [{ name: "qty", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "ids", type: "uint256[]", internalType: "uint256[]" }],
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
    name: "allowlistMintAsHolder",
    inputs: [{ name: "punkId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "allowlistMintAsHolderFor",
    inputs: [
      { name: "punkId", type: "uint256", internalType: "uint256" },
      { name: "vault", type: "address", internalType: "address" },
    ],
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
  {
    type: "function",
    name: "setSchedule",
    inputs: [
      { name: "claimStart_", type: "uint64", internalType: "uint64" },
      { name: "allowlistStart_", type: "uint64", internalType: "uint64" },
      { name: "publicStart_", type: "uint64", internalType: "uint64" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },

  // ── Economics (views) ───────────────────────────────────────────────
  {
    type: "function",
    name: "threshold",
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
    name: "mintCount",
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
    name: "quoteBatchFee",
    inputs: [
      { name: "who", type: "address", internalType: "address" },
      { name: "qty", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "total", type: "uint256", internalType: "uint256" }],
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
  // Allowlist mints are uncapped: the contract keeps no per-wallet allowance
  // (no `maxPerAllowlisted`/`allowlistMinted` getter). Membership against
  // `allowlistRoot` is the whole eligibility test; throttling is the same
  // per-wallet fee escalator every mint path shares.
  {
    type: "function",
    name: "allowlistRoot",
    inputs: [],
    outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
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
    name: "MAX_BATCH",
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

  // ── Reserve + redeem window (writes + views) ────────────────────────
  {
    type: "function",
    name: "isReserved",
    inputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "reserveMine",
    inputs: [{ name: "ids", type: "uint256[]", internalType: "uint256[]" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "reserveVia",
    inputs: [
      { name: "ids", type: "uint256[]", internalType: "uint256[]" },
      { name: "vault", type: "address", internalType: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "reservedRemaining",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "redeemOpensAt",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },

  // ── Custom errors ───────────────────────────────────────────────────
  // Every error HomageMinter.sol defines, so viem decodes a revert to its
  // name and arguments (e.g. `RedeemLocked(opensAt)`) instead of a bare
  // `0x...` selector on a failed mint/redeem/admin call.
  { type: "error", name: "AllowlistClosed", inputs: [] },
  { type: "error", name: "AlreadyActivated", inputs: [] },
  { type: "error", name: "AlreadyMinted", inputs: [] },
  { type: "error", name: "BadPunkId", inputs: [] },
  { type: "error", name: "BadSchedule", inputs: [] },
  { type: "error", name: "ClaimClosed", inputs: [] },
  { type: "error", name: "CollectionAlreadyMinted", inputs: [] },
  { type: "error", name: "CollectionNotPooled", inputs: [] },
  {
    type: "error",
    name: "CostExceedsBudget",
    inputs: [
      { name: "ethNeeded", type: "uint256", internalType: "uint256" },
      { name: "ethBudget", type: "uint256", internalType: "uint256" },
    ],
  },
  { type: "error", name: "DrawPoolDesync", inputs: [] },
  { type: "error", name: "ExitFeeOutOfBounds", inputs: [] },
  { type: "error", name: "FeeScheduleOutOfBounds", inputs: [] },
  { type: "error", name: "FeeTransferFailed", inputs: [] },
  {
    type: "error",
    name: "InsufficientValue",
    inputs: [
      { name: "required", type: "uint256", internalType: "uint256" },
      { name: "provided", type: "uint256", internalType: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InvalidBatchQuantity",
    inputs: [
      { name: "qty", type: "uint256", internalType: "uint256" },
      { name: "maxBatch", type: "uint256", internalType: "uint256" },
    ],
  },
  { type: "error", name: "InvalidThreshold", inputs: [] },
  { type: "error", name: "MinterNotGranted", inputs: [] },
  { type: "error", name: "MinterNotLocked", inputs: [] },
  {
    type: "error",
    name: "NonexistentToken",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
  },
  { type: "error", name: "NotActivated", inputs: [] },
  { type: "error", name: "NotAllowlisted", inputs: [] },
  { type: "error", name: "NotBacked", inputs: [] },
  {
    type: "error",
    name: "NotContract",
    inputs: [{ name: "dependency", type: "address", internalType: "address" }],
  },
  { type: "error", name: "NotDelegated", inputs: [] },
  { type: "error", name: "NotManager", inputs: [] },
  { type: "error", name: "NotPunkOwner", inputs: [] },
  { type: "error", name: "NotTokenOwner", inputs: [] },
  { type: "error", name: "NothingToCollect", inputs: [] },
  { type: "error", name: "NothingToRescue", inputs: [] },
  {
    type: "error",
    name: "OwnableInvalidOwner",
    inputs: [{ name: "owner", type: "address", internalType: "address" }],
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [{ name: "account", type: "address", internalType: "address" }],
  },
  { type: "error", name: "PublicClosed", inputs: [] },
  { type: "error", name: "RedeemDelayOutOfBounds", inputs: [] },
  {
    type: "error",
    name: "RedeemLocked",
    inputs: [{ name: "opensAt", type: "uint256", internalType: "uint256" }],
  },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
  { type: "error", name: "RefundFailed", inputs: [] },
  { type: "error", name: "ReleaseNotOpen", inputs: [] },
  { type: "error", name: "RescueTransferFailed", inputs: [] },
  { type: "error", name: "ReservationClosed", inputs: [] },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [{ name: "token", type: "address", internalType: "address" }],
  },
  {
    type: "error",
    name: "Slippage",
    inputs: [
      { name: "received", type: "uint256", internalType: "uint256" },
      { name: "needed", type: "uint256", internalType: "uint256" },
    ],
  },
  { type: "error", name: "SoldOut", inputs: [] },
  { type: "error", name: "SupplyCapTooLow", inputs: [] },
  { type: "error", name: "ThresholdLocked", inputs: [] },
  {
    type: "error",
    name: "WrongExitFee",
    inputs: [
      { name: "expected", type: "uint256", internalType: "uint256" },
      { name: "provided", type: "uint256", internalType: "uint256" },
    ],
  },
  { type: "error", name: "WrongPoolCurrency", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ZeroDependency", inputs: [] },
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
 * `contracts/src/HomageRendererSovereign.sol`). Renders any punk id 0..9999
 * (minted or not) from the onchain punk pixels + live market status, so the
 * collection hero can show a representative homage without a token existing.
 *
 * Two call surfaces, both on this one renderer address:
 *   - the base `HomageRenderer` punk-id surface: `tokenURI(uint256)` (live
 *     market status, square form), `tokenURI(uint256,uint8,bool)` and
 *     `renderSVG(uint256,uint8,bool)` (explicit status + form, `circle` for
 *     the PFP treatment), `pfpSVG(uint256,uint8)`, `colorCount(uint256)`,
 *     `statusOf(uint256)`, and the owner-settable `collectionName()` /
 *     `collectionDescription()` getters.
 *   - the `IPreviewRenderer`/`IRenderer` adapter surface the PND Collection
 *     itself calls: `tokenURI(address,uint256)`, `contractURI(address)`,
 *     `previewURI(address,uint256,bytes32)` (a random-punk preview keyed by
 *     seed; `collection`/`tokenId` are ignored on all three).
 *
 * Reconstructed from `contracts/src/HomageRenderer.sol` and
 * `HomageRendererSovereign.sol` (sovereign-rebuild branch) after the prior
 * version of this ABI drifted from a pre-rebuild renderer with a different
 * function surface (`tokenURIPfp`, `renderSVGPfp`, `previewSVG`,
 * `previewTokenURI`, `previewSVGPfp`, `previewTokenURIPfp` never existed on
 * the deployed contract). Same hand-synced / pre-audit-freeze caveat as
 * `homageMinterAbi` above.
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
    name: "tokenURI",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
      { name: "circle", type: "bool", internalType: "bool" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "renderSVG",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
      { name: "circle", type: "bool", internalType: "bool" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pfpSVG",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "statusOf",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint8", internalType: "uint8" }],
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
