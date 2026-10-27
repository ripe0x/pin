---
title: Surface (v2)
---

# summary

The v2 token primitive: an ERC721 collection deployed per artist as an
EIP-1167 clone through the token [CloneFactory](/docs/surface/contracts/clone-factory),
usually by the [Launcher](/docs/surface/contracts/launcher). Token ids equal
mint order (1, 2, 3, ...) and are never reused. The collection stores one
mint-time seed per token and holds no value; no function is payable.

One minter slot mints. The owner sets the renderer, the minter, the supply
cap, the EIP-2981 royalty and the name. There are no lock bits: renouncing
ownership is the only permanence mechanism, and after it no setter can
succeed. Sales and gates borrow authority by reading `owner()`, so a renounce
freezes them too while payouts keep flowing.

# concepts

### One minter

`minter` is a single address. Only it can call `mintTo`. The
[FixedPriceSale](/docs/surface/contracts/fixed-price-sale) the launcher wires
is the usual minter; a bespoke minter (custom economics) or the owner's own
wallet (an airdrop: `setMinter(owner)`, `mintTo`, `setMinter(sale)`) works the
same way. Two concurrent minters need a small router contract that is the
minter and fans out to its own callers.

### Renounce is the lock

Every setter is `onlyOwner`. `renounceOwnership` sets the owner to zero, after
which the renderer, minter, supply cap, royalty and name are fixed for good.
`transferOwnership` is single-step and rejects the zero address. Once the
owner is zero, any sale or gate that borrows the collection's authority is
frozen as well.

### Seed

