---
title: Collection
---

# summary

The one core of the PND Collection System: a single OpenZeppelin ERC721 that
holds ownership, ETH payment paths, and per-token provenance, and nothing else.
Every artist gets their own copy, deployed as an immutable EIP-1167 clone by
[the factory](/docs/collections/contracts/factory). There is no proxy admin, no upgrade path,
and no seal: what deploys is what runs. The upgradeable-variant OZ bases are used
only for the initializer pattern that clones require.

All variability lives in [four swappable slots](/docs/collections/concepts/four-slots):
renderer, price strategy, mint hook, and a set of authorized extension minters.
The core keeps money custody on the built-in paid mint paths, so a price strategy
(a view) or a mint hook (non-payable) can never introduce a theft or reentrancy
path. Payment is honest: the collector pays exactly the resolved price. A fixed
protocol Referral Share of 10% (`REFERRAL_SHARE_BPS = 1000`) is paid out of that
price to whoever hosts the mint, and folds back to the artist on a direct mint.

Each minted token carries its own identity: mint-time entropy read via
`tokenSeed`, the one per-token fact that can never be reconstructed later. All
other provenance derives or is event-stamped: in Sequential mode the token id IS
the mint order, and every `Minted` event permanently records the order, the
referrer, and the lifecycle status at that moment. The
[id mode](/docs/collections/concepts/id-modes) is fixed at init: Sequential (the
core assigns ids, never reused after burn) or Pooled (an authorized minter
supplies ids, and a burned id can be minted again as a fresh instance). Every
sale term is a live setting (window, price, royalty, supply cap). The core
stores NO presentation data: `tokenURI`/`contractURI` defer wholly to the
renderer slot, with the work config and static images living in renderer-land
([GenerativeRenderer](/docs/collections/contracts/generative-renderer)'s work
registry, [RenderAssets](/docs/collections/contracts/render-assets)). Two
one-way locks cover the state the core actually owns: `lockRenderer` (pin the
renderer pointer, optional) and `lockSupply` (the scarcity promise). Payment accrues as
pull-payment balances claimed through `withdraw`; no external transfer happens
during a mint, so a reverting recipient can never brick minting.

# concepts

### The four slots

The core delegates all variable behavior to four slots the owner or an admin can
point at external contracts:

- `renderer` supplies `tokenURI` and `contractURI`; unset falls back to
  `defaultRenderer`, which is set at init and never zero
- `priceStrategy` supplies the resolved price on the built-in paid path; unset
  means the stored fixed `price` applies
- `mintHook` runs `beforeMint` (which can reject) and `afterMint` on every mint
  path, built-in and extension alike
- extension minters are addresses granted via `setMinter` that may call `mintTo`
  or `mintToId`, carrying their own economics

See [the four-slots concept](/docs/collections/concepts/four-slots) and the
[minter guide](/docs/collections/guides/write-a-minter).

### Owner and admins

The owner (the artist) is the root of authority and may grant flat, full-access
admin keys with `addAdmin`. An admin can call every management function the owner
can except managing the admin set and transferring ownership, which stay
owner-only. Admin access is real power — an admin can redirect payouts and
freeze metadata — so grants are explicit, evented, and revocable at any time.

### Creator attribution

Attribution is a two-sided, fully onchain handshake — no shared registry. The
owner LISTS creators on the collection (`setCreators`, mutable) — their
assertion of who made the work. Each listed creator CONFIRMS by claiming the
collection in the Catalog (the artist-record public good) from their own
address. `isConfirmedCreator(who)` is the live intersection: listed AND
claimed. Neither side can fake the other — a rando can't be listed, and a
listed non-participant never claims — so credit is squat- and
false-credit-proof, and reading the Catalog live means retracting either side
cleanly revokes it. `owner()` is the deployer and is understood as a creator
without listing; listing is for co-creators.

### Id modes

The id mode is fixed at init and governs how ids are assigned and who can mint
and burn. See [id modes](/docs/collections/concepts/id-modes).

