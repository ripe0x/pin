---
title: Surface
---

# summary

Sequential-id ERC721 collection: the token core of the PND Surface System. It
stores ownership, one seed per token, the renderer pointer, the EIP-2981 royalty,
creator attribution, and the supply cap. It holds no sale logic and no ETH: it has
no payable function, and every mint enters through an authorized minter calling
the non-payable `mintTo`. Each collection is a separate EIP-1167 clone deployed by
[the factory](/docs/collections/contracts/factory); there is no proxy admin and no
upgrade path. The OpenZeppelin upgradeable bases are used only for the initializer
pattern a clone requires.

Price, mint window, payment, referral, and gating live in the minter that calls
`mintTo`, not in the token. `createSurface` on the factory clones and grants a
[FixedPriceMinter](/docs/collections/contracts/fixed-price-minter); a project with
its own economics grants its own minter contract instead. The owner controls a
minter through `setMinter` (grant or revoke) and `lockMinter` (freeze the set).

Three one-way locks cover the state the token owns: `lockRenderer` pins the
renderer pointer, `lockSupply` freezes the cap, and `lockMinter` freezes the
minter set. Per-token provenance is the seed, read with `tokenSeed`, plus the
`Minted` event, which records the minter, recipient, id range, and mint index for
each mint.

# concepts

### Token and minter

The token authorizes a minter for one operation: calling `mintTo`. It does not
constrain minter internals. The token-side invariants hold for every minter: the
supply cap bounds all mints, ids are assigned sequentially, and each mint emits
`Minted` with the calling minter. Payment, referral, and gating are the minter's
own surface; see [FixedPriceMinter](/docs/collections/contracts/fixed-price-minter)
and the [minter guide](/docs/collections/guides/write-a-minter).

### Owner and admins

The owner may grant admin keys with `addAdmin`. An admin can call every management
function the owner can except managing the admin set, transferring ownership, and
changing the minter set on a pooled collection. A grant records the granting
owner and is valid only while that account is the current owner, so an ownership
transfer invalidates every grant. Companion contracts reuse this authority: the
canonical minter's config setters check the collection's `owner()`/`isAdmin`.

### Creator attribution

Attribution is a two-sided onchain check with no shared registry write. The owner
lists creators with `setCreators`, an assertion. A listed creator confirms by
claiming the collection in the Catalog from their own address.
`isConfirmedCreator(who)` is the intersection: listed and claimed. Either side can
retract, and the confirmation follows on the next read; nothing is stored.
`owner()` counts as a creator without being listed; listing is for co-creators.

### Id modes

The id mode is fixed per contract form; `idMode()` reports it. See
[id modes](/docs/collections/concepts/id-modes).

- Sequential (`Surface`): ids are assigned 1, 2, 3... in mint order and not reused
  after a burn, so the id equals the mint order. The supply cap bounds mints ever.
  `mintTo` is batch-native: one call mints a contiguous id range and emits one
  `Minted`. `burn` is owner-or-approved
- Pooled (`PooledSurface`): the minter chooses each id through `mintToId`
  (`tokenId == sourceId` forms; id 0 is valid). A burned id can be minted again as
  a new instance with a new seed. The supply cap bounds live supply, and `burn` is
  minter-only. The form holds one minter at a time

### Seed

Each mint writes one `bytes32`, read with `tokenSeed`:
`keccak256(prevrandao, collection, tokenId, mintIndex)`, per
`docs/injection-convention.md`. It is the only per-token storage; a nonzero seed
is also the was-minted sentinel. The recipient is not in the formula, so the seed
does not depend on the minter. It is `prevrandao`-derived: suitable for art, not
for lotteries. A work needing other mint-time data (the mint block, pooled order)
records it in its own minter; the mint block of any token is the `Minted` log's
block.

### Locks

