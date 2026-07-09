---
title: SovereignCollection
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
protocol Surface Share of 10% (`SURFACE_SHARE_BPS = 1000`) is paid out of that
price to whoever hosts the mint, and folds back to the artist on a direct mint.

Each minted token carries its own identity: a per-token Mint Mark (provenance
stamped at mint), mint-time entropy read via `tokenSeed`, and an optional Token
Path forward pointer. The collection also carries a directed Release Graph of
typed edges to other works. The [id mode](/docs/collections/concepts/id-modes) is fixed at
init: Sequential (the core assigns ids, never reused after burn) or Pooled (an
authorized minter supplies ids, and a burned id can be minted again as a fresh
instance). Metadata and the work config can each be locked one-way for
permanence. Payment accrues as pull-payment balances claimed through `withdraw`;
no external transfer happens during a mint, so a reverting recipient can never
brick minting.

# concepts

### The four slots

The core delegates all variable behavior to four slots the owner can point at
external contracts:

- `renderer` supplies `tokenURI` and `contractURI`; unset falls back to
  `defaultRenderer`, which is set at init and never zero
- `priceStrategy` supplies the resolved price on the built-in paid path; unset
  means the stored fixed `price` applies
- `mintHook` runs `beforeMint` (which can reject) and `afterMint` on every mint
  path, built-in and extension alike
- extension minters are addresses granted via `setMinter` that may call `mintTo`
  or `mintToAt`, carrying their own economics

See [the four-slots concept](/docs/collections/concepts/four-slots) and the
[minter guide](/docs/collections/guides/write-a-minter).

### Id modes

The id mode is fixed at init and governs how ids are assigned and who can mint
and burn. See [id modes](/docs/collections/concepts/id-modes).

- Sequential: the core assigns `nextId++` (first id is 1). The built-in paid
  paths (`mint`, `mintWithRewards`) work only here. `mintTo` assigns the next id.
  The supply cap bounds mints ever, so a burn never frees a new slot. `burn` is
  the standard owner-or-approved burn
- Pooled: an authorized extension minter supplies every id through `mintToAt`
  (`tokenId == sourceId` forms, id 0 is legal). The built-in paid paths revert.
  A burned id can be minted again as a NEW instance with a fresh Mint Mark and
  fresh entropy; the prior instance's history persists in events. The supply cap
  bounds live supply. `burn` is minter-only

### Mint Marks and entropy

Every mint stamps a per-token Mint Mark (mint block, global mint index, lifecycle
status at mint, and the surface) and one `bytes32` of entropy derived from
`prevrandao`, the collection address, the token id, the recipient, and the mint
index. Read the Mint Mark with `mintMarkOf` and the entropy with `tokenSeed`.
Entropy lives in the core because it can never be retrofitted: randomness only
exists at mint time. It is `prevrandao`-derived, which is acceptable
unpredictability for art but not for lotteries. See
[mint marks and entropy](/docs/collections/concepts/mint-marks-and-entropy).

### Release Graph and Token Path

The collection carries a directed, typed, append-only Release Graph: the owner
adds outbound edges with `addEdge`, reads them with `edges`, and acknowledges
inbound edges another collection claims with `acknowledgeEdge`, so a reader can
verify a relationship is mutual with no central registry. Separately, each token
has a forward pointer (its Token Path): the owner sets a per-token path with
`setPath` or a collection-wide fallback with `setDefaultPath`, and `pathOf`
resolves per-token first, else the default. The Token Path is a pointer layer
only: the contract stores and emits it, it does not execute it.

### Permanence

Two one-way locks make the art permanent while the contract itself is already
immutable from deploy. `freezeMetadata` renounces the ability to change the
renderer or per-token artwork. `lockWork` permanently freezes the work config
(the algorithm the renderer runs). `isPermanent` is true once both are set.

### Live reads