- Sequential: the core assigns `nextId++` (first id is 1). The built-in paid
  paths (`mint`, `mintWithReferral`) work only here. `mintTo` assigns the next id.
  The supply cap bounds mints ever, so a burn never frees a new slot. `burn` is
  the standard owner-or-approved burn
- Pooled: an authorized extension minter supplies every id through `mintToId`
  (`tokenId == sourceId` forms, id 0 is legal). The built-in paid paths revert.
  A burned id can be minted again as a NEW instance with a fresh Mint Mark and
  fresh entropy; the prior instance's history persists in events. The supply cap
  bounds live supply. `burn` is minter-only

### Mint Marks and entropy

Every mint stamps one `bytes32` of entropy derived from `prevrandao`, the
collection address, the token id, the recipient, and the mint index — read it
with `tokenSeed`. That seed is the only per-token storage: it can never be
retrofitted (randomness only exists at mint time), and a nonzero seed doubles as
the was-ever-minted sentinel. The Mint Mark itself is fully derived: in
Sequential mode the token id IS the mint order (first = id 1; final = the
collection is Closed and the id equals the minted count), and the `Minted` event
permanently records order, referrer, and status for indexers. A work whose art
or mechanics need other mint-time data (the mint block, pooled order) records it
to its own storage with a one-line mint hook — the cost lands only on works that
opt in. The seed is `prevrandao`-derived: acceptable unpredictability for art,
not for lotteries. See
[mint marks and entropy](/docs/collections/concepts/mint-marks-and-entropy).

### Lifecycle status

The collection's status — `Scheduled` (before `mintStart`), `Open`, or `Closed`
(past `mintEnd`, or a full sequential cap) — is derived purely from the mint
window, the supply cap, and the clock. Nothing stores it: `config()` reports it
live, and each `Minted` event stamps the value at mint time. Reschedule the
window with `setMintWindow` and the status follows.

### Permanence

The core locks only what it owns. `lockRenderer` (optional, off by default)
permanently pins the renderer pointer; `lockSupply` permanently freezes the
supply cap — the scarcity promise, binding extension minters too. Everything
presentation-side is the renderer's own offer: for the bundled
GenerativeRenderer, `lockWork(collection)` pins the algorithm, so pointer lock
+ work lock = full presentation permanence. The core cannot attest an arbitrary
renderer's internals — a custom renderer's mutability is the artist's
inspectable choice, not the core's promise.

### Live reads

```bash
# Live supply (minted minus burned)
cast call <COLLECTION_ADDRESS> "totalSupply()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# The fixed referral share in bps (1000 = 10%)
cast call <COLLECTION_ADDRESS> "referralShareBps()(uint16)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# Resolved price for 1 token, no extra data
cast call <COLLECTION_ADDRESS> "currentPrice(address,uint256,bytes)(uint256)" \
  0x0000000000000000000000000000000000000000 1 0x \
  --rpc-url https://ethereum-rpc.publicnode.com
```

The address lands at launch; the Collection System is pre-deploy, so the examples
above use a `<COLLECTION_ADDRESS>` placeholder.

## function mint

access: permissionless (payable; no caller gate, guarded by window/cap/payment checks)

The honest default mint path. Passes `referrer = address(0)` so no referral share
is taken and the full price goes to the artist. Sequential mode only: in a pooled
collection it reverts `PooledSellsViaMinter`, since pooled collections sell
exclusively through their authorized minter.

Reverts `ZeroQuantity` for `quantity == 0`, `MintNotStarted` before `mintStart`,
`MintEnded` at or after a non-zero `mintEnd`, and `ExceedsCap` when the sequential
cap would be crossed. With no price strategy set it requires exact payment
(`WrongPayment` on a mismatch); with a strategy set it reads the price once,
requires `msg.value >= price` (`Underpayment` otherwise), and accrues any excess
back to the payer as a pull-refund. A mint hook, if set, runs before and after
and can reject in `beforeMint` (`HookRejected`). Emits `Minted` for the id range
`[firstTokenId, firstTokenId + quantity - 1]`.