Each token's seed is `keccak256(abi.encode(block.prevrandao, collection,
tokenId))`, stored at mint. It excludes the recipient so a minter cannot grind
wallets for a favorable seed, and stays readable after a burn. See the
[injection convention](/docs/surface/reference/injection-convention).

## function mintTo

access: minter-only (`msg.sender == minter`, else `NotMinter`)

Mints `quantity` tokens to `to` with ids `firstTokenId .. firstTokenId +
quantity - 1`, where `firstTokenId` is the lifetime mint count plus one, and
returns `firstTokenId`. Reverts `ZeroQuantity` on zero and `ExceedsCap` when a
set supply cap would be passed. Uses `_mint`, never `_safeMint`: the mint path
makes no external call, so a receiver check is the minter's job. Emits one
`Minted` plus one `Transfer` per token.

## function burn

access: permissionless (holder or approved, else `ERC721InsufficientApproval`)

Burns `tokenId`. The collection owner has no burn authority over a token it
does not hold. Burns never free cap room and the seed stays readable. Emits
`Burned`.

## function setMinter

access: owner-only (`OwnableUnauthorizedAccount`)

Sets the one minter. Zero is allowed and means nobody can mint. Emits
`MinterSet`.

## function setRenderer

access: owner-only (`OwnableUnauthorizedAccount`)

Points `tokenURI` and `contractURI` at a new renderer. Reverts
`RendererRequired` on zero and `RendererNotContract` on an address without
code. Emits `RendererSet`, `BatchMetadataUpdate(0, type(uint256).max)` and
`ContractURIUpdated`.

## function setSupplyCap

access: owner-only (`OwnableUnauthorizedAccount`)

Sets the lifetime mint ceiling. `0` is open. A nonzero cap below the lifetime
mint count reverts `BadSupplyCap`. Emits `SupplyCapSet`.

## function setRoyalty

access: owner-only (`OwnableUnauthorizedAccount`)

Sets the EIP-2981 rate and receiver. Reverts `RoyaltyReceiverRequired` on a
zero receiver and `RoyaltyTooHigh` above 5000 bps. Emits `RoyaltySet`.

## function setName

access: owner-only (`OwnableUnauthorizedAccount`)

Changes `name()` and `symbol()`. The name lives only in the collection;
renderers read it from here. Emits `NameSet`, `BatchMetadataUpdate(0,
type(uint256).max)` and `ContractURIUpdated`.

## function notifyMetadataUpdate

access: owner-only or the renderer (`NotAuthorized`)

Emits `BatchMetadataUpdate(fromTokenId, toTokenId)` for changes the collection
cannot observe (a live work's output, a reveal). The renderer can still call
it after a renounce. No state change.

## function initialize

access: deployer one-shot (`initializer`, else `InvalidInitialization`)

Sets name, symbol, owner, renderer, supply cap, royalty and the required
initial minter. Reverts `OwnableInvalidOwner` on a zero owner,
`RendererRequired` or `RendererNotContract` on a bad renderer,
`RoyaltyReceiverRequired`, `RoyaltyTooHigh`, and `MinterRequired` on a zero
minter. The minter is not checked for code: the launcher passes a sale's
predicted address before that sale exists. Emits `RendererSet`, `RoyaltySet`,
`SupplyCapSet` and `MinterSet`. The implementation itself cannot be
initialized.

## function renounceOwnership

access: owner-only (`OwnableUnauthorizedAccount`)

Sets the owner to zero. Every setter is refused from then on; this is the
collection's only lock. Emits `OwnershipTransferred`.

## function transferOwnership

access: owner-only (`OwnableUnauthorizedAccount`)

Single-step transfer to a new owner. Rejects the zero address
(`OwnableInvalidOwner`). Emits `OwnershipTransferred`.

## function approve

access: permissionless (holder or operator, standard ERC721)

Standard ERC721 single-token approval.

## function setApprovalForAll

access: permissionless (standard ERC721)

Standard ERC721 operator approval.

## function transferFrom

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 transfer. A transfer to the collection's own address reverts
`SelfCustodyRejected`.

## function safeTransferFrom(address,address,uint256)

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 safe transfer, with the same self-custody rule as
`transferFrom`.

## function safeTransferFrom(address,address,uint256,bytes)

access: owner-or-approved-only (standard ERC721 transfer authority, else `ERC721InsufficientApproval`)

Standard ERC721 safe transfer with data, with the same self-custody rule as
`transferFrom`.

## function balanceOf

Standard ERC721 balance.

## function config

`(renderer, minter, supplyCap, royaltyBps, royaltyReceiver, minted)` in one
read, where `minted` is the lifetime mint count. The stable read surface for
renderers; with sequential ids it derives provenance (first is id 1, final is
`minted == supplyCap`).

## function contractURI

Delegates to `IRenderer(renderer).contractURI(collection)`. The collection's
cover and description live in the renderer.

## function getApproved

Standard ERC721 approved address for a token.

## function isApprovedForAll

Standard ERC721 operator check.

## function minter

The one address allowed to call `mintTo`. Zero means nobody can mint.

## function name

The collection name, settable by the owner with `setName`.

## function owner

The current owner, or zero once renounced.

## function ownerOf

Standard ERC721 holder of a token.

## function renderer

The renderer `tokenURI` and `contractURI` delegate to.

## function royaltyBps

The EIP-2981 rate in basis points.

## function royaltyInfo

EIP-2981: the stored receiver and `salePrice * royaltyBps / 10000`, the same
for every token.

## function royaltyReceiver

The EIP-2981 receiver. Never zero.

## function supplyCap

The lifetime mint ceiling; `0` is open.

## function supportsInterface

True for ERC-165, ERC-721, ERC-721 Metadata, ERC-2981 and ERC-4906.

## function symbol

The collection symbol, settable by the owner with `setName`.

## function tokenSeed

The mint-time seed of a token. Reverts `NeverMinted` for an id outside 1 to
the lifetime mint count; still readable after a burn.

## function tokenURI

Delegates to `IRenderer(renderer).tokenURI(collection, tokenId)`. Reverts
`ERC721NonexistentToken` for a token that does not exist.

## function totalSupply

Live tokens: lifetime mints minus burns.

## function version

`2`, the implementation lineage marker.

## event Minted

One per `mintTo` call: the calling minter, the recipient, the first id and the
quantity. Ids run contiguously from `firstTokenId`.

## event Burned

A token was burned.

## event MinterSet

The minter changed, including at initialize.

## event RendererSet

The renderer changed, including at initialize.

## event RoyaltySet

The royalty changed, including at initialize.

## event SupplyCapSet

The supply cap changed, including at initialize.

## event NameSet

The name and symbol changed.

## event BatchMetadataUpdate

ERC-4906 refresh signal for a token id range; `(0, type(uint256).max)` means
every token.

## event ContractURIUpdated

ERC-7572 signal that `contractURI` output changed.

## event OwnershipTransferred

Standard OpenZeppelin Ownable event, emitted on initialize, transfer and
renounce.

## event Initialized

Standard OpenZeppelin Initializable event, emitted once by `initialize`.

## event Transfer

Standard ERC721 transfer, mint and burn event.

## event Approval

Standard ERC721 approval event.

## event ApprovalForAll

Standard ERC721 operator approval event.

## error BadSupplyCap

A nonzero supply cap below the lifetime mint count.

## error ExceedsCap

The mint would pass the supply cap.

## error MinterRequired

`initialize` was given a zero minter.

## error NeverMinted

`tokenSeed` was asked for an id that was never minted.

## error NotAuthorized

`notifyMetadataUpdate` from an address that is neither the renderer nor the
owner.

## error NotMinter

`mintTo` from an address that is not the minter.

## error RendererNotContract

The renderer address has no code.

## error RendererRequired

The renderer address is zero.

## error RoyaltyReceiverRequired

The royalty receiver is zero.

## error RoyaltyTooHigh

The royalty rate is above 5000 bps.

## error SelfCustodyRejected

A mint or transfer to the collection's own address.

## error ZeroQuantity

`mintTo` with a quantity of zero.

## error OwnableInvalidOwner

Standard OpenZeppelin Ownable error: a zero owner at initialize or in
`transferOwnership`.

## error OwnableUnauthorizedAccount

Standard OpenZeppelin Ownable error: an owner-only function called by someone
else, including after a renounce.

## error InvalidInitialization

Standard OpenZeppelin Initializable error: `initialize` on an initialized
clone or on the implementation.

## error NotInitializing

Standard OpenZeppelin Initializable error, unreachable in normal use.

## error ERC721IncorrectOwner

Standard ERC721 error: the `from` address does not hold the token.

## error ERC721InsufficientApproval

Standard ERC721 error: the caller may not move or burn the token.

## error ERC721InvalidApprover

Standard ERC721 error: an invalid approver.

## error ERC721InvalidOperator

Standard ERC721 error: an invalid operator.

## error ERC721InvalidOwner

Standard ERC721 error: an invalid owner, such as zero in `balanceOf`.

## error ERC721InvalidReceiver

Standard ERC721 error: a zero recipient, or a safe transfer to a contract
that does not accept tokens.

## error ERC721InvalidSender

Standard ERC721 error: an invalid sender.

## error ERC721NonexistentToken

Standard ERC721 error: the token does not exist.