```bash
# Live supply (minted minus burned)
cast call <COLLECTION_ADDRESS> "totalSupply()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# The fixed surface share in bps (1000 = 10%)
cast call <COLLECTION_ADDRESS> "surfaceShareBps()(uint16)" \
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

The honest default mint path. Passes `surface = address(0)` so no surface share
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

## function mintWithRewards

access: permissionless (payable; no caller gate, guarded by window/cap/payment checks)

Same paid path as `mint`, but credits a `surface` its 10% share of the price;
`surface == address(0)` folds the share back to the artist. PND's frontend passes
PND's address, a self-hosted page passes the artist's address. `hookData` is
forwarded to both the mint hook and the price strategy. Sequential mode only:
reverts `PooledSellsViaMinter` in pooled mode. Same window, cap, payment, and
hook behavior and reverts as `mint`. Emits `SurfacePaid` for a non-zero surface
cut alongside `Minted`.

## function mintTo

access: minter-only (`msg.sender` must be an authorized extension minter, else `NotMinter`)

The extension mint path for Sequential mode. Non-payable: the calling minter
carries all value handling and honors the surface share by convention. The core
assigns the next id and returns it. Reverts `PooledNeedsMintToAt` in pooled mode.
The cap and id assignment are enforced exactly as on the paid path, but the sale
window is not: an extension minter owns its own schedule, and the artist's lever
is revoking the grant with `setMinter`. Hooks still run (`HookRejected` on
rejection); `ExceedsCap` on a cap crossing. Emits `Minted` with quantity 1.

## function mintToAt

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

## function setRenderer

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Points the renderer slot at a new renderer, or zero to fall back to
`defaultRenderer`. Reverts `MetadataIsFrozen` once `freezeMetadata` has run.
Emits `RendererSet`.

## function setMintHook

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Points the mint hook slot at a new hook, or zero for none. The hook runs on every
mint path. Emits `MintHookSet`.

## function setPriceStrategy

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Points the price strategy slot at a new strategy, or zero to use the stored fixed
`price`. The strategy is read as a view on the built-in paid path. Emits
`PriceStrategySet`.

## function setMinter

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Grants (`allowed = true`) or revokes an extension minter that may call `mintTo`
or `mintToAt`. Reverts `ZeroMinter` for the zero address. Authorizing a minter is
the artist's visible onchain choice, and revoking it is the artist's lever over
that minter's schedule and behavior. Emits `MinterSet`.

## function setClosing

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Flags the collection as closing soon, which stamps `Closing` into the lifecycle
status (and thus into new Mint Marks) while the window and cap still allow mints.
Emits `ClosingSet`.

## function setPayoutAddress

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Sets where the artist's share accrues for FUTURE mints; zero falls back to
`owner()`. Past accruals remain claimable at the old address. Emits
`PayoutAddressSet`.

## function setTokenArtwork

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Sets a per-token artwork CID override for a minted token. Reverts
`MetadataIsFrozen` after `freezeMetadata`, and `NotMinted` for an id that was
never minted. Emits `TokenArtworkSet`.

## function setTokenArtworkBatch

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Sets per-token artwork CIDs for many tokens at once. Reverts `MetadataIsFrozen`
after `freezeMetadata`, `LengthMismatch` when the id and CID arrays differ in
length, and `NotMinted` for any id that was never minted. Emits `TokenArtworkSet`
once per id.

## function setWork

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Replaces the work config (script refs, dependencies, render spec) the renderer
runs. The artist may refine it until `lockWork` is called; reverts
`WorkAlreadyLocked` after that. Emits `WorkSet` carrying the new `codeHash`.

## function lockWork

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

One-way: permanently locks the work config so `setWork` can never change it again.
Reverts `WorkAlreadyLocked` if already locked. Together with `freezeMetadata` this
is the art-permanence guarantee. Emits `WorkLocked`.

## function freezeMetadata

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

One-way: renounces the ability to change the renderer or per-token artwork, giving
collectors a presentation-permanence guarantee. Reverts `AlreadyFrozen` if already
frozen. Emits `MetadataFrozen`.

## function addEdge

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Appends an outbound Release Graph edge of the given type to a target node. The
graph is append-only; edges are read with `edges`. Emits `EdgeAdded`.

## function acknowledgeEdge

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Acknowledges (`ack = true`) or revokes an inbound edge another node claims toward
this collection, so a reader can verify the relationship is mutual with no central
registry. Idempotent. Emits `EdgeAcknowledged`.

## function setDefaultPath

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Sets the collection-wide fallback Token Path used by `pathOf` for any token
without its own path. Emits `DefaultPathSet`.

## function setPath

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Sets a per-token Token Path forward pointer, which `pathOf` prefers over the
default. Reverts `NotMinted` for an id that was never minted. Emits `PathSet`.

## function withdraw

access: permissionless (no caller gate; funds only ever go to the owed `account`)

Sends the pull-payment balance owed to `account` to `account`. Anyone may trigger
it, but funds only ever reach the owed address. Reverts `ZeroAccount` for the zero
address, `NothingToWithdraw` when nothing is owed, and `WithdrawFailed` if the
transfer reverts. Emits `Withdrawn`.

## function rescueStrayETH

access: owner-only (`onlyOwner`, else `OwnableUnauthorizedAccount`)

Sweeps only ETH that is not owed to any payee (for example ETH force-fed via
selfdestruct) to `to`. Pull-payment balances are untouchable: only the surplus
above the running total of owed balances is ever sent. Reverts `ZeroAccount` for
the zero address, `NoStrayETH` when there is no surplus, and `RescueFailed` if the
transfer reverts. Emits `StrayETHRescued`.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`)