## function mintWithReferral

access: permissionless (payable; no caller gate, guarded by window/cap/payment checks)

Same paid path as `mint`, but credits a `referrer` its 10% share of the price;
`referrer == address(0)` folds the share back to the artist. PND's frontend passes
PND's address, a self-hosted page passes the artist's address. `hookData` is
forwarded to both the mint hook and the price strategy. Sequential mode only:
reverts `PooledSellsViaMinter` in pooled mode. Same window, cap, payment, and
hook behavior and reverts as `mint`. Emits `ReferralPaid` for a non-zero referral
cut alongside `Minted`.

## function mintTo

access: minter-only (`msg.sender` must be an authorized extension minter, else `NotMinter`)

The extension mint path for Sequential mode. Non-payable: the calling minter
carries all value handling and honors the referral share by convention. The core
assigns the next id and returns it. Reverts `PooledNeedsMintToId` in pooled mode.
The cap and id assignment are enforced exactly as on the paid path, but the sale
window is not: an extension minter owns its own schedule, and the artist's lever
is revoking the grant with `setMinter`. Hooks still run (`HookRejected` on
rejection); `ExceedsCap` on a cap crossing. Emits `Minted` with quantity 1.

## function mintToId

access: minter-only (`msg.sender` must be an authorized extension minter, else `NotMinter`)

The extension mint path for Pooled mode: the minter supplies the `tokenId`
(`tokenId == sourceId` forms, id 0 is legal). Non-payable; the minter carries all
value handling. Reverts `SequentialAssignsIds` in sequential mode, where the core
assigns ids. A previously burned id mints again as a NEW instance with a fresh
Mint Mark and fresh entropy; the prior instance's history persists in events. The
underlying OZ mint reverts on a live id, so a live token can never be minted over.
Hooks run (`HookRejected`); `ExceedsCap` bounds live supply. Emits `Minted` with
quantity 1.

## function burn

access: owner-or-approved in Sequential, minter-only in Pooled (else `NotAuthorized`)

Burns a token, decrementing live supply. Authority depends on the id mode: in
Sequential mode the standard owner-or-approved caller may burn; in Pooled mode
only an authorized extension minter may burn, so a holder or approved operator
cannot destroy a pooled token out of band and strand its backing or desync the
pool. Reverts if the token is not owned (nonexistent). The Mint Mark and seed of
the burned instance stay readable until a pooled re-mint of the same id overwrites
them. Emits `Burned`.

## function setMintWindow

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Reschedules the built-in paid mint window: push back a delayed start, extend a
slow sale, or close early by setting the end to now. Reverts `BadMintWindow`
unless `end` is 0 (open-ended) or strictly after `start`. Governs the built-in
paid path only; extension minters keep their own schedules. The derived lifecycle
status follows the new window immediately. Emits `MintWindowSet`.

## function setPrice

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Updates the stored fixed price, ignored while a price strategy is set. Exact-match
payment on the paid path means a mint transaction in flight against the old price
reverts (`WrongPayment`) rather than overpaying. Emits `PriceSet`.

## function setRoyalty

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Updates the EIP-2981 royalty reported by `royaltyInfo`. Capped at 50%
(`RoyaltyTooHigh` above `5000` bps), same as at init; a zero receiver falls back
to `owner()`. Royalty is advisory metadata honored at marketplaces' discretion.
Emits `RoyaltySet`.

## function setSupplyCap

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Updates the supply cap; 0 means open supply. Reverts `SupplyIsLocked` once
`lockSupply` has run, and `BadSupplyCap` for a non-zero cap below what already
exists (mints ever in Sequential mode, since ids are never reused; live supply in
Pooled mode). Shrinking the cap to exactly the minted count closes the collection;
growing it reopens. Emits `SupplyCapSet`.

## function lockSupply

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

