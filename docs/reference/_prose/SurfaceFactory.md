---
title: SurfaceFactory
---

# summary

Deploys one [Surface](/docs/surface/contracts/surface) collection per call as
an EIP-1167 clone of a fixed implementation: no proxy admin, no upgrade path.
`createSurface` clones the sequential token and a
[FixedPriceMinter](/docs/surface/contracts/fixed-price-minter), initializes
both, and grants the minter, in one transaction. `createSurfaceCustom`
(sequential) and `createPooledSurface` (pooled) clone only the token and grant the
minters the caller passes. The factory takes no fee.

An indexer reads one `SurfaceCreated` event per collection, carrying the wired
canonical minter (or zero for the bring-your-own paths), plus the `allSurfaces`
array and the `isSurface` map for enumeration. A new implementation ships behind a
new factory. `deprecate` is a one-way stop for this factory's deploy paths;
`setPaused` is a reversible pause.

# concepts

### One transaction, two clones

`createSurface` clones the token (uninitialized), clones the minter and
initializes it bound to the token with the caller's `SaleConfig`, then initializes
the token with the minter as its sole initial minter. Clone order matters because
the minter's `initialize` requires the collection address to have code, which an
EIP-1167 clone has after `Clones.clone`. The two custom paths skip the minter
clone and initialize the token with the caller's `initialMinters`.

### SaleConfig

The `sale` argument to `createSurface` is the canonical minter's config, minus the
collection address the factory fills in: `price` (wei, used when `priceStrategy` is
unset), `priceStrategy` (0 = fixed price), `mintStart`/`mintEnd` (unix seconds; 0 =
open immediately / open-ended), `payout` (0 = the collection's `owner()` at settle
time), `maxMints` (0 = unlimited), `allowlistRoot` (0 = no allowlist), and
`walletCap` (0 = unlimited). Each is settable on the minter afterward by the
collection's owner or admin.

### Creator listing at init

The `creators` argument sets the collection's listed-creator set during
`initialize`, emitting `CreatorListed` per address. This is the collection's own
storage, not a shared-registry write: the
[Catalog](/docs/catalog/contracts/catalog) is only read. A listed creator
confirms by claiming the collection in the Catalog from their own address, after
which `isConfirmedCreator` reads true. Pass an empty array for solo works; the
owner can change the listing later with `setCreators`.

## function createSurface

access: permissionless (anyone may deploy; control belongs to the `owner` argument)

Deploys a sequential collection wired to a canonical
[FixedPriceMinter](/docs/surface/contracts/fixed-price-minter) clone in one
transaction: clones the token, clones and initializes the minter bound to it with
`sale`, then initializes the token with the minter as its sole initial minter.
Returns both addresses. `owner` is an argument rather than `msg.sender`, so a
deploy helper can create on an artist's behalf; reverts `OwnerRequired` for a zero
owner, `FactoryDeprecated` after deprecation, and `FactoryPaused` while paused.
Token-side init reverts (`RoyaltyTooHigh`, `RendererRequired`) and minter-side init
reverts (`BadMintWindow`, `NotAContract` for a codeless price strategy) surface
through this call. On success, records the collection in `isSurface`/`allSurfaces`
and emits `SurfaceCreated` with the minter address.

```solidity
(address collection, address minter) = factory.createSurface(
    "My Collection",
    "MC",
    artistAddress,
    cfg,     // SurfaceConfig: cap, royalty, renderer, locks
    sale,    // SaleConfig: price, window, payout, gates
    creators
);
```

## function createSurfaceCustom

access: permissionless (control belongs to the `owner` argument)

Deploys a sequential collection with no canonical minter: clones the token and
initializes it with the caller's `initialMinters` (empty for collections that grant
minters later). For projects whose economics live in their own minter contract.
Same creation gates as `createSurface`. Emits `SurfaceCreated` with
`minter = address(0)`; the project's own minter grants appear as `MinterSet` events
on the collection.

## function createPooledSurface

access: permissionless (control belongs to the `owner` argument)

Deploys a pooled collection: the form where the minter chooses each id
(`tokenId == sourceId`) and holds the pool's economics. Grant that minter in
`initialMinters` so the collection deploys wired in one transaction; the pooled
form holds one minter at a time, so more than one entry reverts `TooManyMinters` in
the token's init. There is no canonical-minter form for pooled: a fixed-price
pooled sale has no id-assignment policy a shared minter could apply. Emits
`SurfaceCreated` with `minter = address(0)` and the pooled `idMode`.

