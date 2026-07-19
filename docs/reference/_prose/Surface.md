---
title: Surface
---

# summary

The token core of the PND Surface System: an OpenZeppelin ERC721 that holds
ownership, one mint-time seed per token, renderer wiring, EIP-2981 royalty,
creator attribution, and the supply cap, and nothing else. Every artist gets
their own copy, deployed as an immutable EIP-1167 clone by
[the factory](/docs/collections/contracts/factory). There is no proxy admin
and no upgrade path: what deploys is what runs. The upgradeable-variant OZ
bases are used only for the initializer pattern that clones require.

The token holds no sale logic and no money. It has no payable function, and
its mint path runs no external code: every mint enters through an authorized
minter calling the non-payable `mintTo` (sequential form) or `mintToId`
(pooled form), and price, mint window, payment, referral, and gating all live
in that minter. The common case is the
[FixedPriceMinter](/docs/collections/contracts/fixed-price-minter) clone the
factory wires at creation; bespoke projects grant their own minter contract
instead. The artist's lever over any minter is `setMinter` (revoke the grant)
and `lockMinter` (freeze the set permanently).

What the token does own, it can lock one-way: `lockRenderer` pins the
tokenURI source, `lockSupply` freezes the cap that bounds every mint path,
and `lockMinter` freezes who may mint. Per-token provenance is the seed read
via `tokenSeed`, mint-time entropy that cannot be reconstructed later, plus
the `Minted` event, which records the issuing minter, recipient, id range,
and global mint index for every mint.

# concepts

### Thin token, modular minter

The token trusts a minter for exactly one thing: permission to call
`mintTo`/`mintToId`. It does not prescribe minter internals. The token-side
guarantees hold across all minters: the supply cap bounds every path, id
assignment follows the form, and every mint emits `Minted` with the calling
minter recorded. Sale-side guarantees (what was paid, to whom, under what
gate) are each minter's own contract surface; see
[FixedPriceMinter](/docs/collections/contracts/fixed-price-minter) for the
canonical one and the
[minter guide](/docs/collections/guides/write-a-minter) for writing your own.

### Owner and admins

The owner (the artist) is the root of authority and may grant admin keys with
`addAdmin`. An admin can call every management function the owner can except
managing the admin set, transferring ownership, and (on the pooled form)
changing the minter set. A grant is scoped to the owner that made it: an
ownership transfer invalidates every existing grant, so a new owner starts
with no admins. Companion contracts reuse this authority: the canonical
minter's config setters check the collection's `owner()`/`isAdmin`, so one
keyring governs both contracts.

### Creator attribution

Attribution is a two-sided onchain handshake with no shared registry write.
The owner lists creators on the collection (`setCreators`, mutable), which is
an assertion only. Each listed creator confirms by claiming the collection in
the Catalog from their own address. `isConfirmedCreator(who)` is the live
intersection: listed and claimed. Either side can retract and the
confirmation follows, since nothing is stored. `owner()` is understood as a
creator without listing; listing is for co-creators and explicit records.

### Id modes

The id mode is fixed per contract form, not configurable; `idMode()` reports
which. See [id modes](/docs/collections/concepts/id-modes).

- Sequential (`Surface`): the contract assigns ids 1, 2, 3, ... in mint
  order, so the token id is the mint order. Ids are never reused after a
  burn, and the supply cap bounds mints ever. `mintTo` is batch-native: one
  call mints a contiguous id range with one `Minted` event. `burn` is the
  standard owner-or-approved burn
- Pooled (`PooledSurface`): the authorized minter chooses every id through
  `mintToId` (`tokenId == sourceId` forms; id 0 is legal). A burned id can be
  minted again as a new instance with a fresh seed. The supply cap bounds
  live supply, and `burn` is minter-only. The pooled form holds one minter at
  a time

### Seed

Every mint stamps one `bytes32` of entropy, read with `tokenSeed`:
`keccak256(prevrandao, collection, tokenId, mintIndex)`, per
`docs/injection-convention.md`. It is the only per-token storage, and a
nonzero seed doubles as the was-ever-minted sentinel. The recipient address
is excluded from the formula, so entropy does not depend on the minter and
there is no wallet-grinding surface. Derived from `prevrandao`: acceptable
unpredictability for art, not for lotteries. Works whose mechanics need
other mint-time data (the mint block, pooled order) record it in their own
minter; the mint block of any token is the `Minted` log's block.

### Permanence