One-way: permanently locks the supply cap — the scarcity promise, beside
the renderer-side work lock and `lockRenderer`. The cap binds the extension mint paths too, so a
locked cap is a hard ceiling regardless of what minters are granted later.
Reverts `SupplyIsLocked` if already locked. Emits `SupplyLocked`.

## function setRenderer

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Points the renderer slot at a new renderer, or zero to fall back to
`defaultRenderer`. Reverts `RendererIsLocked` once `lockRenderer` has run.
Emits `RendererSet` and an ERC-4906 `BatchMetadataUpdate` covering all tokens, so
marketplaces refresh cached metadata.

## function lockRenderer

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

One-way, optional (off by default): permanently pin the renderer pointer, so
`tokenURI`/`contractURI` are answered by the current renderer contract forever.
The core cannot attest what a renderer does internally — an immutable renderer
plus a locked pointer is full presentation permanence; a mutable renderer with
a locked pointer is the artist's explicit, inspectable choice. Pairs with the
renderer-side work lock (`GenerativeRenderer.lockWork`) for generative works.
Reverts `RendererIsLocked` if already locked. Emits `RendererLocked`.

## function setCreators

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

The owner's side of attribution: list (`listed = true`) or unlist co-creators.
Mutable — collaborators can be added or corrected any time. A listing is only
an assertion; a creator becomes confirmed only once they also claim this
collection in the Catalog, so a listed non-participant shows as
listed-but-unconfirmed. Emits `CreatorListed` per address.

## function setMintHook

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Points the mint hook slot at a new hook, or zero for none. The hook runs on every
mint path. Emits `MintHookSet`.

## function setPriceStrategy

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Points the price strategy slot at a new strategy, or zero to use the stored fixed
`price`. The strategy is read as a view on the built-in paid path. Emits
`PriceStrategySet`.

## function setMinter

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Grants (`allowed = true`) or revokes an extension minter that may call `mintTo`
or `mintToId`. Reverts `ZeroMinter` for the zero address. Authorizing a minter is
the artist's visible onchain choice, and revoking it is the artist's lever over
that minter's schedule and behavior. Emits `MinterSet`.

## function addAdmin

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Grants a flat, full-access admin key. An admin can call every management function
the owner can except managing the admin set and transferring ownership. Reverts
`ZeroAccount` for the zero address and `AlreadyAdmin` for an existing admin, so
every grant is one explicit state change with a matching event. Emits `AdminSet`.

## function removeAdmin

access: owner, or the admin itself renouncing (else `NotAuthorized`)

Revokes an admin. The owner may remove any admin; an admin may renounce itself by
passing its own address (self-removal only reduces privilege). Reverts
`NotAnAdmin` if the account is not currently an admin, so a typo or double-remove
fails loudly. Removing every admin is safe: the owner keeps full access. Emits
`AdminSet`.

## function setPayoutAddress

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Sets where the artist's share accrues for FUTURE mints; zero falls back to
`owner()`. Past accruals remain claimable at the old address. Emits
`PayoutAddressSet`.





## function notifyMetadataUpdate

access: the current renderer, or owner/admin (else `NotAuthorized`)

Emits an ERC-4906 `BatchMetadataUpdate` refresh signal for metadata changes the
core cannot observe: a ChainLive work whose output moved with chain state, or a
reveal-style renderer flipping state. Marketplaces subscribe to these events on
the token contract, so the renderer cannot emit them itself — it calls this
instead. Pure event emission; no state is touched. Deliberately works after
`lockRenderer`, where the now-pinned renderer is exactly the trusted party
to signal that a locked live work's output changed.

## function withdraw

access: permissionless (no caller gate; funds only ever go to the owed `account`)

Sends the pull-payment balance owed to `account` to `account`. Anyone may trigger
it, but funds only ever reach the owed address. Reverts `ZeroAccount` for the zero
address, `NothingToWithdraw` when nothing is owed, and `WithdrawFailed` if the
transfer reverts. Emits `Withdrawn`.

## function rescueStrayETH

access: owner or admin (`onlyOwnerOrAdmin`, else `NotAuthorized`)