Sets up the clone exactly once: name, symbol, owner, collection config, work
config, default renderer, initial extension minters, and an optional Attribution
roster write. Reverts `OwnerRequired` for a zero owner, `RendererRequired` for a
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

## function SURFACE_SHARE_BPS

The fixed protocol surface share as a compile-time constant: 1000 bps, i.e. 10%.
Not artist-set. `surfaceShareBps` returns the same value.

## function surfaceShareBps

Returns the fixed protocol surface share in bps (1000 = 10%), the same value as
the `SURFACE_SHARE_BPS` constant.

## function config

Returns the stored `CollectionConfig`, the current lifecycle `status` (Open,
Closing, or Closed), and `minted` (mints ever, not live supply).

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

The mint-time entropy for a token, stamped in the mint transaction. Reverts
`NeverMinted` for an id that has no mint record. For a pooled re-mint this is the
current instance's fresh seed.

## function mintMarkOf

The derived Mint Mark of a token's current (or most recent) instance: mint index,
mint block, lifecycle status at mint, surface, and the `isFirst` and `isFinal`
flags. Readable for a burned id until a pooled re-mint overwrites it. Reverts
`NeverMinted` if the id has no mint record.

## function artwork

The collection's shared cover artwork URI, from the collection config. Per-token
overrides are read with `tokenArtwork`.

## function tokenArtwork

The per-token artwork CID override for a token, or the empty string when none is
set.

## function workConfig

The stored work config (script refs, dependencies, render spec) the renderer runs.
Empty for works whose renderer contract is itself the algorithm.

## function isWorkLocked

True once `lockWork` has permanently frozen the work config.

## function isMetadataFrozen

True once `freezeMetadata` has renounced renderer and per-token artwork changes.

## function isPermanent

True when metadata is frozen and the work is locked: the art-permanence guarantee.
The contract itself is immutable from deploy regardless.

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
`mintToAt`.

## function edges

The full array of outbound Release Graph edges, in the order they were added.

## function isEdgeAcknowledged

True if this collection has acknowledged an inbound edge of the given type claimed
by the given source node.

## function pathOf

The token's forward pointer (its Token Path): the per-token path if one is set,
else the collection-wide default path.

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

Standard ERC165 support check. Returns true for ERC721, ERC165, and EIP-2981
(`0x2a55205a`).

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

Standard OpenZeppelin Ownable current owner: the artist address that controls the
config, slot, graph, and withdrawal surface.

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

One event per mint call. Built-in paths cover `[firstTokenId, firstTokenId +
quantity - 1]`; extension mints emit quantity 1 with `firstTokenId` the minted id.
Indexed by `to` and `surface`. Carries `firstMintIndex` (the global mint order of
the call's first token; token k's mint index is `firstMintIndex + k`), the mint
block, and the lifecycle status at mint, so indexers never need a per-token
`mintMarkOf` read, including for pooled re-mints where order is not derivable from
ids.

## event Burned

Emitted when a token is burned. Indexed by `tokenId`. A pooled id may later be
re-minted, at which point a new `Minted` covers the fresh instance.

## event SurfacePaid

Emitted when a non-zero surface cut is credited on a paid mint. Indexed by
`surface`, with the credited `amount` in wei.

## event CollectionConfigured

Emitted once at init with the collection's kind, id mode, price, supply cap, mint
window, and cover artwork URI. Indexers read this to record a new collection's
terms.

## event ClosingSet

Emitted when the owner toggles the closing flag with `setClosing`.

## event RendererSet

Emitted when the renderer slot changes. Indexed by `renderer`.

## event MintHookSet

Emitted when the mint hook slot changes. Indexed by `hook`.

## event PriceStrategySet

Emitted when the price strategy slot changes. Indexed by `strategy`.