`lockRenderer` (optional) pins the renderer pointer. The token does not verify a
renderer's internals, so a locked pointer at an immutable renderer fixes
presentation, while a locked pointer at a mutable renderer leaves that renderer's
output changeable. `lockSupply` freezes the supply cap, which bounds every mint
path. `lockMinter` freezes the minter set; on a backed pooled collection this
prevents granting a later minter that could burn tokens the current minter backs.

### Live reads

```bash
# Live supply (minted minus burned)
cast call <COLLECTION_ADDRESS> "totalSupply()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# The active renderer
cast call <COLLECTION_ADDRESS> "renderer()(address)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# Whether an address may mint
cast call <COLLECTION_ADDRESS> "isMinter(address)(bool)" <MINTER_ADDRESS> \
  --rpc-url https://ethereum-rpc.publicnode.com
```

The Surface System is pre-deploy, so the examples use a `<COLLECTION_ADDRESS>`
placeholder. Collection addresses come from the factory's `SurfaceCreated` events.

## function mintTo

access: minter-only (`msg.sender` must be an authorized minter, else `NotMinter`)

The sequential form's mint entrypoint. Non-payable: the calling minter handles
payment before calling. Mints `quantity` tokens to `to` with ids
`firstTokenId .. firstTokenId + quantity - 1`, where `firstTokenId` is one past
the mints-ever count, and returns `firstTokenId`. One call, one `Minted` event.
Reverts `ZeroQuantity` for `quantity == 0` and `ExceedsCap` when the batch would
cross the supply cap. Uses `_mint`, not `_safeMint`, so a contract recipient is
not called.

## function burn

access: owner-or-approved on the sequential form, minter-only on the pooled form (else `NotAuthorized`)

Burns a token and decrements live supply. On the sequential form the holder or an
approved address may burn; on the pooled form only an authorized minter may burn,
so a holder cannot burn a pooled token and strand what backs it. Reverts
`ERC721NonexistentToken` for an id that is not currently minted. The burned
token's seed stays readable until a pooled re-mint of the same id overwrites it.
On the sequential form a burn does not free cap capacity; on the pooled form it
does. Emits `Burned`.

## function setRenderer

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Sets the renderer pointer. Reverts `RendererIsLocked` after `lockRenderer`,
`RendererRequired` for the zero address, and `RendererNotContract` for an address
with no code. Emits `RendererSet`, an ERC-4906 `BatchMetadataUpdate` over all
tokens, and an ERC-7572 `ContractURIUpdated`.

## function setRoyalty

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Sets the EIP-2981 royalty read by `royaltyInfo`. Capped at 50% (`RoyaltyTooHigh`
above 5000 bps); a zero receiver resolves to `owner()` at read time. Emits
`RoyaltySet`.

## function setSupplyCap

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Sets the supply cap; 0 means open supply. Reverts `SupplyIsLocked` after
`lockSupply`, and `BadSupplyCap` for a nonzero cap below current usage (mints ever
on the sequential form, live supply on the pooled form). The cap determines which
token carries a renderer's final-mint trait, so the call also emits a full-range
`BatchMetadataUpdate` with `SupplyCapSet`.

## function setCreators

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Lists (`listed = true`) or unlists creators, the owner's side of attribution. A
listing is an assertion; a creator is confirmed once they also claim the
collection in the Catalog. Emits `CreatorListed` per address.

## function setMinter

access: owner-only on the pooled form; owner or admin on the sequential form (else `NotAuthorized`)

Grants (`allowed = true`) or revokes an authorized minter. Reverts `ZeroMinter`
for the zero address and `MinterIsLocked` after `lockMinter`; a call that does not
change the state is a no-op. The pooled form holds one minter at a time, because
its burn authority is minter-wide and a second minter could burn a token the first
backs, so a second grant reverts `TooManyMinters`; the sequential form permits any
number. Minter-set changes on the pooled form are owner-only for the same reason.
Emits `MinterSet`.

## function lockRenderer

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