Sweeps only ETH that is not owed to any payee (for example ETH force-fed via
selfdestruct) to `to`. Pull-payment balances are untouchable: only the surplus
above the running total of owed balances is ever sent. Reverts `ZeroAccount` for
the zero address, `NoStrayETH` when there is no surplus, and `RescueFailed` if the
transfer reverts. Emits `StrayETHRescued`.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`)

Sets up the clone exactly once: name, symbol, owner, collection config, work
config, default renderer, initial extension minters, an optional initial creator listing, and the
Catalog address used for creator confirmation. Reverts `OwnerRequired` for a zero owner, `RendererRequired` for a
zero default renderer, `RoyaltyTooHigh` if the royalty exceeds the 50% cap,
`BadMintWindow` if a non-zero `mintEnd` is not after `mintStart`, and `ZeroMinter`
for a zero address in the initial minters. The constructor disables initializers
on the implementation, so only clones can be initialized, and only once. Emits
`MinterSet` per initial minter and `CollectionConfigured`.

## function transferOwnership

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Standard OpenZeppelin Ownable2Step: starts a two-step ownership transfer by
recording a pending owner who must call `acceptOwnership`. Emits
`OwnershipTransferStarted`.

## function acceptOwnership

access: pending-owner-only (`msg.sender` must be the pending owner, else `OwnableUnauthorizedAccount`)

Standard Ownable2Step: the pending owner completes the transfer and becomes owner.
Emits `OwnershipTransferred`.

## function approve

access: owner-or-operator-only (standard ERC721 approval authority, else an `ERC721` revert)

Standard ERC721: grants a single-token spending approval. Emits `Approval`.

## function setApprovalForAll

access: permissionless (any caller sets their own operator approval)

Standard ERC721: grants or revokes an operator to manage all of the caller's
tokens. Emits `ApprovalForAll`.

## function transferFrom

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 transfer. The mint paths and `burn` are the non-standard surface;
ordinary transfers behave exactly as EIP-721 specifies. Emits `Transfer`.

## function safeTransferFrom(address,address,uint256)

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 safe transfer with no data. Checks that a contract recipient
implements `onERC721Received` (`ERC721InvalidReceiver` otherwise). Emits
`Transfer`.

## function safeTransferFrom(address,address,uint256,bytes)

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 safe transfer with a data payload forwarded to the recipient's
`onERC721Received`. Emits `Transfer`.

## function REFERRAL_SHARE_BPS

The fixed protocol referral share as a compile-time constant: 1000 bps, i.e. 10%.
Not artist-set. `referralShareBps` returns the same value.

## function referralShareBps

Returns the fixed protocol referral share in bps (1000 = 10%), the same value as
the `REFERRAL_SHARE_BPS` constant.

## function config

Returns the live `CollectionConfig` (every field reflects the current setters,
including the three module slots), the derived lifecycle `status` (Scheduled,
Open, or Closed — computed from the window, the cap, and the clock; never
stored), and `minted` (mints ever, not live supply).

## function currentPrice

The resolved price in wei for a prospective mint: the price strategy's quote if a
strategy is set, else the stored fixed `price` times `quantity`. Frontends read
this to quote a mint; with a dynamic strategy it can move between quote and
inclusion.

## function idMode

The collection's id mode, fixed at init: Sequential (0) or Pooled (1). See
[id modes](/docs/collections/concepts/id-modes).

## function totalSupply

Live supply: mints ever minus burns. In Sequential mode a burn permanently lowers
this; in Pooled mode a re-mint of a burned id raises it again.

## function tokenSeed

The mint-time entropy for a token, stamped in the mint transaction — the only
per-token storage on the contract. Reverts `NeverMinted` for an id that was
never minted (a nonzero seed is the existence sentinel). Stays readable for a
burned id until a pooled re-mint overwrites it; for a pooled re-mint this is the
current instance's fresh seed.


## function isAdmin

True if the account holds an explicit admin grant. The owner is an implicit admin
and is not required to appear here.

## function isRendererLocked

True once `lockRenderer` has permanently pinned the renderer pointer.

## function isListedCreator

Whether the owner has listed `who` as a creator (the owner's assertion). One
half of confirmation; see `isConfirmedCreator`.

## function isConfirmedCreator

Live, mutual attribution: true iff the owner has listed `who` AND `who` has
claimed this collection in the Catalog (`isContractRegistered`). Reads the
Catalog live, so retracting either side (unlist, or un-claim) cleanly revokes
credit. Returns false when the collection has no Catalog configured.

## function catalog

The Catalog singleton this collection confirms creators against (address zero
when confirmation is disabled).

## function isSupplyLocked

True once `lockSupply` has permanently locked the supply cap.







## function renderer

The active renderer address: the renderer override if set, else `defaultRenderer`.
This is the address `tokenURI` and `contractURI` delegate to.

## function defaultRenderer

The canonical fallback renderer, set at init and never zero. Used whenever the
renderer override slot is unset.

## function mintHook

The current mint hook address, or zero when no hook is set.

## function priceStrategy

The current price strategy address, or zero when the stored fixed price applies.

## function isMinter

True if the address is an authorized extension minter allowed to call `mintTo` or
`mintToId`.

## function pendingWithdrawal

The pull-payment balance in wei currently owed to an account, claimable with
`withdraw`.

## function tokenURI

Standard ERC721 metadata entry point. Requires the token to exist
(`ERC721NonexistentToken` otherwise) and delegates to the active renderer's
`tokenURI`.

## function contractURI

Collection-level metadata, delegated to the active renderer's `contractURI`.

## function royaltyInfo

EIP-2981 royalty for a sale price: the receiver (the configured royalty receiver,
or `owner()` when unset) and the royalty amount computed from the configured
`royaltyBps`. Advisory, honored at marketplaces' discretion.

## function supportsInterface

Standard ERC165 support check. Returns true for ERC721, ERC165, EIP-2981
(`0x2a55205a`), and ERC-4906 (`0x49064906`).

## function renounceOwnership

Disabled: this function is pure and always reverts `RenounceDisabled`. Renouncing
would orphan the collection, accruing default proceeds to a zero owner and
bricking every admin lever. Immutability comes from the clone having no upgrade
path, not from burning the owner.

## function name

Standard ERC721 collection name, set at init.

## function symbol

Standard ERC721 collection symbol, set at init.

## function owner

Standard OpenZeppelin Ownable current owner: the artist address that is the root
of authority over the config, slots, admin set, and withdrawal surface.

## function pendingOwner

Standard Ownable2Step pending owner: the address that has been offered ownership
and must call `acceptOwnership`, or zero when no transfer is in flight.

## function balanceOf

Standard ERC721: the number of tokens owned by an address.

## function ownerOf

Standard ERC721: the current owner of a token. Reverts `ERC721NonexistentToken`
for an id that is not currently minted.

## function getApproved

Standard ERC721: the single-token approved spender for a token, or zero.

## function isApprovedForAll

Standard ERC721: true if an operator is approved to manage all of an owner's
tokens.

## event Minted

One event per mint call — THE permanent per-mint provenance record. Built-in
paths cover `[firstTokenId, firstTokenId + quantity - 1]`; extension mints emit
quantity 1 with `firstTokenId` the minted id. Indexed by `to` and `referrer`.
Carries `firstMintIndex` (the global mint order of the call's first token; token
k's mint index is `firstMintIndex + k` — explicit because pooled order is not
derivable from reused ids) and `statusAtMint`, the lifecycle status derived at
mint time (a pooled re-mint after the window truthfully says Closed; an
extension mint before the public window says Scheduled). The mint block is the
log's own block number. Nothing here is stored per token; indexers read this
event and never need per-token calls.

## event Burned

Emitted when a token is burned. Indexed by `tokenId`. A pooled id may later be
re-minted, at which point a new `Minted` covers the fresh instance.

## event ReferralPaid

Emitted when a non-zero referral cut is credited on a paid mint. Indexed by
`referrer`, with the credited `amount` in wei.

## event CollectionConfigured

Emitted once at init with the collection's id mode, price, supply cap, mint
window, and cover artwork URI. Indexers read this to record a new collection's
terms; every term except the id mode is a live setting with its own update event.

## event MintWindowSet

Emitted when the paid mint window is rescheduled with `setMintWindow`.

## event PriceSet

Emitted when the stored fixed price changes with `setPrice`.

## event RoyaltySet

Emitted when the EIP-2981 royalty changes with `setRoyalty`. Indexed by
`royaltyReceiver`.

## event SupplyCapSet

Emitted when the supply cap changes with `setSupplyCap`.

## event RendererLocked

Emitted once when `lockRenderer` permanently pins the renderer pointer.

## event CreatorListed

Emitted when the owner lists or unlists a creator (including each creator seeded
at init). Indexed by `creator`, with the `listed` flag. Indexers build a
collection's roster from these; confirmed status is a live `isConfirmedCreator`
read.

## event SupplyLocked

Emitted once when `lockSupply` permanently locks the supply cap.

## event AdminSet

Emitted when an admin key is granted (`allowed = true`) or revoked. Indexed by
`account`.

## event MetadataUpdate

ERC-4906 single-token refresh signal (declared for interface completeness;
range refreshes go through `BatchMetadataUpdate` via the setters and
`notifyMetadataUpdate`). Marketplaces subscribe to this to re-fetch a token's
metadata.

## event BatchMetadataUpdate

ERC-4906 range refresh signal, emitted by `setRenderer` and `setWork` (covering
all tokens) and by `notifyMetadataUpdate` (renderer- or admin-chosen range).
Marketplaces subscribe to this to re-fetch cached metadata.

## event RendererSet

Emitted when the renderer slot changes. Indexed by `renderer`.

## event MintHookSet

Emitted when the mint hook slot changes. Indexed by `hook`.

## event PriceStrategySet

Emitted when the price strategy slot changes. Indexed by `strategy`.

## event MinterSet

Emitted when an extension minter is granted or revoked, and once per initial
minter at init. Indexed by `minter`, with the `allowed` flag.





## event PayoutAddressSet

Emitted when the artist payout address changes. Indexed by `payoutAddress`. Only
affects future accruals.

## event Withdrawn

Emitted when a pull-payment balance is paid out. Indexed by `account`, with the
`amount` in wei.

## event StrayETHRescued

Emitted when stray ETH not owed to any payee is swept. Indexed by `to`, with the
swept `amount` in wei.

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

Standard Ownable2Step event, emitted by `transferOwnership` when a pending owner
is recorded. Indexed by `previousOwner` and `newOwner`.

## event OwnershipTransferred

Standard Ownable event, emitted at init when the first owner is set and when
`acceptOwnership` completes a transfer. Indexed by `previousOwner` and `newOwner`.

## event Initialized

Standard OpenZeppelin Initializable event, emitted once when the clone is
initialized.

## error ZeroQuantity

A mint was called with `quantity == 0`. Mint at least one token.

## error ZeroAccount

`withdraw`, `rescueStrayETH`, or `addAdmin` was passed the zero address. Supply a
real account.

## error ZeroMinter

An initial minter in `initialize`, or the `setMinter` target, was the zero
address. Supply a real minter address.

## error Underpayment

A mint with a price strategy set sent less than the strategy's resolved price.
Send at least `currentPrice`; any excess accrues back to the payer.

## error WrongPayment

A mint with no price strategy set did not send exactly `price * quantity`. Fixed
pricing requires an exact match.

## error ExceedsCap

A mint would cross the supply cap: mints ever in Sequential mode, or live supply
in Pooled mode.

## error BadMintWindow

`initialize` or `setMintWindow` was given a non-zero `mintEnd` that is not
strictly after `mintStart`. Use `mintEnd == 0` for open-ended or an end after the
start.

## error BadSupplyCap

`setSupplyCap` was given a non-zero cap below what already exists: mints ever in
Sequential mode (ids are never reused), or live supply in Pooled mode.

## error RendererIsLocked

`setRenderer` or `lockRenderer` was called after `lockRenderer`. The renderer
pointer is permanently pinned.

## error SupplyIsLocked

`setSupplyCap` or `lockSupply` was called after `lockSupply`. The supply cap is
permanently frozen.

## error MintNotStarted

A paid mint was attempted before `mintStart`. Wait for the window to open, or the
owner reschedules it with `setMintWindow`.

## error MintEnded

A paid mint was attempted at or after a non-zero `mintEnd`. The window has closed
(the owner can reopen it with `setMintWindow`).

## error HookRejected

The mint hook's `beforeMint` did not return the required selector, so the hook
rejected the mint.

## error NotMinter

`mintTo` or `mintToId` was called by an address that is not an authorized
extension minter. The owner grants minters with `setMinter`.

## error NotAuthorized

A management function gated `onlyOwnerOrAdmin` was called by neither the owner nor
an admin; `removeAdmin` was called by someone other than the owner or the admin
itself; `notifyMetadataUpdate` was called by neither the renderer nor an
owner/admin; or `burn` was called without burn authority for the id mode.

## error AlreadyAdmin

`addAdmin` was called for an account that is already an admin. Every grant is a
single explicit state change.

## error NotAnAdmin

`removeAdmin` was called for an account that is not currently an admin. A typo or
double-remove fails loudly rather than emitting a misleading event.

## error OwnerRequired

`initialize` was given the zero address as the owner. A collection must have an
owner.

## error PooledSellsViaMinter

A built-in paid path (`mint` or `mintWithReferral`) was called on a Pooled
collection. Pooled collections sell exclusively through their authorized minter.

## error PooledNeedsMintToId

`mintTo` was called on a Pooled collection, where the minter must supply the id.
Use `mintToId`.

## error SequentialAssignsIds

`mintToId` was called on a Sequential collection, where the core assigns ids. Use
`mintTo`.

## error RendererRequired

`initialize` was given the zero address as the default renderer. A collection must
have a fallback renderer.

## error RoyaltyTooHigh

`initialize` or `setRoyalty` was given a royalty above the 50% cap (`5000` bps).





## error NeverMinted

`tokenSeed` was read for an id that was never minted (its seed slot is zero).

## error NothingToWithdraw

`withdraw` was called for an account with a zero owed balance.

## error WithdrawFailed

The ETH transfer inside `withdraw` reverted, for example a recipient that rejects
payment. Nothing is drained; the balance stays claimable.

## error NoStrayETH

`rescueStrayETH` found no ETH above the owed pull-payment balances to sweep.

## error RescueFailed

The ETH transfer inside `rescueStrayETH` reverted.


## error RenounceDisabled

`renounceOwnership` was called. It is permanently disabled to keep the collection
from being orphaned.

## error InvalidInitialization

Standard OpenZeppelin Initializable error: `initialize` was called more than once,
or called on the implementation whose initializers are disabled.

## error NotInitializing

Standard OpenZeppelin Initializable error: an `onlyInitializing` step ran outside
an active initialization.

## error ReentrancyGuardReentrantCall

Standard OpenZeppelin ReentrancyGuard error: a `nonReentrant` function was
re-entered.

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

Standard ERC721 error: a safe transfer or mint targeted a contract that does not
accept ERC721 tokens (bad `onERC721Received`).

## error ERC721InvalidSender

Standard ERC721 error: a transfer named a sender that does not own the token.

## error ERC721NonexistentToken

Standard ERC721 error: the referenced token id does not exist (never minted or
already burned).

## error OwnableInvalidOwner

Standard OpenZeppelin Ownable error: an invalid owner address (for example the
zero address) was supplied.

## error OwnableUnauthorizedAccount

Standard OpenZeppelin Ownable error: an owner-gated function (`addAdmin`,
`transferOwnership`) was called by a non-owner, or `acceptOwnership` by a
non-pending-owner.