## event MinterSet

Emitted when an extension minter is granted or revoked, and once per initial
minter at init. Indexed by `minter`, with the `allowed` flag.

## event TokenArtworkSet

Emitted when a per-token artwork CID is set, one event per token id (including
each id in a batch). Indexed by `tokenId`.

## event WorkSet

Emitted when the work config is replaced, carrying the new `codeHash`.

## event WorkLocked

Emitted once when `lockWork` permanently locks the work config.

## event MetadataFrozen

Emitted once when `freezeMetadata` renounces renderer and per-token artwork
changes.

## event PayoutAddressSet

Emitted when the artist payout address changes. Indexed by `payoutAddress`. Only
affects future accruals.

## event Withdrawn

Emitted when a pull-payment balance is paid out. Indexed by `account`, with the
`amount` in wei.

## event StrayETHRescued

Emitted when the owner sweeps stray ETH not owed to any payee. Indexed by `to`,
with the swept `amount` in wei.

## event EdgeAdded

Emitted when the owner appends an outbound Release Graph edge. Indexed by
`edgeType`, with the target node.

## event EdgeAcknowledged

Emitted when the owner acknowledges or revokes an inbound edge. Indexed by
`edgeType`, with the source node and the `ack` flag.

## event DefaultPathSet

Emitted when the collection-wide default Token Path is set. Indexed by `pathType`,
with the target node and aux data.

## event PathSet

Emitted when a per-token Token Path is set. Indexed by `tokenId` and `pathType`,
with the target node and aux data.

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

`withdraw` or `rescueStrayETH` was passed the zero address as the destination.
Supply a real account.

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

`initialize` was given a non-zero `mintEnd` that is not strictly after
`mintStart`. Use `mintEnd == 0` for open-ended or an end after the start.

## error MintNotStarted

A mint was attempted before `mintStart`. Wait for the window to open.

## error MintEnded

A mint was attempted at or after a non-zero `mintEnd`. The window has closed.

## error HookRejected

The mint hook's `beforeMint` did not return the required selector, so the hook
rejected the mint.

## error NotMinter

`mintTo` or `mintToAt` was called by an address that is not an authorized
extension minter. The owner grants minters with `setMinter`.

## error NotAuthorized

`burn` was called without authority: in Sequential mode by a non-owner,
non-approved caller, or in Pooled mode by a non-minter.

## error OwnerRequired

`initialize` was given the zero address as the owner. A collection must have an
owner.

## error PooledSellsViaMinter

A built-in paid path (`mint` or `mintWithRewards`) was called on a Pooled
collection. Pooled collections sell exclusively through their authorized minter.

## error PooledNeedsMintToAt

`mintTo` was called on a Pooled collection, where the minter must supply the id.
Use `mintToAt`.

## error SequentialAssignsIds

`mintToAt` was called on a Sequential collection, where the core assigns ids. Use
`mintTo`.

## error RendererRequired

`initialize` was given the zero address as the default renderer. A collection must
have a fallback renderer.

## error RoyaltyTooHigh

`initialize` was given a royalty above the 50% cap (`5000` bps).

## error MetadataIsFrozen

`setRenderer`, `setTokenArtwork`, or `setTokenArtworkBatch` was called after
`freezeMetadata`. Metadata changes are permanently disabled.

## error AlreadyFrozen

`freezeMetadata` was called when metadata is already frozen.

## error WorkAlreadyLocked

`setWork` was called after `lockWork`, or `lockWork` was called when the work is
already locked. The work config is permanently frozen.

## error NotMinted

A per-token setter (`setTokenArtwork`, `setTokenArtworkBatch`, or `setPath`)
referenced an id that was never minted.

## error NeverMinted

`tokenSeed` or `mintMarkOf` was read for an id that has no mint record.

## error NothingToWithdraw

`withdraw` was called for an account with a zero owed balance.

## error WithdrawFailed

The ETH transfer inside `withdraw` reverted, for example a recipient that rejects
payment. Nothing is drained; the balance stays claimable.

## error NoStrayETH

`rescueStrayETH` found no ETH above the owed pull-payment balances to sweep.

## error RescueFailed

The ETH transfer inside `rescueStrayETH` reverted.

## error LengthMismatch

`setTokenArtworkBatch` was given id and CID arrays of different lengths.

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

Standard OpenZeppelin Ownable error: an owner-gated function was called by a
non-owner. Guards every `onlyOwner` setter on this contract.