One-way: pins the renderer pointer, so `tokenURI`/`contractURI` are answered by
the current renderer from then on. The token does not verify a renderer's
internals: a locked pointer at an immutable renderer fixes presentation, while a
locked pointer at a mutable renderer leaves that renderer's output changeable.
Reverts `RendererIsLocked` if already locked. Emits `RendererLocked`.

## function lockSupply

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

One-way: freezes the supply cap. The cap bounds every mint path, so no later
minter grant can exceed it. Reverts `SupplyIsLocked` if already locked. Emits
`SupplyLocked`.

## function lockMinter

access: owner-only on the pooled form; owner or admin on the sequential form (else `NotAuthorized`)

One-way: freezes the minter set, so no minter is granted or revoked afterward. On
a backed pooled collection this prevents granting a later minter that could burn
tokens the current minter backs. Reverts `MinterIsLocked` if already locked. Emits
`MinterLocked`.

## function addAdmin

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Grants an admin key. An admin can call every management function the owner can
except managing the admin set, transferring ownership, and changing the minter set
on a pooled collection. Reverts `ZeroAccount` for the zero address and
`AlreadyAdmin` for an existing admin or the owner (already an admin). A grant
records the granting owner and stops being valid once ownership transfers. Emits
`AdminSet`.

## function removeAdmin

access: owner, or the admin itself (else `NotAuthorized`)

Revokes an admin. The owner may remove any admin; an admin may remove itself by
passing its own address. Reverts `NotAnAdmin` when the account holds no grant.
Emits `AdminSet`.

## function notifyMetadataUpdate

access: the current renderer, or owner/admin (else `NotAuthorized`)

Emits an ERC-4906 `BatchMetadataUpdate` for metadata changes the token cannot
observe: an onchain-live work whose output changed with chain state, a reveal, new
captures. The event is emitted on the token, so the renderer calls this rather
than emitting its own. Event only; no state change. Works after `lockRenderer`,
which pins the renderer address, not its output.

