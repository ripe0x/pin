# Surface v2 (art core): implementation plan and spec

Status: implementation branch `claude/surface-v2-art-core`. This is the
"path 1" strip plan agreed 2026-08-18: Surface becomes an art-only
protocol; backed/redeemable works are out of scope for this system (a
separate chassis may exist later; nothing here depends on it).

v1 stays untouched. The deployed mainnet system (factory
`0xdB81d3F33EF3D84685486916E0d372E247558094` and its implementations) is
immutable, and `contracts/src/surface/` must keep byte-matching it under
the default profile (see `contracts/README.md`). v2 therefore lives
beside v1 in `contracts/src/surface/v2/` with `V2`-suffixed contract
names so Foundry artifacts never collide. v1 files are not edited.

## What v2 removes (relative to v1)

1. Pooled mode, entirely. No `PooledSurfaceV2`, no `IdMode`, no
   minter-chosen ids, no minter burn authority, no `TooManyMinters`, no
   mode-dependent minter-authority split. One mode: sequential ids
   1,2,3..., owner-or-approved burn, mints-ever cap semantics.
2. The abstract/concrete core split. `SurfaceCore` + `Surface` merge
   into one concrete `SurfaceV2`. No virtual `_burnAuthorized` /
   `_capUsage`; the checks are inlined.
3. `priceStrategy` in the canonical minter. `FixedPriceMinterV2` is
   exact-payment fixed price only. No strategy pointer, no
   overpay-refund branch, no `IPriceStrategy`. Dynamic pricing ships
   later as its own minter if a work needs it.
4. The seed's `mintIndex` component. Sequential ids mean the token id is
   the mint order: `seed = keccak256(abi.encode(block.prevrandao,
   address(this), tokenId))`.

## What v2 adds

1. `_update` override rejecting `to == address(this)`
   (`SelfCustodyRejected(tokenId)`). Closes the permanent-stranding trap.
2. `lockRoyalty()` — royalty gets the same one-way lock the other knobs
   have. `setRoyalty` reverts `RoyaltyIsLocked` once engaged.
3. `seal()` — owner-only, one transaction: engages any un-engaged lock
   (renderer, supply, minter, royalty) and then `_transferOwnership(address(0))`
   (renounce). Sealing with zero granted minters permanently ends
   minting; keep v1's lockMinter NatSpec warning.
4. `permanence()` view returning
   `(bool rendererLocked, bool supplyLocked, bool minterLocked,
   bool royaltyLocked, bool sealed_, uint256 version_)` where `sealed_`
   is `owner() == address(0)`.
