---
title: SurfaceFactory
---

# summary

SurfaceFactory deploys one [Surface](/docs/collections/contracts/surface)
collection per call as an immutable EIP-1167 clone of a fixed
implementation: no proxy admin, no upgrade path, what deploys is what runs.
`createSurface` is the common priced-drop path: it clones the sequential
token and a [FixedPriceMinter](/docs/collections/contracts/fixed-price-minter)
together and wires them in one transaction, so the collection comes into
existence already owned, configured, and selling. `createSurfaceCustom`
(sequential) and `createPooledSurface` (pooled) clone only the token and
grant whatever minters the caller passes, for projects that bring their own
minter contract. The factory takes no fee.

The factory is also the single fixed contract an indexer watches for
discovery: one `SurfaceCreated` event per collection, carrying the wired
canonical minter (or zero for bring-your-own), plus an `allSurfaces` array
and an `isSurface` membership map for onchain enumeration. Core evolution
happens by deploying new implementations and a new factory alongside them,
never by changing collections that already exist; `deprecate` is the one-way
end-of-life for this factory's own deploy paths, and `setPaused` is the
reversible circuit breaker.

# concepts

### One transaction, two clones

`createSurface` clones the token (uninitialized), clones the minter and
initializes it bound to the token with the caller's `SaleConfig`, then
initializes the token with the minter as its sole initial minter. Clone
order matters because the minter's `initialize` requires the collection
address to have code, which an EIP-1167 clone has immediately after
`Clones.clone`. There is no window between deploy and configuration for
anyone to front-run, and no second transaction to forget. The two custom
paths skip the minter clone and initialize the token with the caller's
`initialMinters` instead.

### SaleConfig

The `sale` argument to `createSurface` is the canonical minter's full
config, minus the collection address the factory fills in: `price` (wei,
used when `priceStrategy` is unset), `priceStrategy` (0 = fixed price),
`mintStart`/`mintEnd` (unix seconds; 0 = open immediately / open-ended),
`payout` (0 = the collection's live `owner()` at settle time), `maxMints`
(0 = unlimited), `allowlistRoot` (0 = open), and `walletCap`
(0 = unlimited). All of it stays live-settable on the minter afterward by
the collection's owner or admin.

### Creator listing at init

The `creators` argument seeds the collection's own listed-creator set (the
owner's side of attribution) during `initialize`, emitting `CreatorListed`
per address. This is the collection's own storage, not a write to any shared
registry: the Catalog is only ever read. A listed creator completes the
two-sided handshake by claiming the collection in the Catalog from their own
address, after which `isConfirmedCreator` reads true. Pass an empty array
for solo works; the owner can list or unlist later with `setCreators`.

## function createSurface

access: permissionless (anyone may deploy; ongoing control belongs to the `owner` argument)

Deploys a sequential collection wired to a canonical
[FixedPriceMinter](/docs/collections/contracts/fixed-price-minter) clone in
one transaction: clones the token, clones and initializes the minter bound
to it with `sale`, then initializes the token with the minter as its sole
initial minter. Returns both addresses. `owner` is explicit rather than
`msg.sender`, so a deploy helper can create on an artist's behalf; reverts
`OwnerRequired` for a zero owner, `FactoryDeprecated` after deprecation, and
`FactoryPaused` while paused. Token-side init reverts (`RoyaltyTooHigh`,
`RendererRequired`) and minter-side init reverts (`BadMintWindow`,
`NotAContract` for a codeless price strategy) surface through this call. On
success, records the collection in `isSurface`/`allSurfaces` and emits
`SurfaceCreated` with the minter address.

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

access: permissionless (ongoing control belongs to the `owner` argument)

Deploys a sequential collection with no canonical minter: clones the token
and initializes it with the caller's `initialMinters` (empty for collections
that grant minters in a later transaction). For projects whose economics
live in their own minter contract. Same creation gates as `createSurface`.
Emits `SurfaceCreated` with `minter = address(0)`; the project's own minter
grants show up as `MinterSet` events on the collection.

## function createPooledSurface

access: permissionless (ongoing control belongs to the `owner` argument)

Deploys a pooled collection: the form where an authorized minter chooses
every id (`tokenId == sourceId`) and owns the pool's economics. Grant that
minter in `initialMinters` so the collection deploys fully wired in one
transaction; the pooled form holds one minter at a time, so more than one
entry reverts `TooManyMinters` in the token's init. There is no
canonical-minter form for pooled, since a fixed-price pooled sale has no
general id-assignment policy a shared minter could use. Emits
`SurfaceCreated` with `minter = address(0)` and the pooled `idMode`.

## function deprecate

access: deployer-only (`msg.sender` must be the factory deployer, else `NotDeployer`)