Three one-way locks cover the state the token owns. `lockRenderer`
(optional) pins the renderer pointer permanently; the token cannot attest a
renderer's internals, so a locked pointer plus an immutable renderer is full
presentation permanence, while a mutable renderer behind a locked pointer
remains changeable within that renderer. `lockSupply` freezes the supply
cap, the scarcity promise; the cap binds every mint path, so no later minter
grant can exceed it. `lockMinter` freezes the minter set; for a backed
pooled collection this guarantees no minter can be swapped in later to
retire another minter's backed tokens.

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

The Surface System is pre-deploy, so the examples above use a
`<COLLECTION_ADDRESS>` placeholder; collection addresses come from the
factory's `SurfaceCreated` events at launch.

## function mintTo

access: minter-only (`msg.sender` must be an authorized minter, else `NotMinter`)

The sequential form's only mint entrypoint. Non-payable: the calling minter
handles all economics before calling. Mints `quantity` tokens to `to` with
ids `firstTokenId .. firstTokenId + quantity - 1`, where `firstTokenId` is
one past the mints-ever count, and returns `firstTokenId`. One call, one
`Minted` event, regardless of quantity. Reverts `ZeroQuantity` for
`quantity == 0` and `ExceedsCap` when the batch would cross the supply cap.
The mint path makes no external calls; a contract recipient is not called
(`_mint`, not `_safeMint`).

## function burn

access: owner-or-approved on the sequential form, minter-only on the pooled form (else `NotAuthorized`)

Burns a token, decrementing live supply. Authority depends on the form: on
the sequential form the token holder or an approved address may burn; on the
pooled form only an authorized minter may burn, so a holder cannot destroy a
pooled token out of band and strand what backs it. Reverts
`ERC721NonexistentToken` for an id that is not currently minted. The burned
token's seed stays readable until a pooled re-mint of the same id overwrites
it. On the sequential form a burn never frees cap capacity; on the pooled
form it does. Emits `Burned`.

## function setRenderer

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Points the renderer slot at a new renderer. Reverts `RendererIsLocked` once
`lockRenderer` has run, `RendererRequired` for the zero address, and
`RendererNotContract` for an address with no code, since a codeless renderer
would brick `tokenURI`. Emits `RendererSet`, an ERC-4906
`BatchMetadataUpdate` covering all tokens, and an ERC-7572
`ContractURIUpdated`, so marketplaces refresh cached metadata at both the
token and collection level.

## function setRoyalty

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Updates the EIP-2981 royalty reported by `royaltyInfo`. Capped at 50%
(`RoyaltyTooHigh` above 5000 bps), same as at init; a zero receiver resolves
to `owner()` at read time. Royalty is advisory metadata honored at
marketplaces' discretion. Emits `RoyaltySet`.

## function setSupplyCap

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Updates the supply cap; 0 means open supply. Reverts `SupplyIsLocked` once
`lockSupply` has run, and `BadSupplyCap` for a nonzero cap below current
usage (mints ever on the sequential form, live supply on the pooled form).
The cap determines which token carries a renderer's final-mint trait, so the
call also emits a full-range `BatchMetadataUpdate` alongside `SupplyCapSet`.

## function setCreators

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

The owner's side of attribution: list (`listed = true`) or unlist creators,
any time. A listing is an assertion only; a creator becomes confirmed once
they also claim this collection in the Catalog, so a listed non-participant
stays unconfirmed. Emits `CreatorListed` per address.

## function setMinter

access: owner-only on the pooled form; owner or admin on the sequential form (else `NotAuthorized`)

Grants (`allowed = true`) or revokes an authorized minter. Reverts
`ZeroMinter` for the zero address and `MinterIsLocked` once `lockMinter` has
run; a call that does not change the state is a no-op. The pooled form holds
one minter at a time, because its burn authority is minter-wide and a second
minter could retire a token the first one backs, so granting a second there
reverts `TooManyMinters`; the sequential form permits any number of grants.
Minter-set changes on the pooled form are owner-only for the same reason: a
delegated admin must not be able to rotate the minter under a backed
collection. Granting a minter is the artist's visible onchain authorization
of a sale mechanic, and revoking it is the artist's lever over that minter.
Emits `MinterSet`.

## function lockRenderer

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

One-way, optional (off by default): permanently pin the renderer pointer, so
`tokenURI`/`contractURI` are answered by the current renderer contract from
then on. The token cannot attest what a renderer does internally: an
immutable renderer behind a locked pointer is full presentation permanence,
while a mutable renderer behind a locked pointer remains changeable within
that renderer. Reverts `RendererIsLocked` if already locked. Emits
`RendererLocked`.

