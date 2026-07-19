# Surface: re-audit notes (post-`43f4ae7`)

> **CLOSED 2026-07-19. This log's baseline is superseded.** Everything
> below tracks changes on top of the fat-token `43f4ae7` baseline. The
> thin-token + modular-minter rearchitecture (merged to `main` in PR #164,
> `571a7a1`) replaced the fat token entirely: sale economics left the token
> for a separate `FixedPriceMinter`, so the fat-token audit baseline no
> longer describes deployed code. Do not scope a review against this file.
> The current external-audit scope is **`docs/pnd-surface-audit-scope.md`**,
> anchored at the post-rearchitecture baseline. This file is retained as the
> provenance record of what the two prior reviews covered (the parts that
> carry forward are listed in the scope doc's "inherited" section).

> **Purpose (historical).** A running log of changes made to the collection
> contracts AFTER the audited baseline, so a re-review could be done against
> this single doc once the batch of changes was complete. One section per
> change.
>
> **Audited baseline: commit `43f4ae7`** (`fix(collection): security-audit
> fixes`). That commit applies the notes from **two independent security
> reviews** of Collection + Homage (pooled-burn restricted to
> authorized minters, mintIndex widened to uint40, `setWork`/`lockWork`
> honesty, comment cleanup). The baseline access-control model is
> **single-owner** (`Ownable2StepUpgradeable`); every management function
> is `onlyOwner`. Everything below changes behavior on top of that
> baseline and needs a re-review pass before any mainnet deploy.

---

## Change 1: Multi-admin access control

**Branch:** `claude/elated-swirles-0cc8e7`. **Touches:**
`Collection.sol`, `interfaces/ICollection.sol`, and the
collection test suite.

### Summary

The single-owner model becomes **owner + flat, full-access admins**. The
owner may grant any number of admins; an admin can call every management
function the owner can, with two functions reserved to the owner. `owner()`
is unchanged (still `Ownable2Step`, still what marketplaces read as the
storefront admin, still the root of the keyring).

### Mechanism

- New state: `mapping(address => bool) private _admins;` (independent of
  `_minters`; admin and extension-minter are distinct roles).
- New modifier:
  `onlyOwnerOrAdmin = (msg.sender == owner() || _admins[msg.sender])`,
  reverting `NotAuthorized` otherwise.
- New functions, all added to `ICollection`:
  - `addAdmin(address account)` (`onlyOwner`; reverts `ZeroAccount` on the
    zero address, `AlreadyAdmin` if already granted; emits
    `AdminSet(account, true)`).
  - `removeAdmin(address account)` (owner-or-self: reverts `NotAuthorized`
    unless the caller is the owner or `account` itself, so the owner can
    revoke anyone and an admin can renounce ITSELF; reverts `NotAnAdmin` if
    the account is not currently an admin; emits `AdminSet(account, false)`).
    Self-removal only reduces privilege, so it is no escalation. No
    last-admin guard: removing every admin is safe because the owner keeps
    full access.
  - `isAdmin(address) view`.
  New errors: `AlreadyAdmin`, `NotAnAdmin`.

### Authority diff (this is the whole review surface)

Reserved to the owner (unchanged, `onlyOwner`):

| Function | Why owner-only |
|---|---|
| `addAdmin` | granting is owner-only, so a rogue admin can never mint peers |
| `transferOwnership` / `acceptOwnership` (Ownable2Step) | ownership is the root authority and the marketplace `owner()` |
| `renounceOwnership` | still disabled (reverts `RenounceDisabled`) |

`removeAdmin` is **owner-or-self**, not purely owner-only: the owner may
revoke any admin, and an admin may renounce ITSELF by passing its own
address, but an admin can never revoke a peer. Self-removal only reduces
privilege, so there is no escalation path.

Widened from `onlyOwner` to `onlyOwnerOrAdmin` (15 functions, post the
2026-07 surface reduction — graph/path/kind and the single-token artwork
setter were removed; price/royalty/cap setters and the supply lock added):

`setMintWindow`, `setPrice`, `setRoyalty`, `setSupplyCap`, `lockSupply`,
`setRenderer`, `setMintHook`, `setPriceStrategy`, `setMinter`,
`setTokenArtworkBatch`, `setPayoutAddress`, `freezeMetadata`, `setWork`,
`lockWork`, `rescueStrayETH`.

`notifyMetadataUpdate` has its own gate: current renderer OR owner/admin
(pure ERC-4906 event emission, no state).

### Deliberate properties / accepted risk

This is a flat model by explicit product decision (no graduated roles).
Consequences a reviewer should confirm are intended, not accidental:

- **An admin can move money.** `setPayoutAddress` is admin-accessible, so
  an admin can redirect all FUTURE proceeds. (Past accruals already sit in
  pull-payment balances at the old address and are untouched.)
  `rescueStrayETH` is admin-accessible, but by construction it can only
  sweep ETH ABOVE `_totalPending` (owed balances remain untouchable).
- **An admin can take irreversible actions.** `freezeMetadata` and
  `lockWork` are admin-accessible. The owner can revoke the admin
  afterward but cannot undo a freeze/lock the admin already performed.
- **An admin can authorize minters.** `setMinter` is admin-accessible, so
  an admin can grant an extension minter (which can then mint / in pooled
  form move value per its own logic).
- **Freeze remains supreme over admins.** The `_metadataFrozen` /
  `_workLocked` guards live inside the functions, checked AFTER the
  `onlyOwnerOrAdmin` gate, so once frozen/locked neither owner nor admin
  can write artwork/renderer/work. (Verified by
  `test_freeze_blocksAdminArtwork`.)
- **The owner is always an implicit admin** (the modifier's `||
  owner()` arm); the owner need not appear in `_admins`.

### Reviewer focus / invariants to check

1. The modifier only widens the caller set; it introduces no new external
   call, so pull-payment and reentrancy properties are unchanged.
2. No admin path escalates. `addAdmin` and `transferOwnership` stay
   `onlyOwner`; `removeAdmin` is owner-or-self so an admin can renounce
   itself but never revoke a peer or grant a new admin. Covered by
   `test_admin_cannotAddOrRemovePeers`, `test_admin_canRenounceSelf`,
   `test_admin_cannotTransferOwnership`, `test_removeAdmin_rejectsUnrelatedCaller`.
3. `_admins` and `_minters` are separate maps; being an admin does not
   grant `mintTo`/`mintToId`, and being a minter does not grant admin.
4. Freeze/lock ordering (auth gate before the frozen/locked check) holds
   for every widened setter.

### MURI integration finding, and a planned `isAdmin(owner)` change

The MURI media-permanence protocol (post-deploy work, tracked in issue #138)
gates its `registerContract` on `isAdmin(msg.sender)` of the target contract.
`contracts/test/collection/MuriIntegrationFork.t.sol` proves against live
mainnet MURI that Collection satisfies this via the multi-admin
`isAdmin`: a collection admin can register it, no Manifold-specific contract
type required. This is a reason the multi-admin delta is being kept in the
deploy rather than stripped to the audited baseline: without `isAdmin`, these
immutable collections could never plug into MURI.

The same test surfaced that `isAdmin(owner())` returns false today (the owner
is an implicit, unlisted admin), so the OWNER cannot register directly.

**Planned change, decided but NOT yet in code:** make `isAdmin` return
`account == owner() || _admins[account]`, so the owner passes MURI's check
directly. The owner already holds every admin power (the `onlyOwnerOrAdmin`
modifier's `|| owner()` arm), so this only makes the view honest; it changes
no authorization, just what `isAdmin` reports for the owner. To be landed
before the review so the review covers the final code.

### Open decisions — BOTH RESOLVED 2026-07-13 (Dave)

- **Should `setPayoutAddress` be carved back to `onlyOwner`?** RESOLVED:
  it stays admin-accessible. The flat, full-access admin model is the
  product decision; an admin holding the money lever is accepted and
  documented, not accidental.
- **Admin persistence across ownership transfer.** RESOLVED: accepted
  as-is. Transferring ownership does NOT clear `_admins` (a mapping
  cannot be enumerated onchain to clear it without extra state; the
  complexity is not worth a rare event). Mitigation is product-side: the
  studio surfaces the current admin list prominently during any
  ownership transfer so both parties see who still holds keys — tracked
  in docs/pnd-surface-post-deploy.md. A reviewer should treat the
  inherited-admin behavior as intended.

### Test coverage

- New `test/collection/CollectionAdmin.t.sol` (16 tests): grant/revoke +
  events, addAdmin guards (zero address, already-admin) + owner-only,
  removeAdmin guards (not-an-admin, double-remove), owner-or-self auth
  (unrelated caller rejected, admin renounces self, admin cannot revoke a
  peer), admin runs every widened setter, admin redirects payouts
  (functional proof), owner-only carve-outs, revoked-admin loses access,
  non-admin rejected, owner stays authorized, freeze blocks admin artwork.
- Existing suites updated: unauthorized-caller assertions on the 16
  widened functions now expect `NotAuthorized` (was
  `OwnableUnauthorizedAccount`).
- Full collection suite: **202 passed / 0 failed** (fork tests excluded).
- New `test/collection/MuriIntegrationFork.t.sol` (2 tests, opt-in behind
  `MAINNET_RPC_URL`): probes the live MURI singleton and encodes the two
  findings above (MURI gates on `isAdmin(msg.sender)`; the operator must be a
  contract, so MURI wiring needs a separate operator adapter, issue #138). It
  does not touch the core; it is evidence for the `isAdmin(owner)` change.

## 2026-07-10 (b): MintRecord cut — seed-only per-token storage

Un-reviewed, same review cycle as the surface reduction. The per-token
`MintRecord` (mintBlock uint48 + mintIndex uint40, one slot per mint) was
removed entirely; `_seed` is the only per-token storage and (nonzero) the
was-ever-minted sentinel. Consequences:

- `mintMarkOf` / `MintMark` / `IMintMarks` deleted from the ABI. Renderers
  derive provenance: sequential token id IS the mint order; first = id 1;
  final = Closed && id == minted (via the new `ICollectionView.config()`).
  Pooled tokens get no onchain order — event provenance only.
- `Minted` event no longer carries `mintBlock` (the log's block is
  implicit); it remains the permanent record of order/referrer/status.
- ~22.5k gas saved per mint (measured: single mint 487,832 → 465,183).
- Size: 23,533 → 23,048 bytes (EIP-170 margin +1,528; gate at 23,576).
- Works needing mint-time data record it via a mint hook (MiniTBAM's
  MintClock reference demonstrates the pattern).
- 393 tests green including invariants (ORDER invariants rewritten against
  ghost counters + the sequential id==order identity).

## 2026-07-10 (c): Liveness + _nextId cut

Un-reviewed, same cycle. Two items that failed the weight-bearing test:

- **Liveness** (WorkConfig enum): write-only — set at init, never read by any
  contract, and derivable by any external checker from where the assets
  actually live (onchain code refs vs the offchain codeURI). Removed the enum
  and the WorkConfig.liveness field. WorkConfig now states WHERE assets live
  and pins content (codeHash); an on-chain-ness score is an offchain checker's
  job, not core state.
- **_nextId** (sequential id counter): provably `_mintedEver + 1` in
  Sequential mode and unused in Pooled — a second source of truth for a number
  already stored. Removed; both mint paths compute `firstTokenId =
  _mintedEver + 1`. Also removes the sync invariant an auditor had to verify.

Measured: single-mint test 465,183 → 442,101 gas (−23k, dominated by dropping
the `_nextId = 1` cold init SSTORE per deploy, plus the per-mint write). Size
23,048 → 22,806 bytes (EIP-170 margin +1,770). 393 tests green. Web + docs
synced; ABI WorkConfig tuple loses the liveness field.

### Open design questions raised (NOT yet actioned)
- **Locking restructure**: the current `_metadataFrozen` (renderer pointer +
  tokenArtwork) / `_workLocked` (WorkConfig) cut is along the wrong seam. The
  natural seam is {renderer pointer + work = "the live art is permanent"} vs
  {tokenArtwork captures}. And the capture-freeze may not be load-bearing —
  captures are convenience thumbnails mirroring the already-permanent live
  render, so `setTokenArtworkBatch` arguably needs no freeze at all. Candidate
  end state: ONE render-permanence lock (`isPermanent` = renderer + work
  frozen), captures permanently refreshable, supply lock separate. Pending
  Dave's decision on whether thumbnail integrity is a promise worth a lock.
- **Supply vs time/close**: confirmed NOT redundant — timed window + manual
  close (setMintWindow to now) already exist and cover time-bounded/
  artist-ended mints; the supply cap is the only *trustless, pre-committed
  count* promise (numbered editions). Keep, justified by that use case.

## 2026-07-10 (d): presentation data → renderer-land; seed formula; factory deprecation

Un-reviewed, same cycle. The largest restructure of the set:

- **Core stores NO presentation data.** WorkConfig storage + _copyWork,
  setWork/lockWork, freezeMetadata/_metadataFrozen, artworkURI (cfg),
  _tokenArtwork/setTokenArtworkBatch, isPermanent/isWorkLocked/
  isMetadataFrozen ALL removed from the core. tokenURI/contractURI defer
  wholly to the renderer slot.
- **lockRenderer() replaces freezeMetadata**: one-way, OPTIONAL (off by
  default), pins the renderer pointer only. The core no longer claims to
  attest renderer internals (it can't): immutable renderer + locked pointer
  = full presentation permanence; mutable renderer + locked pointer = the
  artist's inspectable choice. Two core locks remain: lockRenderer,
  lockSupply.
- **GenerativeRenderer is now the work registry**: per-collection WorkConfig
  stored in the renderer (setWork(collection, work) / lockWork(collection) /
  workOf), auth borrowed from each collection's owner/isAdmin. WorkTypes.sol
  moved renderer-land.
- **RenderAssets** (new singleton): covers + per-token captures, same
  borrowed auth; captures deliberately always refreshable. DefaultRenderer/
  GenerativeRenderer read images from it.
- **Seed formula**: recipient removed —
  keccak256(prevrandao, collection, tokenId, mintIndex). Documented as the
  protocol standard (with an Art Blocks comparison) in
  docs/injection-convention.md § Seed derivation.
- **Factory deprecation**: one-way deployer-only deprecate(successor) halts
  NEW clones (createCollection reverts FactoryDeprecated) and names a
  successor; zero power over deployed collections. createCollection lost its
  workCfg param; CollectionConfig lost artworkURI; InitParams lost work.
- Measured: core 22,806 → 18,113 bytes (EIP-170 margin +6,463); deploys
  ~39k gas cheaper (no work copy at init). 389 tests green incl. new
  WorkRegistry/RenderAssets/lockRenderer/deprecate suites. Web synced
  (two-step publish flow in the create wizard; renderer-land reads); docs
  regenerated (43 pages, RenderAssets page added, zero stale terms).

## 2026-07-10 (e): Attribution.sol cut → onchain creator handshake via Catalog

Un-reviewed, same cycle. Replaced the shared Attribution registry with a
two-sided, fully onchain attribution primitive on the collection itself:

- **Owner's side**: `setCreators(address[], bool listed)` + `isListedCreator`
  mapping (seeded from InitParams.creators at init, mutable). Emits
  `CreatorListed`.
- **Artist's side**: the creator claims the collection in the Catalog public
  good (`addContract`) — unchanged, external.
- **Verification**: `isConfirmedCreator(who)` = `isListedCreator[who] &&
  Catalog.isContractRegistered(who, this)` — a LIVE read, so retracting either
  side revokes credit. Squat-proof (rando not listed) AND false-credit-proof
  (owner can't fake a claim). No shared Attribution registry.
- Catalog address is stored per-collection (`catalog()`, from InitParams,
  passed by the factory which took `catalog` in place of `attribution`).
  `createCollection` param `artists` → `creators`. Attribution.sol +
  IAttribution.sol deleted; new `interfaces/ICatalog.sol` (read-only slice).
- Size 18,113 → 18,939 bytes (EIP-170 margin +5,637). 374 tests green incl.
  the new CreatorAttribution suite (7 tests) exercising the handshake against
  a real Catalog. Web synced (getAttribution now indexer-deferred — the roster
  enumerates from CreatorListed events, no chain scan; confirmed status is a
  live isConfirmedCreator read). Docs regenerated (Attribution page removed,
  42 pages, zero stale/broken refs).

## 2026-07-13 (f): SeaDrop-review batch — pre-deploy ABI freezes

Un-reviewed. Outcome of a full contract review plus a comparative study of
OpenSea's SeaDrop (decision record: pnd-surface-system.md § 8.5 — the
singleton mint-engine model was evaluated and rejected; stage-rich drops
arrive later as a stock DropMinter extension minter, not core changes). Every
item here is deploy-gated: impossible to add after the immutable deploy.
Decisions taken by Dave 2026-07-13: `setPayoutAddress` STAYS admin-accessible
(flat-admin model preserved); mintFor added; contractURI enrichment is
cover-image-only (no onchain description storage); additive modules
(HookChain, signed-mint hook, DropMinter) deferred post-deploy.

### f1: isAdmin counts the owner (planned in Change 1, now landed)

`CollectionCore.isAdmin` returns `account == owner() || _admins[account]`.
Authorization is UNCHANGED — the `onlyOwnerOrAdmin` modifier always had an
`|| owner()` arm; only the view's report changes. Unblocks MURI: its
`registerContract` gates on `isAdmin(msg.sender)`, so the owner now passes
directly. `MuriIntegrationFork.t.sol` upgraded to prove it end-to-end against
live mainnet MURI (owner registers with a contract operator stub; stranger
rejected at the gate). Reviewer check: no auth path changed; only
`isAdmin`-consuming externals see a difference.

### f2: mintFor — paid gift-mint on the sequential final

New `Collection.mintFor(address to, uint256 quantity, address referrer,
bytes hookData) payable nonReentrant` (also on ICollection). `_mintPaid`
refactored to take the recipient; `mint`/`mintWithReferral` pass `msg.sender`
(behavior-identical). Semantics: hooks AND the price strategy judge `to` (the
recipient), matching the extension `mintTo` path — an allowlist gates the
collector, not their payer; the per-wallet cap counts the recipient.
Overpayment refunds on the strategy path accrue to `_pending[msg.sender]`
(the payer). `Minted.to` = recipient. Reviewer focus: the recipient/payer
split (gate by `to`, refund to payer) is the whole delta; window, cap,
payment, settle, and reentrancy behavior are byte-identical to
mintWithReferral. New suite: CollectionMintFor.t.sol (10 tests incl.
allowlist-gates-recipient and refund-to-payer).

### f3: renderer must be a contract + ERC-7572 signal

- `initialize` and `setRenderer` now revert `RendererNotContract(address)`
  when the resolved renderer has no code. Closes a permanent footgun: a
  collection born `rendererLocked` with a typo'd EOA renderer could never
  render and never be fixed.
- `setRenderer` additionally emits ERC-7572 `ContractURIUpdated()` beside the
  ERC-4906 batch refresh (a renderer change can change contract-level
  metadata).

### f4: RenderAssets v2 — capture template rung + narrow capturer role

Two additions to the (not-yet-deployed) singleton, both motivated by the
thumbnail economics (docs/pnd-surface-thumbnails.md, rewritten):

- **Template rung**: `templateOf[collection]` + `setCaptureTemplate`; every
  `{id}` resolves to the token id at read time (solady LibString.replace).
  `imageFor` ladder is now capture → template → cover → "". One small tx
  refreshes a whole drop's thumbnails (vs one storage write per token).
- **Capturer role**: `isCapturer[collection][account]` + `setCapturer`
  (admin-gated). `setCaptures`/`setCaptureTemplate` accept admin-or-capturer;
  `setCover` and `setCapturer` stay admin-only. Risk ceiling of a rogue
  capturer = a wrong, refreshable thumbnail; it can never touch money,
  minters, or the art. Resolves the "flat admins vs narrow thumbnails-only
  key" open decision from the thumbnails doc — in renderer-land, where it is
  cheap, instead of the core, where it was rightly rejected.

Reviewer focus: the capturer gate must never reach beyond the two capture
writes; the auth modifiers borrow the collection's owner/isAdmin exactly as
the hooks do. New suite: renderers/RenderAssets.t.sol (9 tests).

### f5: renderer enrichment — contractURI cover + ScriptyRenderer wiring

- `DefaultRenderer.contractURI` now includes `"image": coverOf(collection)`
  when set (escaped) — contract-level metadata drives the marketplace
  collection page.
- `ScriptyRenderer` gains an optional `renderAssets_` constructor param
  (address(0) = previous behavior). Wired: default `_image` resolves the
  RenderAssets ladder and `contractURI` carries the cover — the flagship
  HTML-generative tier no longer ships imageless by default. New unit suite
  templates/ScriptyRendererImage.t.sol (mock builder; document assembly still
  proven by the fork test).

### Sizes / tests after (f)

- Collection (sequential final) 18,663 bytes runtime (EIP-170 margin 5,913);
  PooledCollection 16,488 (margin 8,088). Size-gate tests green.
- 226 unit tests green (was 198 pre-batch; new: mintFor 10, RenderAssets 9,
  ScriptyRendererImage 3, renderer-guard 2, isAdmin(owner) 1, contractURI 2,
  template rung 1) including the 18 invariant runs; 4 fork tests green
  against live mainnet (MURI probe + scripty assembly).
- ABIs re-emitted (packages/abi/src + apps/indexer/abis), web typecheck
  clean, reference docs regenerated (42 pages, strict prose/ABI check
  passing).

## 2026-07-13 (g): SVGRenderer base cut — Solidity SVG = direct IRenderer

Un-reviewed. `renderers/SVGRenderer.sol` (the abstract base for Solidity
SVG works) removed, with its tests (`SVGRenderer.t.sol`,
`TestSVGRenderer.sol`). Rationale: it is not going to be used — the
launch project renders through its own `IRenderer`, and the base bought
little: `IRenderer` is two view functions, and everything worth sharing
(RFC 8259 JSON escaping, the base64 data-URI envelope, derived
provenance traits) already lives in the `MetadataJson` library, which
stays. One less contract in the audit scope; no deployed singleton was
ever planned for it (abstract, inherit-only). Docs resynced: the
write-a-renderer guide now shows a direct-IRenderer Solidity SVG example
over MetadataJson; glossary/system-doc/four-slots references updated.
The §3 system-doc diagram was also brought current in the same pass (it
still showed GenerativeRenderer/Mint Marks/work config/graph refs/
Attribution, all cut in earlier batches).

No ABI or deployed-bytecode impact (nothing referenced SVGRenderer
except its own tests). Full suite re-run green after removal.

## 2026-07-14 (h): GateHook + IPreviewRenderer/context — the genart-branch port

Un-reviewed. Two additions ported from the `claude/genart-mint-ui-research`
branch (the B-series mint-UI build), rebuilt against current conventions
rather than diff-applied. Both were RECORDED pre-deploy decisions on that
branch ("contracts land pre-deploy: previewURI + the composite
allowlist+cap hook ride the same review cycle as the multi-admin delta")
that had not yet been executed here.

### GateHook (hooks/GateHook.sol, new)

Merkle allowlist + per-wallet cap in ONE hook. The core has a single
mintHook slot, and a real gated drop wants both at once — an allowlist
without a per-wallet cap invites a listed wallet to sweep the supply.
Root 0 / cap 0 disable each gate independently, so the single-purpose
AllowlistHook/PerWalletCapHook remain as minimal references.

- Same OZ standard-merkle-tree leaf format and hookData shape as
  AllowlistHook; same counting discipline as PerWalletCapHook (afterMint,
  and only while a cap is active — enabling a cap mid-sale counts from
  that moment, a documented tradeoff so uncapped mints never pay the
  counting SSTORE).
- Custom errors are SELECTOR-IDENTICAL to the stock hooks
  (`NotAllowlisted()`, `WalletCapExceeded(uint256,uint256)`), so a UI
  maps one error set for all three hooks.
- New view `remainingFor(collection, wallet)`: the mint-page quantity
  clamp (max-uint when uncapped, saturates at 0 when a cap is lowered
  below a wallet's count).
- Config authority = HookBase.onlyCollectionAdmin (owner OR admin), the
  same borrow as the renderer-land registries.
- 6 new tests in CollectionHooks.t.sol (both-gates-together, allowlist-
  only skips the counting write, cap-only over plain mint(), remainingFor
  tracking/saturation, mid-sale cap, admin-vs-stranger config).

### IPreviewRenderer + execution context (interfaces/IPreviewRenderer.sol, new; ScriptyRenderer touched)

Onchain previews as a first-class, verifiable capability — a pure
function of chain state, like the live view:

- `IPreviewRenderer.previewURI(collection, tokenId, seed)` — OPTIONAL
  renderer extension; detection is try/catch eth_call (repo convention:
  feature probing, not ERC-165). The launch project's renderer
  (HomageRendererSovereign, in the permanence repo) already implements
  this exact interface.
- `ScriptyRenderer` implements it: identical document assembly as
  tokenURI with the caller's seed, `context:"preview"` injected, and
  metadata deliberately not token-shaped (name marked "(preview)", seed
  attribute only, no static image, no provenance).
- The injected `window.tokenData` gains a `context` field
  (`"token" | "preview" | "capture"`), additive within injection v1 —
  work code treats missing/unknown as `"token"`.
  `docs/injection-convention.md` updated (new "Execution context"
  section; stale GenerativeRenderer heading fixed).
- Tests: fork suite proves `previewURI(realSeed)` == the tokenURI
  document modulo the context word against the REAL mainnet
  ScriptyBuilderV2, and that previews render with zero mints; a no-fork
  unit test pins the not-token-shaped metadata (no image even when
  RenderAssets is wired).

### Sizes / tests after (h)

- Core finals untouched — size-gate tests green (Collection 18,663 /
  Pooled 16,488 runtime bytes, unchanged). GateHook is a standalone
  ~100-line singleton; ScriptyRenderer is a per-work template, not a
  deployed singleton.
- 223 unit tests green (was 216: +6 GateHook, +1 preview unit); 6 fork
  tests green against live mainnet (scripty assembly + the two new
  preview proofs + MURI probe).

## 2026-07-14 (i): Collection → Surface rename (identifiers only)

Un-reviewed, but IMPORTANT for the reviewer's framing: this is a pure
rename, NOT a behavior change. The protocol/contract type "Collection"
became "Surface" across the whole surface — `contracts/src/collection/`
→ `contracts/src/surface/`, `Collection`→`Surface`,
`CollectionCore`→`SurfaceCore`, `PooledCollection`→`PooledSurface`,
`CollectionFactory`→`SurfaceFactory`, `CollectionConfig`→`SurfaceConfig`,
`CollectionStatus`→`SurfaceStatus`, `ICollection*`→`ISurface*`, events
`CollectionCreated`/`CollectionConfigured`→`Surface*`, error
`NotCollectionAdmin`→`NotSurfaceAdmin`, modifier
`onlyCollectionAdmin`→`onlySurfaceAdmin`, fns `createCollection`/
`createPooledCollection`/`totalCollections`→`createSurface`/
`createPooledSurface`/`totalSurfaces`, `HoldsCollectionHook`→
`HoldsSurfaceHook`.

The rename was applied case-sensitively: capital-C `Collection` (always a
type identifier) → `Surface`; lowercase `collection` (always the generic
English word — param names like `address collection`, prose) LEFT intact.
So no storage layout, control flow, selector semantics, or authority
model changed — only names. Some renamed functions/events necessarily got
new selectors/topics (`createSurface`, `SurfaceCreated`); the ABIs, web,
and indexer were repointed to match.

### Sizes / tests after (i)

- Full protocol suite: 223 unit tests green (identical to the pre-rename
  count — the rename touched no test logic, only identifiers); size gates
  unchanged (Surface 18,663 / PooledSurface 16,488 runtime bytes — byte-
  identical, since a rename does not change bytecode beyond metadata).
  6 fork tests green.
- The reviewer should read the diff as a mechanical rename: diffing
  `f85a23d` (the contracts rename commit) against its parent shows every
  change is `Collection`→`Surface` in an identifier position.

## 2026-07-14 (j): external audit remediations (Surface-core findings)

The pre-deploy external audit came back with 0 critical / 0 high, 3
medium, 3 low, 2 info. Three findings land in the Surface core (this
repo); the rest live in the launch project's own contracts (Homage, the
`ripe0x/permanence` repo) and are tracked there, not in this diff. The
core fixes applied here:

### M-01 — pooled burn was not bound to the issuing minter

`PooledSurface._burnAuthorized` gated burn on `_minters[msg.sender]` with
no tie to the token's issuer. With more than one authorized minter, minter
B could burn a token minter A issued and backed — stranding A's escrow and
removing the id from A's pool for good. The comment claiming "nobody can
strand it from outside" only held for a single minter.

Fix (the chosen direction: pooled is single-minter by construction):
- The pooled form now allows **one minter at a time**. `SurfaceCore` keeps
  a `_minterCount` and, for the `Pooled` id mode, rejects a second grant
  (`TooManyMinters`) in both `setMinter` and `initialize`; Sequential is
  uncapped. A redundant grant is a no-op so the count can't drift. The rule
  keys off `idMode() == Pooled` rather than a numeric limit knob: any cap
  above 1 would reopen this very finding (pooled burn is minter-wide), so
  single-minter-ness is expressed as exactly what it is — a property of the
  pooled mode, not a tunable.
- New one-way `lockMinter()` (+ `isMinterLocked()`, event `MinterLocked`,
  error `MinterIsLocked`) freezes the minter set — the same lock vocabulary
  as `lockRenderer`/`lockSupply`. A backed collection locks its single
  minter at deploy, so exactly one address can ever retire an id. This
  closes the residual "revoke A, add B, B burns A's backing" swap window,
  which the one-at-a-time cap alone does not.
- Sequential is unchanged (burn there is owner-or-approved, not minter-
  gated; multiple minters stay legal). The lock is available on it too.
- Coverage: `test/surface/SurfaceMinterLimit.t.sol` (11 tests) — second-
  minter rejection at init and via setMinter, the swap-before-lock path,
  no count drift on redundant grants, the exact "second minter can't burn
  the first's token" scenario, lock freezes grants+revokes, the locked
  single minter still mints and burns, double-lock and authority guards.

### I-01 — the owner could add itself as an explicit admin

`addAdmin` checked only `_admins[account]`, so `addAdmin(owner())`
succeeded even though `isAdmin` already returns true for the owner. That
self-grant would outlive an ownership transfer (the old owner staying an
explicit admin), which is never what the caller means. `addAdmin` now
rejects the current owner with `AlreadyAdmin`. Coverage:
`SurfaceAdmin.t.sol::test_addAdmin_rejectsOwner`.

### I-02 — ScriptyRenderer accepted non-contract builder / stores

The core refuses a non-contract renderer at the door, but a
ScriptyRenderer could be deployed with an EOA builder or EOA file stores;
locked into a collection, that bricks `tokenURI` permanently. The
constructor now requires deployed code at the builder, every code/dep
`store`, and the gunzip store when any file is gzipped (`StoreNotContract`
/ `BuilderRequired` / `GunzipStoreRequired`, all at construction). Coverage:
`test/surface/templates/ScriptyRendererStores.t.sol` (6 tests).

### Sizes / tests after (j)

- Full protocol suite: **241 unit tests green** (223 + 18 new); 6 fork
  tests unaffected.
- Size gates hold with room to spare: **Surface 19,040 / PooledSurface
  16,908** runtime bytes (gate 23,576, EIP-170 limit 24,576). M-01 added
  ~380/420 bytes; the margins are 5,536 / 7,668.
- ABIs (`surface`, `pooledSurface`, `scriptyRenderer`), the docs
  generator (44 pages), and the web typecheck all regenerated / pass.

### Not in this diff — the launch project (Homage, `ripe0x/permanence`)

Deferred to the Homage repo's own workstream: M-01's deploy-time
single-minter lock on the launch collection, M-02 (the escalating reveal
is stamped but never read by the renderer; `mintSeq` regresses after a
redeem), M-03 (Uniswap pool/token config unvalidated in the constructor),
L-01 (O(n) fee loop), L-02 (JSON escaping misses control chars), L-03
(preview breaks the preview convention). None touch the Surface core.