One-way stop for new deploys, for a bug discovered in an implementation:
afterward every create function reverts `FactoryDeprecated`, and `successor`
points integrators at the replacement factory (zero if none exists yet).
Deployed collections and minters are immutable and unaffected; the deployer
holds no power over them. Reverts `AlreadyDeprecated` on a second call.
Emits `Deprecated`.

## function setPaused

access: deployer-only (`msg.sender` must be the factory deployer, else `NotDeployer`)

Reversible pause on new deploys, distinct from `deprecate`: a temporary off
switch (incident, maintenance) the deployer can toggle back. While paused,
the create functions revert `FactoryPaused`. A deprecated factory stays
permanently off regardless of this flag. Deployed collections are never
affected. Emits `PausedSet`.

## function allSurfaces

Every collection address the factory has deployed, in deployment order.
Indexers typically watch `SurfaceCreated` rather than paging this array, but
it is available for direct onchain enumeration.

## function isSurface

Whether an address is a collection this factory deployed. Cheaper than
scanning `allSurfaces` for a membership check.

## function totalSurfaces

The length of `allSurfaces`: the total number of collections this factory
has deployed.

## function sequentialImplementation

The sequential `Surface` implementation every `createSurface` and
`createSurfaceCustom` clone points at via `DELEGATECALL`. Fixed at factory
construction with no setter, so every sequential collection runs the same
core logic.

## function pooledImplementation

The `PooledSurface` implementation every `createPooledSurface` clone points
at. Fixed at construction, no setter.

## function minterImplementation

The `FixedPriceMinter` implementation `createSurface` clones as the
canonical minter. Fixed at construction, no setter. Not used by
`createSurfaceCustom` or `createPooledSurface`, which take their minters
from the caller.

## function defaultRenderer

The renderer assigned to a collection whose config names none of its own.
May be the zero address: with no factory default, a collection that sets no
renderer reverts `RendererRequired` at creation, so every collection must
then supply its own. A collection's owner can still swap its renderer slot
after deploy; this is only the value new collections start with.

## function catalog

The Catalog singleton wired into every collection this factory creates,
which each collection reads to confirm creators (`isConfirmedCreator`). The
Catalog is only ever read, never written. The zero address disables
confirmation: a collection wired with no Catalog can still list creators but
never marks any of them confirmed.

```bash
cast call {{addr:surfaceFactory}} "catalog()(address)" \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function deployer

The address that deployed the factory: the only address that may `deprecate`
or `setPaused`, and its only privilege. It has no power over deployed
collections or minters.

## function deprecated

True once the factory has been permanently deprecated (new deploys revert).

## function paused

True while new deploys are paused (see `setPaused`). Reversible, unlike
`deprecated`.

## function successor

The replacement factory named at deprecation, or zero. Informational: a
discovery pointer for integrators walking factory generations.

## event SurfaceCreated

Emitted once per successful create call, with `owner` and `collection`
indexed. `minter` is the canonical `FixedPriceMinter` clone `createSurface`
wired, or `address(0)` for the two bring-your-own paths; this event is the
collection-to-minter binding an indexer reads, since there is no storage
mapping for it. `idMode` records the form. It fires in the same transaction
that initializes the collection, so an indexer following it can assume the
collection (and any wired minter) is already fully configured.

## event Deprecated

Emitted once when the deployer permanently deprecates the factory, carrying
the successor address (zero if none named). Indexed by `successor`.

## event PausedSet

Emitted when the deployer pauses or resumes new deploys, carrying the new
`paused` state.

## error FactoryDeprecated

A create function was called after deprecation. Deploy through the successor
factory instead (`successor()`).

## error FactoryPaused

A create function was called while the factory is paused (see `setPaused`).
Retry once the deployer resumes it.

## error NotDeployer

`deprecate` or `setPaused` was called by an address other than the factory
deployer.

## error AlreadyDeprecated

`deprecate` was called on an already-deprecated factory.

## error OwnerRequired

A create function was given the zero address as the collection `owner`. A
collection must have an owner.

## error NotAContract

The factory constructor was given an address with no code where a contract
is required: an implementation (sequential, pooled, or minter), a nonzero
default renderer, or a nonzero Catalog. Guards against wiring a factory
whose every clone would inherit a dead dependency.

## error FailedDeployment

Inherited from OpenZeppelin `Clones`. The EIP-1167 clone deployment failed
at the `CREATE` opcode level. Not expected in normal operation against a
valid implementation.

## error InsufficientBalance

Inherited from OpenZeppelin `Clones`. Raised by the value-forwarding clone
variants when the factory's ETH balance is less than the value being
forwarded. The create functions do not forward value, so this is not
reachable through the factory's public surface.