## function lockSupply

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

One-way: permanently lock the supply cap, the scarcity promise. The cap
binds every mint path, so a locked cap is a hard ceiling regardless of what
minters are granted later. Reverts `SupplyIsLocked` if already locked. Emits
`SupplyLocked`.

## function lockMinter

access: owner-only on the pooled form; owner or admin on the sequential form (else `NotAuthorized`)

One-way, optional (off by default): permanently freeze the minter set, so no
minter can be granted or revoked afterward. For a backed pooled collection
this is the promise that no minter can be swapped in later to retire another
minter's backed tokens; call it once the intended minter is wired. On the
sequential form it freezes the set of sale mechanics. Reverts
`MinterIsLocked` if already locked. Emits `MinterLocked`.

## function addAdmin

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Grants an admin key. An admin can call every management function the owner
can except managing the admin set, transferring ownership, and changing the
minter set on a pooled collection (owner-only there). Reverts `ZeroAccount`
for the zero address and `AlreadyAdmin` for an existing admin or the owner
(who already counts as an admin), so every grant is one explicit state
change with a matching event. A grant is scoped to the owner that made it:
it stops being valid the moment ownership transfers, so a new owner never
inherits the old owner's keys. Emits `AdminSet`.

## function removeAdmin

access: owner, or the admin itself renouncing (else `NotAuthorized`)

Revokes an admin. The owner may remove any admin; an admin may renounce
itself by passing its own address. Reverts `NotAnAdmin` if the account holds
no grant, so a typo or double-remove fails instead of emitting a misleading
event. Removing every admin is safe: the owner keeps full access. Emits
`AdminSet`.

## function notifyMetadataUpdate

access: the current renderer, or owner/admin (else `NotAuthorized`)

Emits an ERC-4906 `BatchMetadataUpdate` refresh signal for metadata changes
the token cannot observe: an onchain-live work whose output moved with chain
state, a reveal, new captures. Marketplaces subscribe to these events on the
token contract, so the renderer calls this instead of emitting its own.
Event emission only; no state change. Works after `lockRenderer`, since the
lock pins the renderer address, not its output.