## function deprecate

access: deployer-only (`msg.sender` must be the factory deployer, else `NotDeployer`)

One-way stop for new deploys: afterward every create function reverts
`FactoryDeprecated`, and `successor` points to a replacement factory (zero if none
is set). Deployed collections and minters are unaffected; the deployer has no power
over them. Reverts `AlreadyDeprecated` on a second call. Emits `Deprecated`.

## function setPaused

access: deployer-only (`msg.sender` must be the factory deployer, else `NotDeployer`)

Reversible pause on new deploys, separate from `deprecate`. While paused, the
create functions revert `FactoryPaused`. A deprecated factory stays off regardless
of this flag. Deployed collections are unaffected. Emits `PausedSet`.

## function allSurfaces

Every collection address the factory has deployed, in deployment order. For direct
onchain enumeration; indexers typically read `SurfaceCreated`.

## function isSurface

Whether an address is a collection this factory deployed. Cheaper than scanning
`allSurfaces` for a membership check.

## function totalSurfaces

The length of `allSurfaces`.

## function sequentialImplementation

The sequential `Surface` implementation every `createSurface` and
`createSurfaceCustom` clone delegates to. Fixed at construction, no setter.

## function pooledImplementation

The `PooledSurface` implementation every `createPooledSurface` clone delegates to.
Fixed at construction, no setter.

## function minterImplementation

The `FixedPriceMinter` implementation `createSurface` clones. Fixed at
construction, no setter. Not used by `createSurfaceCustom` or
`createPooledSurface`, which take minters from the caller.

## function defaultRenderer

The renderer a collection uses when its config names none. May be zero: with no
factory default, a collection that names no renderer reverts `RendererRequired` at
creation. A collection's owner can change its renderer after deploy; this is only
the value new collections start with.

## function catalog

The Catalog singleton wired into every collection this factory creates, read to
confirm creators (`isConfirmedCreator`). The Catalog is only read. Zero disables
confirmation: a collection wired with no Catalog can list creators but confirms
none.

```bash
cast call {{addr:surfaceFactory}} "catalog()(address)" \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function deployer

The address that deployed the factory: the only address that may `deprecate` or
`setPaused`. It has no power over deployed collections or minters.

## function deprecated

True after the factory has been deprecated (new deploys revert).

## function paused

True while new deploys are paused (see `setPaused`). Reversible, unlike
`deprecated`.

## function successor

The replacement factory set at deprecation, or zero. Informational.

## event SurfaceCreated

Emitted once per successful create call, with `owner` and `collection` indexed.
`minter` is the canonical `FixedPriceMinter` clone `createSurface` wired, or
`address(0)` for the two bring-your-own paths, so this event is the
collection-to-minter binding an indexer reads. `idMode` records the form. It fires
in the transaction that initializes the collection, so an indexer reading it can
treat the collection and any wired minter as fully configured.

## event Deprecated

Emitted once when the deployer deprecates the factory, carrying the successor
address (zero if none). Indexed by `successor`.

## event PausedSet

Emitted when the deployer pauses or resumes new deploys, with the new `paused`
state.

## error FactoryDeprecated

A create function was called after deprecation. Deploy through the successor
factory (`successor()`).

## error FactoryPaused

A create function was called while the factory is paused (see `setPaused`).

## error NotDeployer

`deprecate` or `setPaused` was called by an address other than the factory
deployer.

## error AlreadyDeprecated

`deprecate` was called on an already-deprecated factory.

## error OwnerRequired

A create function was given the zero address as the collection `owner`.

## error NotAContract

The constructor was given an address with no code where a contract is required: an
implementation (sequential, pooled, or minter), a nonzero default renderer, or a
nonzero Catalog.

## error FailedDeployment

Inherited from OpenZeppelin `Clones`. The EIP-1167 clone deployment failed at the
`CREATE` opcode. Not expected against a valid implementation.

## error InsufficientBalance

Inherited from OpenZeppelin `Clones`. Raised by the value-forwarding clone variants
when the factory's ETH balance is below the value being forwarded. The create
functions do not forward value, so this is not reachable through the factory's
public surface.