5. Minter-supplied seeds: `mintToSeeded(address to, bytes32[] calldata
   seeds)` (quantity = `seeds.length`; a zero entry means "derive the
   default for that token"). `mintTo(address,uint256)` keeps deriving
   for every token. Both gated on `_minters[msg.sender]`, both
   `nonReentrant`, both respect the cap and emit the same event.
6. `seedSource`: an init-only address (no setter, no lock needed — it
   can never change after `initialize`). When set, `mintTo` skips the
   seed SSTORE entirely and `tokenSeed(id)` falls back to
   `ISeedSourceV2(seedSource).seedOf(address(this), id)` for tokens with
   no stored seed. A minter-supplied nonzero seed is still stored and
   wins over the source for that token. `tokenSeed` reverts
   `NeverMinted` for `id == 0 || id > _mintedEver`.
   `ISeedSourceV2`: `function seedOf(address collection, uint256 tokenId)
   external view returns (bytes32);` — may revert (e.g. a reveal-based
   source before its epoch resolves).

## What v2 keeps unchanged (do not redesign)

- OZ v5.1.0 upgradeable bases: `ERC721Upgradeable`,
  `Ownable2StepUpgradeable`, `ReentrancyGuardUpgradeable`; EIP-1167
  clones with `_disableInitializers()` in the implementation
  constructor; ERC-7201 storage in the bases.
- The admin model verbatim: `mapping(address => address) _admins`
  storing the granting owner; `_isAdmin` requires
  `grantedBy == owner()`; `onlyOwnerOrAdmin` everywhere v1 used it,
  now including `setMinter`/`lockMinter` (the pooled owner-only split is
  gone).
- Minter set + `_minterCount` + `_primaryMinter` + `lockMinter`;
  renderer slot + `lockRenderer`; `supplyCap` + `lockSupply` (cap usage
  = mints-ever); royalty (ERC-2981, 50% cap, renounce-safe
  `royaltyInfo`); creators/catalog handshake (`setCreators`,
  `isListedCreator`, init-only `_catalog`); `rescueStrayETH`;
  `notifyMetadataUpdate`; ERC-4906 + ERC-7572 events;
  `supportsInterface`.
- Event shapes, verbatim from v1: `Minted(minter, to, firstTokenId,
  quantity, firstMintIndex)` with `firstMintIndex = firstTokenId` (the
  field is kept for indexer ABI stability; the values are now equal),
  `Burned`, and all config events minus pooled-only ones.
- Renderer compatibility, load-bearing: v1 renderers
  (`DefaultRenderer`, `ScriptyRenderer`, `RenderAssets`,
  `BatchRenderRouter`) must work against v2 collections without
  modification. Therefore v2 keeps the exact `ISurfaceView` read
  selectors and return shapes: `config()` returns the v1
  `SurfaceConfig` struct unmodified (import it from
  `../SurfaceTypes.sol`; do NOT add fields to it — `royaltyLocked`
  lives in a separate variable), and `idMode()` stays as a compat shim
  returning `IdMode.Sequential` (import the v1 enum). `tokenSeed`,
  `name`, `contractURI`, `tokenURI` keep their v1 signatures.

## Storage layout (SurfaceV2, linear slots; bases are ERC-7201)

| Slot | Contents |
|---|---|
| 0 | `mapping(address => bool) _minters` |
| 1 | `uint256 _minterCount` |
| 2 | `bool _minterLocked` + `address _primaryMinter` (packed) |
| 3 | `mapping(address => address) _admins` |
| 4-6 | `SurfaceConfig _cfg` (v1 struct, unchanged) |
| 7 | `uint256 _mintedEver` |
| 8 | `uint256 _burnedCount` |
| 9 | `mapping(uint256 => bytes32) _seed` |
| 10 | `address _catalog` |
| 11 | `mapping(address => bool) isListedCreator` |
| 12 | `address seedSource` + `bool _royaltyLocked` (packed) |

## Files

```
contracts/src/surface/v2/
  SurfaceV2.sol                  merged concrete core (contract SurfaceV2)
  SurfaceFactoryV2.sol           sequential-only factory (contract SurfaceFactoryV2)
  interfaces/ISurfaceV2.sol      full core interface (mirror ISurfaceCore+ISurface minus pooled, plus adds)
  interfaces/ISeedSourceV2.sol
  minters/FixedPriceMinterV2.sol exact-payment minter (contract FixedPriceMinterV2)
contracts/test/surface/v2/       full test suite (see below)
```

v2 imports v1's `SurfaceTypes.sol` (for `SurfaceConfig` + `IdMode`) and
the unchanged shared interfaces (`IRenderer`, `ISurfaceAuth`,
`ICatalog`). Nothing in v1 imports v2.

## SurfaceFactoryV2

v1 factory minus everything pooled: immutables
`sequentialImplementation`, `minterImplementation`, `defaultRenderer`
(optional), `catalog` (optional), `deployer`; `createSurface` (canonical
clone+minter), `createSurfaceCustom` (bring-your-own minters);
`deprecate(successor)` + `setPaused` unchanged. `SaleConfig` drops
`priceStrategy`. `InitParams` gains `seedSource` (pass-through,
`address(0)` default). `SurfaceCreated` event keeps its shape plus the
existing creator/msg.sender attribution.

## FixedPriceMinterV2

v1 minus: `priceStrategy` (field, init param, setter, quote branch,
overpay/refund accrual — payment is exactly `price * quantity` or
`WrongPayment`). Changed: `referralShareBps` initializes to 0
(`MAX_REFERRAL_SHARE_BPS = 1_000` cap stays; owner/admin can raise it).
Kept verbatim: mint window, `maxMints`, Merkle allowlist (leaf =
`keccak256(keccak256(abi.encode(to)))`), `walletCap`, pull-payment
`_pending` + `withdraw`, stored renounce-safe `payoutRecipient`,
borrowed `onlyCollectionOwnerOrAdmin` auth, `rescueStrayETH` netting
`_totalPending`, `Sold`/`ReferralPaid` events. Calls
`ISurfaceV2(collection).mintTo(to, quantity)`.

## Tests (contracts/test/surface/v2/)

Port the v1 sequential coverage and add coverage for every new
behavior. Suites:

- `SurfaceV2.t.sol` — mint/burn/auth/cap/locks/admin/creators/royalty,
  ported from the v1 tests, pooled cases dropped.
- `SurfaceV2Seal.t.sol` — lockRoyalty one-way; seal() engages all locks
  + renounces; post-seal every mutator reverts; permanence() truth
  table before/after each lock.
- `SurfaceV2Seed.t.sol` — default derivation shape; mintToSeeded mixed
  zero/nonzero entries; seedSource fallback via a mock source
  (including a reverting "pending" mock); stored-seed-wins-over-source;
  NeverMinted bounds; seed skip-write when source set (assert
  tokenSeed still serves via source).
- `SurfaceV2Transfer.t.sol` — SelfCustodyRejected on transferFrom to
  the collection; safeTransferFrom unaffected otherwise; normal
  transfers/approvals intact.
- `SurfaceFactoryV2.t.sol` — create paths, canonical wiring,
  deprecate/pause, seedSource pass-through, primary-minter validation.
- `FixedPriceMinterV2.t.sol` — exact payment only (over/underpay
  revert), window/allowlist/walletCap/maxMints, referral defaults to 0
  and pays when raised + referrer set, pull payment, payout snapshot.
- `SurfaceV2Size.t.sol` — same gate as v1's size test
  (runtime <= 23,576 bytes) for `SurfaceV2` and `SurfaceFactoryV2`.
- `SurfaceV2Invariants.t.sol` — port the v1 invariant handler's
  sequential probes: cap never exceeded, ids monotonic + never reused,
  burn only by owner-or-approved, locks are one-way, seed immutable
  once stored.

`forge test` must be green under the default profile, and the v1 suite
must stay green untouched.

## Explicitly out of scope on this branch

- Deploy scripts, deployments records, docs/reference regeneration
  (all deploy-gated; the reference docs describe deployed v1).
- Web/indexer changes (v2 has no mainnet address).
- `EpochSeedSource` (build when a work with grindable discrete traits
  exists; only the `seedSource` slot ships now because it cannot be
  retrofitted).
- Lineage minters/registry, the backed chassis, the Surface-compatible
  standard write-up.