## function rescueStrayETH

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Sweeps the contract's entire ETH balance to `to`. The token holds no value
of its own (no payable function), so any balance was force-fed (selfdestruct
or a pre-funded address) and nothing is owed to anyone. Reverts
`ZeroAccount` for the zero address, `NoStrayETH` on a zero balance, and
`RescueFailed` if the transfer reverts. Emits `StrayETHRescued`.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`)

Sets up the clone exactly once: name, symbol, owner, the `SurfaceConfig`,
the factory's default renderer (used when the config names none), initial
minters, the Catalog address used for creator confirmation, and an optional
initial creator listing. Reverts `OwnerRequired` for a zero owner,
`RoyaltyTooHigh` above the 50% cap, `RendererRequired` when neither the
config nor the factory supplies a renderer, `RendererNotContract` for a
renderer with no code, `ZeroMinter` for a zero address among the initial
minters, and `TooManyMinters` when a pooled clone is seeded with more than
one. Locks passed true in the config apply from initialization. The
implementation's constructor disables initializers, so only clones can be
initialized, and only once. Emits `MinterSet` per initial minter,
`CreatorListed` per listed creator, lock events for locks set at init, and
`SurfaceConfigured`.

## function transferOwnership

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Standard OpenZeppelin Ownable2Step: starts a two-step ownership transfer by
recording a pending owner who must call `acceptOwnership`. Existing admin
grants stop being valid when the transfer completes. Emits
`OwnershipTransferStarted`.

## function acceptOwnership

access: pending-owner-only (else `OwnableUnauthorizedAccount`)

Standard Ownable2Step: the pending owner completes the transfer and becomes
owner. Admin grants made by the previous owner are no longer valid from this
point; the new owner re-grants explicitly. Emits `OwnershipTransferred`.

## function renounceOwnership

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Standard OpenZeppelin Ownable: sets the owner to the zero address,
permanently. Every owner and admin gate closes (an admin grant is valid only
while its granting owner is the current owner, so a renounced collection has
no admins), and the config is frozen at its current values. A royalty
receiver left at zero then reports the zero address. One-way; there is no
recovery.

## function approve

access: owner-or-operator-only (standard ERC721 approval authority, else an `ERC721` revert)

Standard ERC721: grants a single-token spending approval. Emits `Approval`.

## function setApprovalForAll

access: permissionless (any caller sets their own operator approval)

Standard ERC721: grants or revokes an operator to manage all of the caller's
tokens. Emits `ApprovalForAll`.

## function transferFrom

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 transfer. The mint entrypoints and `burn` are the
non-standard surface; ordinary transfers behave exactly as EIP-721
specifies. Emits `Transfer`.

## function safeTransferFrom(address,address,uint256)

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 safe transfer with no data. Checks that a contract recipient
implements `onERC721Received` (`ERC721InvalidReceiver` otherwise). Emits
`Transfer`.

## function safeTransferFrom(address,address,uint256,bytes)

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 safe transfer with a data payload forwarded to the
recipient's `onERC721Received`. Emits `Transfer`.

## function version

The implementation version, a compile-time constant (`1` for this
generation). The system evolves by deploying a new implementation and
factory, never by changing a live collection, so a collection reports the
version it was cloned from for its whole life.

## function config

Returns the live `SurfaceConfig` and `minted`, the mints-ever count (not
live supply). The config's six fields are `supplyCap` (0 = open supply),
`royaltyBps`, `royaltyReceiver` (0 = `owner()`), `renderer`,
`rendererLocked`, and `supplyLocked`. Setters edit these fields in place, so
this view always reports what the contract uses. Sale state (price, window,
sale phase) is not here; read the collection's minter for that.

## function idMode

The collection form: Sequential (0) or Pooled (1). Fixed by the contract,
not configurable. See [id modes](/docs/collections/concepts/id-modes).

## function totalSupply

Live supply: mints ever minus burns. On the sequential form a burn
permanently lowers this; on the pooled form a re-mint of a burned id raises
it again.

## function tokenSeed

The mint-time entropy for a token, stamped in the mint transaction: the only
per-token storage on the contract. Reverts `NeverMinted` for an id that was
never minted (a nonzero seed is the existence sentinel). Stays readable for
a burned id until a pooled re-mint overwrites it with the new instance's
seed.

## function isAdmin

True if the account may use the admin-gated setters: the owner, or anyone
holding a currently valid grant. The owner is included because every
admin-gated function also admits the owner, so external integrations that
gate on this view accept the owner directly.

## function isListedCreator

Whether the owner has listed `who` as a creator (the owner's assertion). One
half of confirmation; see `isConfirmedCreator`.

## function isConfirmedCreator

Live, mutual attribution: true only if the owner has listed `who` and `who`
has claimed this collection in the Catalog (`isContractRegistered`).
Computed on read, so retracting either side (unlist, or un-claim) revokes
the confirmation. False when the collection has no Catalog configured.

## function catalog

The Catalog singleton this collection confirms creators against (the zero
address when confirmation is disabled).

## function isMinter

True if the address is an authorized minter allowed to call the mint
entrypoint.

## function isRendererLocked

True once `lockRenderer` has permanently pinned the renderer pointer.

## function isSupplyLocked

True once `lockSupply` has permanently locked the supply cap.

## function isMinterLocked

True once `lockMinter` has permanently frozen the minter set.

## function renderer

The active renderer address that `tokenURI` and `contractURI` delegate to.
Set at init (the artist's choice, or the factory default when they named
none) and changeable via `setRenderer` until `lockRenderer`.

## function tokenURI

Standard ERC721 metadata entry point. Requires the token to exist
(`ERC721NonexistentToken` otherwise) and delegates to the active renderer's
`tokenURI`.

## function contractURI

Collection-level metadata, delegated to the active renderer's `contractURI`.

## function royaltyInfo

EIP-2981 royalty for a sale price: the receiver (the configured royalty
receiver, or `owner()` when unset) and the amount computed from the
configured `royaltyBps`. Advisory, honored at marketplaces' discretion.

## function supportsInterface

Standard ERC165 support check. Returns true for ERC721, ERC165, EIP-2981
(`0x2a55205a`), and ERC-4906 (`0x49064906`).

## function name

Standard ERC721 collection name, set at init.

## function symbol

Standard ERC721 collection symbol, set at init.

## function owner

Standard OpenZeppelin Ownable current owner: the artist address that is the
root of authority over the config, the minter set, and the admin set.

## function pendingOwner

Standard Ownable2Step pending owner: the address that has been offered
ownership and must call `acceptOwnership`, or zero when no transfer is in
flight.

## function balanceOf

Standard ERC721: the number of tokens owned by an address.

## function ownerOf

Standard ERC721: the current owner of a token. Reverts
`ERC721NonexistentToken` for an id that is not currently minted.

## function getApproved

Standard ERC721: the single-token approved spender for a token, or zero.

## function isApprovedForAll

Standard ERC721: true if an operator is approved to manage all of an
owner's tokens.

## event Minted

One event per mint call, the permanent per-mint provenance record. Indexed
by `minter` (the authorized minter that issued the tokens) and `to` (the
recipient). On the sequential form a call covers ids
`[firstTokenId, firstTokenId + quantity - 1]`; on the pooled form
`firstTokenId` is the minted id and `quantity` is 1. `firstMintIndex` is the
global mint order of the call's first token (token k of the batch has mint
index `firstMintIndex + k`); it is carried explicitly because pooled order
is not derivable from reused ids. The mint block is the log's own block.
Sale data (payment, referral) is not here; the canonical minter emits its
own `Sold` event alongside this one.

## event Burned

Emitted when a token is burned. Indexed by `tokenId`. A pooled id may later
be re-minted, at which point a new `Minted` covers the fresh instance.

## event SurfaceConfigured

Emitted once at init with the collection's id mode and supply cap. The id
mode is fixed; the cap is a live setting with its own update event.

## event RoyaltySet

Emitted when the EIP-2981 royalty changes with `setRoyalty`. Indexed by
`royaltyReceiver`.

## event SupplyCapSet

Emitted when the supply cap changes with `setSupplyCap`.

## event RendererSet

Emitted when the renderer slot changes. Indexed by `renderer`.

## event RendererLocked

Emitted once when `lockRenderer` permanently pins the renderer pointer
(via the call or a lock set at init).

## event SupplyLocked

Emitted once when `lockSupply` permanently locks the supply cap (via the
call or a lock set at init).

## event MinterLocked

Emitted once when `lockMinter` permanently freezes the minter set.

## event MinterSet

Emitted when a minter is granted or revoked, and once per initial minter at
init. Indexed by `minter`, with the `allowed` flag. Indexers derive the full
minter set from these; the factory's `SurfaceCreated` names the
canonically wired minter directly.

## event CreatorListed

Emitted when the owner lists or unlists a creator (including each creator
seeded at init). Indexed by `creator`, with the `listed` flag. Indexers
build a collection's roster from these; confirmed status is a live
`isConfirmedCreator` read.

## event AdminSet

Emitted when an admin key is granted (`allowed = true`) or revoked. Indexed
by `account`.

## event MetadataUpdate

ERC-4906 single-token refresh signal, declared for interface completeness;
range refreshes go through `BatchMetadataUpdate`. Marketplaces subscribe to
this to re-fetch a token's metadata.

## event BatchMetadataUpdate

ERC-4906 range refresh signal, emitted by `setRenderer` and `setSupplyCap`
(covering all tokens) and by `notifyMetadataUpdate` (renderer- or
admin-chosen range). Marketplaces subscribe to this to re-fetch cached
metadata.

## event ContractURIUpdated

ERC-7572 contract-level refresh signal, emitted by `setRenderer` alongside
the token-range refresh: a new renderer can answer `contractURI`
differently, and this is the event marketplaces watch to re-fetch the
collection page.

## event StrayETHRescued

Emitted when `rescueStrayETH` sweeps force-fed ETH. Indexed by `to`, with
the swept `amount` in wei.

## event Transfer

Standard ERC721 transfer event, emitted on mint (from the zero address),
transfer, and burn (to the zero address). Indexed by `from`, `to`, and
`tokenId`.

## event Approval

Standard ERC721 single-token approval event. Indexed by `owner`, `approved`,
and `tokenId`.

## event ApprovalForAll

Standard ERC721 operator approval event. Indexed by `owner` and `operator`,
with the `approved` flag.

## event OwnershipTransferStarted

Standard Ownable2Step event, emitted by `transferOwnership` when a pending
owner is recorded. Indexed by `previousOwner` and `newOwner`.

## event OwnershipTransferred

Standard Ownable event, emitted at init when the first owner is set, when
`acceptOwnership` completes a transfer, and when `renounceOwnership` sets
the owner to zero. Indexed by `previousOwner` and `newOwner`.

## event Initialized

Standard OpenZeppelin Initializable event, emitted once when the clone is
initialized.

## error NotMinter

The mint entrypoint was called by an address that is not an authorized
minter. The owner grants minters with `setMinter`.

## error ZeroQuantity

`mintTo` was called with `quantity == 0`. Mint at least one token.

## error ExceedsCap

A mint would cross the supply cap: mints ever on the sequential form, or
live supply on the pooled form.

## error BadSupplyCap

`setSupplyCap` was given a nonzero cap below current usage: mints ever on
the sequential form (ids are never reused), or live supply on the pooled
form.

## error SupplyIsLocked

`setSupplyCap` or `lockSupply` was called after `lockSupply`. The supply cap
is permanently frozen.

## error RendererIsLocked

`setRenderer` or `lockRenderer` was called after `lockRenderer`. The
renderer pointer is permanently pinned.

## error MinterIsLocked

`setMinter` or `lockMinter` was called after `lockMinter`. The minter set is
permanently frozen.

## error TooManyMinters

A minter grant would exceed the pooled form's one-minter limit (its burn
authority is minter-wide), whether via `setMinter` or seeded at init through
`initialMinters`.

## error ZeroMinter

An initial minter in `initialize`, or the `setMinter` target, was the zero
address. Supply a real minter address.

## error NotAuthorized

A management function gated `onlyOwnerOrAdmin` was called by neither the
owner nor an admin; a pooled minter-set change was attempted by a non-owner;
`removeAdmin` was called by someone other than the owner or the admin
itself; `notifyMetadataUpdate` was called by neither the renderer nor an
owner/admin; or `burn` was called without burn authority for the form.

## error AlreadyAdmin

`addAdmin` was called for the owner or an existing admin. Every grant is a
single explicit state change.

## error NotAnAdmin

`removeAdmin` was called for an account that holds no grant. A typo or
double-remove fails instead of emitting a misleading event.

## error ZeroAccount

`rescueStrayETH` or `addAdmin` was passed the zero address. Supply a real
account.

## error OwnerRequired

`initialize` was given the zero address as the owner. A collection must have
an owner.

## error RendererRequired

`initialize` was given no renderer (neither the config nor the factory
default names one), or `setRenderer` was passed the zero address. The
renderer slot always holds a nonzero address.

## error RendererNotContract

The renderer address has no code (carries the offending address). Raised by
`initialize` and `setRenderer`: a codeless renderer would brick `tokenURI`,
fatally so for a collection initialized `rendererLocked`, so the typo is
refused at the door.

## error NotAContract

Declared on the shared collection interface for companion use; the
collection's own contract-code check on renderers raises
`RendererNotContract` instead, so the collection itself does not raise this.

## error RoyaltyTooHigh

`initialize` or `setRoyalty` was given a royalty above the 50% cap
(5000 bps).

## error NeverMinted

`tokenSeed` was read for an id that was never minted (its seed slot is
zero).

## error NoStrayETH

`rescueStrayETH` found a zero ETH balance to sweep.

## error RescueFailed

The ETH transfer inside `rescueStrayETH` reverted.

## error InvalidInitialization

Standard OpenZeppelin Initializable error: `initialize` was called more than
once, or called on the implementation whose initializers are disabled.

## error NotInitializing

Standard OpenZeppelin Initializable error: an `onlyInitializing` step ran
outside an active initialization.

## error ReentrancyGuardReentrantCall

Standard OpenZeppelin ReentrancyGuard error: a `nonReentrant` function was
re-entered.

## error ERC721IncorrectOwner

Standard ERC721 error: a token operation named an owner that does not match
the token's actual owner.

## error ERC721InsufficientApproval

Standard ERC721 error: the caller lacks approval to transfer or burn the
token.

## error ERC721InvalidApprover

Standard ERC721 error: the approver is not authorized to grant the approval.

## error ERC721InvalidOperator

Standard ERC721 error: an invalid operator address (for example the zero
address) was used in an approval.

## error ERC721InvalidOwner

Standard ERC721 error: an invalid owner address (for example the zero
address) was used in an ownership query.

## error ERC721InvalidReceiver

Standard ERC721 error: a safe transfer targeted a contract that does not
accept ERC721 tokens (bad `onERC721Received`).

## error ERC721InvalidSender

Standard ERC721 error: a transfer named a sender that does not own the
token.

## error ERC721NonexistentToken

Standard ERC721 error: the referenced token id does not exist (never minted
or already burned).

## error OwnableInvalidOwner

Standard OpenZeppelin Ownable error: an invalid owner address (for example
the zero address) was supplied.

## error OwnableUnauthorizedAccount

Standard OpenZeppelin Ownable error: an owner-gated function (`addAdmin`,
`transferOwnership`, `renounceOwnership`) was called by a non-owner, or
`acceptOwnership` by a non-pending-owner.