## function rescueStrayETH

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Sends `to` the contract's full ETH balance. The token has no payable function, so
any balance was force-fed (selfdestruct or a pre-funded address) and nothing is
owed. Reverts `ZeroAccount` for the zero address, `NoStrayETH` for a zero balance,
and `RescueFailed` if the transfer reverts. Emits `StrayETHRescued`.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`)

Sets the clone up once: name, symbol, owner, the `SurfaceConfig`, the factory's
default renderer (used when the config names none), initial minters, the Catalog
address, and an initial creator listing. Reverts `OwnerRequired` for a zero owner,
`RoyaltyTooHigh` above the 50% cap, `RendererRequired` when neither the config nor
the factory supplies a renderer, `RendererNotContract` for a renderer with no
code, `ZeroMinter` for a zero address among the initial minters, and
`TooManyMinters` when a pooled clone is seeded with more than one. Locks passed
true in the config apply from init. The implementation constructor disables
initializers, so only a clone is initialized, once. Emits `MinterSet` per initial
minter, `CreatorListed` per listed creator, lock events for locks set at init, and
`SurfaceConfigured`.

## function transferOwnership

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

OpenZeppelin Ownable2Step: records a pending owner who must call
`acceptOwnership`. Existing admin grants stop being valid once the transfer
completes. Emits `OwnershipTransferStarted`.

## function acceptOwnership

access: pending-owner-only (else `OwnableUnauthorizedAccount`)

Ownable2Step: the pending owner completes the transfer and becomes owner. Admin
grants made by the previous owner are no longer valid. Emits
`OwnershipTransferred`.

## function renounceOwnership

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

OpenZeppelin Ownable: sets the owner to the zero address. Every owner and admin
gate then reverts (an admin grant is valid only while its granting owner is the
current owner), and the config is fixed at its current values. A royalty receiver
left at zero then reports the zero address. One-way.

## function approve

access: owner-or-operator-only (standard ERC721 approval authority, else an `ERC721` revert)

Standard ERC721 single-token approval. Emits `Approval`.

## function setApprovalForAll

access: permissionless (the caller sets its own operator approval)

Standard ERC721 operator approval over all of the caller's tokens. Emits
`ApprovalForAll`.

## function transferFrom

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 transfer. The mint entrypoints and `burn` are the non-standard
surface; transfers follow EIP-721. Emits `Transfer`.

## function safeTransferFrom(address,address,uint256)

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 safe transfer with no data. Checks a contract recipient implements
`onERC721Received` (`ERC721InvalidReceiver` otherwise). Emits `Transfer`.

## function safeTransferFrom(address,address,uint256,bytes)

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 safe transfer with a data payload forwarded to the recipient's
`onERC721Received`. Emits `Transfer`.

## function version

The implementation version, a compile-time constant (`1` for this generation). A
new generation ships as a new implementation and factory, so a collection reports
the version it was cloned from.

## function config

Returns the live `SurfaceConfig` and `minted`, the mints-ever count (not live
supply). The config fields are `supplyCap` (0 = open supply), `royaltyBps`,
`royaltyReceiver` (0 = `owner()`), `renderer`, `rendererLocked`, and
`supplyLocked`. Sale state (price, window, phase) is not here; read the
collection's minter.

## function idMode

The collection form: Sequential (0) or Pooled (1). Fixed by the contract. See
[id modes](/docs/collections/concepts/id-modes).

## function totalSupply

Live supply: mints ever minus burns. On the sequential form a burn lowers this; on
the pooled form a re-mint of a burned id raises it.

## function tokenSeed

The seed for a token, written in the mint transaction: the only per-token storage.
Reverts `NeverMinted` for an id that was never minted (a nonzero seed is the
existence sentinel). Readable for a burned id until a pooled re-mint overwrites it
with the new instance's seed.

## function isAdmin

True if the account may use the admin-gated setters: the owner, or an address
holding a currently valid grant. The owner is included because every admin-gated
function also admits the owner.

## function isListedCreator

Whether the owner has listed `who` as a creator (the owner's assertion). See
`isConfirmedCreator`.

## function isConfirmedCreator

True only if the owner has listed `who` and `who` has claimed this collection in
the Catalog (`isContractRegistered`). Computed on read, so retracting either side
revokes the confirmation. False when no Catalog is configured.

## function catalog

The Catalog singleton this collection confirms creators against (zero when
confirmation is disabled).

## function isMinter

True if the address is an authorized minter allowed to call the mint entrypoint.

## function isRendererLocked

True after `lockRenderer`.

## function isSupplyLocked

True after `lockSupply`.

## function isMinterLocked

True after `lockMinter`.

## function renderer

The renderer address `tokenURI` and `contractURI` delegate to. Set at init (the
config's value, or the factory default when the config names none) and settable
via `setRenderer` until `lockRenderer`.

## function tokenURI

Standard ERC721 metadata entry point. Reverts `ERC721NonexistentToken` for a token
that does not exist and delegates to the renderer's `tokenURI`.

## function contractURI

Collection-level metadata, delegated to the renderer's `contractURI`.

## function royaltyInfo

EIP-2981 royalty for a sale price: the receiver (the configured receiver, or
`owner()` when unset) and the amount from `royaltyBps`. Advisory.

## function supportsInterface

Standard ERC165 check. True for ERC721, ERC165, EIP-2981 (`0x2a55205a`), and
ERC-4906 (`0x49064906`).

## function name

Standard ERC721 collection name, set at init.

## function symbol

Standard ERC721 collection symbol, set at init.

## function owner

Standard OpenZeppelin Ownable owner: the address that controls the config, the
minter set, and the admin set.

## function pendingOwner

Standard Ownable2Step pending owner: the address offered ownership that must call
`acceptOwnership`, or zero when no transfer is pending.

## function balanceOf

Standard ERC721: the number of tokens an address owns.

## function ownerOf

Standard ERC721: the owner of a token. Reverts `ERC721NonexistentToken` for an id
that is not currently minted.

## function getApproved

Standard ERC721: the single-token approved spender, or zero.

## function isApprovedForAll

Standard ERC721: whether an operator is approved over all of an owner's tokens.

## event Minted

Emitted once per mint call. Indexed by `minter` (the authorized minter that
issued the tokens) and `to` (the recipient). On the sequential form a call covers
ids `[firstTokenId, firstTokenId + quantity - 1]`; on the pooled form
`firstTokenId` is the minted id and `quantity` is 1. `firstMintIndex` is the
global mint order of the call's first token (token k of the batch has mint index
`firstMintIndex + k`), carried because pooled order is not derivable from reused
ids. The mint block is the log's block. Payment and referral are not here; the
canonical minter emits its own `Sold`.

## event Burned

Emitted when a token is burned. Indexed by `tokenId`. A pooled id may be re-minted
later, covered by a new `Minted`.

## event SurfaceConfigured

Emitted once at init with the id mode and supply cap. The id mode is fixed; the
cap has its own update event.

## event RoyaltySet

Emitted when the royalty changes with `setRoyalty`. Indexed by `royaltyReceiver`.

## event SupplyCapSet

Emitted when the supply cap changes with `setSupplyCap`.

## event RendererSet

Emitted when the renderer pointer changes. Indexed by `renderer`.

## event RendererLocked

Emitted once when `lockRenderer` runs, or for a lock set at init.

## event SupplyLocked

Emitted once when `lockSupply` runs, or for a lock set at init.

## event MinterLocked

Emitted once when `lockMinter` runs.

## event MinterSet

Emitted when a minter is granted or revoked, and once per initial minter at init.
Indexed by `minter`, with the `allowed` flag. The factory's `SurfaceCreated` names
the canonically wired minter directly.

## event CreatorListed

Emitted when the owner lists or unlists a creator, including each creator seeded at
init. Indexed by `creator`, with the `listed` flag. Confirmed status is a live
`isConfirmedCreator` read.

## event AdminSet

Emitted when an admin key is granted (`allowed = true`) or revoked. Indexed by
`account`.

## event MetadataUpdate

ERC-4906 single-token refresh, declared for interface completeness; range
refreshes use `BatchMetadataUpdate`.

## event BatchMetadataUpdate

ERC-4906 range refresh, emitted by `setRenderer` and `setSupplyCap` (all tokens)
and by `notifyMetadataUpdate` (a renderer- or admin-chosen range).

## event ContractURIUpdated

ERC-7572 contract-level refresh, emitted by `setRenderer` alongside the token-range
refresh.

## event StrayETHRescued

Emitted when `rescueStrayETH` sweeps force-fed ETH. Indexed by `to`, with the
`amount` in wei.

## event Transfer

Standard ERC721 transfer event, emitted on mint (from the zero address), transfer,
and burn (to the zero address). Indexed by `from`, `to`, and `tokenId`.

## event Approval

Standard ERC721 single-token approval event. Indexed by `owner`, `approved`, and
`tokenId`.

## event ApprovalForAll

Standard ERC721 operator approval event. Indexed by `owner` and `operator`, with
the `approved` flag.

## event OwnershipTransferStarted

Standard Ownable2Step event, emitted by `transferOwnership` when a pending owner is
recorded. Indexed by `previousOwner` and `newOwner`.

## event OwnershipTransferred

Standard Ownable event, emitted at init when the first owner is set, when
`acceptOwnership` completes a transfer, and when `renounceOwnership` sets the owner
to zero. Indexed by `previousOwner` and `newOwner`.

## event Initialized

OpenZeppelin Initializable event, emitted once when the clone is initialized.

## error NotMinter

The mint entrypoint was called by an address that is not an authorized minter.

## error ZeroQuantity

`mintTo` was called with `quantity == 0`.

## error ExceedsCap

A mint would cross the supply cap: mints ever on the sequential form, live supply
on the pooled form.

## error BadSupplyCap

`setSupplyCap` was given a nonzero cap below current usage: mints ever on the
sequential form, live supply on the pooled form.

## error SupplyIsLocked

`setSupplyCap` or `lockSupply` was called after `lockSupply`.

## error RendererIsLocked

`setRenderer` or `lockRenderer` was called after `lockRenderer`.

## error MinterIsLocked

`setMinter` or `lockMinter` was called after `lockMinter`.

## error TooManyMinters

A minter grant would exceed the pooled form's one-minter limit, via `setMinter` or
seeded at init through `initialMinters`.

## error ZeroMinter

An initial minter in `initialize`, or the `setMinter` target, was the zero
address.

## error NotAuthorized

An `onlyOwnerOrAdmin` function was called by neither the owner nor an admin; a
pooled minter-set change was attempted by a non-owner; `removeAdmin` was called by
someone other than the owner or the admin itself; `notifyMetadataUpdate` was called
by neither the renderer nor an owner/admin; or `burn` was called without burn
authority for the form.

## error AlreadyAdmin

`addAdmin` was called for the owner or an existing admin.

## error NotAnAdmin

`removeAdmin` was called for an account that holds no grant.

## error ZeroAccount

`rescueStrayETH` or `addAdmin` was passed the zero address.

## error OwnerRequired

`initialize` was given the zero address as the owner.

## error RendererRequired

`initialize` was given no renderer (neither the config nor the factory default),
or `setRenderer` was passed the zero address.

## error RendererNotContract

The renderer address has no code (carries the address). Raised by `initialize` and
`setRenderer`: a codeless renderer reverts `tokenURI`, and a collection
initialized `rendererLocked` could not recover.

## error NotAContract

Declared on the shared collection interface for companion use. The collection's
own renderer check raises `RendererNotContract` instead, so the collection does
not raise this.

## error RoyaltyTooHigh

`initialize` or `setRoyalty` was given a royalty above the 50% cap (5000 bps).

## error NeverMinted

`tokenSeed` was read for an id that was never minted (its seed slot is zero).

## error NoStrayETH

`rescueStrayETH` found a zero ETH balance.

## error RescueFailed

The transfer in `rescueStrayETH` reverted.

## error InvalidInitialization

OpenZeppelin Initializable error: `initialize` was called more than once, or on
the implementation whose initializers are disabled.

## error NotInitializing

OpenZeppelin Initializable error: an `onlyInitializing` step ran outside an active
initialization.

## error ReentrancyGuardReentrantCall

OpenZeppelin ReentrancyGuard error: a `nonReentrant` function was re-entered.

## error ERC721IncorrectOwner

Standard ERC721 error: a token operation named an owner that does not match the
token's actual owner.

## error ERC721InsufficientApproval

Standard ERC721 error: the caller lacks approval to transfer or burn the token.

## error ERC721InvalidApprover

Standard ERC721 error: the approver is not authorized to grant the approval.

## error ERC721InvalidOperator

Standard ERC721 error: an invalid operator address (for example the zero address)
was used in an approval.

## error ERC721InvalidOwner

Standard ERC721 error: an invalid owner address (for example the zero address) was
used in an ownership query.

## error ERC721InvalidReceiver

Standard ERC721 error: a safe transfer targeted a contract that does not accept
ERC721 tokens (bad `onERC721Received`).

## error ERC721InvalidSender

Standard ERC721 error: a transfer named a sender that does not own the token.

## error ERC721NonexistentToken

Standard ERC721 error: the token id does not exist (never minted or already
burned).

## error OwnableInvalidOwner

Standard OpenZeppelin Ownable error: an invalid owner address (for example the zero
address) was supplied.

## error OwnableUnauthorizedAccount

Standard OpenZeppelin Ownable error: an owner-gated function (`addAdmin`,
`transferOwnership`, `renounceOwnership`) was called by a non-owner, or
`acceptOwnership` by a non-pending-owner.
