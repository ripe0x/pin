---
title: SurfaceFactory
---

# summary

SurfaceFactory deploys one [Surface](/docs/collections/contracts/surface)
per work as an immutable EIP-1167 clone of a fixed implementation: no proxy
admin, no upgrade path, what deploys is what runs. `createSurface` clones
and initializes the collection in a single transaction, wiring in the shared
default renderer and, optionally, an opening [Catalog](/docs/collections/contracts/catalog)
roster. There is no protocol fee in the factory; the Surface Share is a fixed
constant inside the core, paid to whoever hosts the mint.

The factory is also the single fixed contract an indexer watches for
discovery: one `SurfaceCreated` event per collection, plus an
`allSurfaces` array and an `isSurface` membership map for cheap
onchain enumeration. Core evolution happens by deploying a new
implementation and a new factory alongside it, never by changing collections
that already exist.

# concepts

### Clone-and-initialize is one transaction

`createSurface` clones `implementation` with OpenZeppelin `Clones.clone`
and calls `initialize` on the fresh clone in the same call. The collection
comes into existence already owned, priced, windowed, and (optionally)
minter-wired and attributed; there is no window between deploy and
configuration for anyone to front-run. See
[the four slots](/docs/collections/concepts/four-slots) for what `SurfaceConfig`
configures, and the
[deploy a collection guide](/docs/collections/guides/deploy-a-collection) for a worked
example of the call.

### Creator listing at init

The `creators` argument seeds the collection's own listed-creator set (the
owner's side of attribution) during `initialize` — `isListedCreator[c]` is set
for each, emitting `CreatorListed`. This is the collection's own storage, not a
write to any shared registry: the [Catalog](/docs/collections/contracts/catalog)
is only ever *read*. A listed creator completes the two-sided handshake by
claiming the collection in their own Catalog (`addContract`, from their own
address), after which `isConfirmedCreator` reads true. If `creators` is empty
the collection starts with no listing; the owner can add or remove listings
later with `setCreators`.

## function createSurface

access: permissionless (anyone may deploy; ongoing control over the result
belongs to the `owner` argument, which becomes the collection's `Ownable`
owner)

Deploys an EIP-1167 clone of `sequentialImplementation` — the **sequential**
form, where the contract assigns ids (1, 2, 3…) and collectors buy through the
built-in paid paths — and initializes it atomically with the given name,
symbol, owner, `SurfaceConfig`, extension minters, and creator listing.
Reverts `OwnerRequired` if `owner` is the zero address.

`initialMinters` grants extension-minter status at init, so pooled or backed
forms that sell exclusively through a custom minter deploy fully wired in
one transaction; leave it empty for collections that sell through the
core's built-in fixed-price path. `creators` is the owner's opening creator
listing; each listed creator still needs to claim the collection in their own
[Catalog](/docs/collections/contracts/catalog) for the credit to read as
mutually confirmed.

On success, marks the new address in `isSurface`, appends it to
`allSurfaces`, and emits `SurfaceCreated`.

```solidity
address collection = factory.createSurface(
    "My Collection",
    "MC",
    artistAddress,
    cfg,
    initialMinters,
    creators
);
```

## function createPooledSurface

access: permissionless (ongoing control belongs to the `owner` argument)

The same call for the **pooled** form: deploys an EIP-1167 clone of
`pooledImplementation`, where an authorized minter chooses every id
(`tokenId == sourceId`) and owns the pool's economics. Grant that minter in
`initialMinters` so the work deploys fully wired in one transaction. Same
signature, same init, same `SurfaceCreated` event (stamped with the pooled
`idMode`) as `createSurface`; only the implementation cloned differs.

## function allSurfaces

Every collection address the factory has deployed, in deployment order.
Indexers typically watch `SurfaceCreated` rather than paging this array,
but it's available for direct onchain enumeration.

## function catalog

The [Catalog](/docs/collections/contracts/catalog) singleton wired into every
collection created by this factory, which each collection reads to confirm
creators (`isConfirmedCreator`). The Catalog is only ever read, never written.
The zero address disables confirmation: a collection wired with no Catalog can
still list creators, but never marks any of them confirmed.

```bash
cast call {{addr:surfaceFactory}} "catalog()(address)" \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function defaultRenderer

The canonical built-in renderer address wired into every collection this
factory creates. A collection's owner can still swap its own renderer slot
after deploy; this is only the value new collections start with.

## function sequentialImplementation

The sequential `Surface` implementation every `createSurface` clone points
at via `DELEGATECALL`. Fixed at factory construction; there is no setter, so
every sequential collection shares the exact same core logic.

## function pooledImplementation

The `PooledSurface` implementation every `createPooledSurface` clone points
at. Fixed at construction, no setter — the pooled form's counterpart to
`sequentialImplementation`.

## function isSurface

Whether `address` is a collection this factory deployed. Cheaper than
scanning `allSurfaces` when a caller only needs a membership check.

## function totalSurfaces

The length of `allSurfaces`: the total number of collections this factory
has deployed.

## event SurfaceCreated

Emitted once per successful `createSurface` call, with `owner` and
`collection` both indexed. This is the single event an indexer needs to
discover every collection this factory has produced; it fires in the same
transaction that initializes the collection, so any indexer following it can
assume the collection is already fully configured.

## error FailedDeployment

Inherited from OpenZeppelin `Clones`. The EIP-1167 clone deployment failed
at the `CREATE` opcode level. Not expected in normal operation against a
valid `implementation`.

## error InsufficientBalance

Inherited from OpenZeppelin `Clones`. Raised by the value-forwarding clone
variants when the factory's own ETH balance is less than the value being
forwarded to the new clone. `createSurface` does not forward value, so
this is not reachable through the factory's public surface today.

## error NotAContract

The factory constructor was given an implementation, pooled implementation, or
default renderer address with no code. Guards against wiring a factory to an
address that cannot be a valid clone target or renderer.

## error OwnerRequired

`createSurface` or `createPooledSurface` was given the zero address as the
collection `owner`. A collection must have an owner.

## function deprecate

access: deployer-only (`msg.sender` must be the factory deployer, else `NotDeployer`)

One-way kill switch for NEW deploys, for a post-deploy bug discovered in the
implementation: after deprecation `createSurface` reverts
`FactoryDeprecated`, and `successor` points integrators at the replacement
factory (zero if none exists yet). Deployed collections are immutable and
completely unaffected — the deployer holds zero power over them; this switch
only stops the buggy implementation from being cloned again. Reverts
`AlreadyDeprecated` on a second call. Emits `Deprecated`.

## function setPaused

access: deployer-only (`msg.sender` must be the factory deployer, else `NotDeployer`)

Reversible off/on switch for NEW deploys — the everyday circuit breaker
(incident, maintenance), distinct from the permanent one-way `deprecate`. While
paused, `createSurface`/`createPooledSurface` revert `FactoryPaused`; flip it
back and deploys resume. Deployed collections are never affected. A deprecated
factory stays permanently off regardless of this flag. Emits `PausedSet`.

## function paused

True while new deploys are paused (see `setPaused`). Reversible, unlike
`deprecated`.

## function deployer

The address that deployed the factory: the only address that may `deprecate` or
`setPaused`, and its only privilege.

## function deprecated

True once the factory has been permanently deprecated (new deploys revert).

## function successor

The replacement factory named at deprecation, or zero. Informational — a
discovery pointer for integrators walking factory generations.

## event Deprecated

Emitted once when the deployer permanently deprecates the factory, carrying
the successor address (zero if none named).

## event PausedSet

Emitted when the deployer pauses or resumes new deploys, carrying the new
`paused` state.

## error AlreadyDeprecated

`deprecate` was called on an already-deprecated factory.

## error FactoryDeprecated

`createSurface` was called after deprecation. Deploy through the successor
factory instead (`successor()`).

## error FactoryPaused

`createSurface`/`createPooledSurface` was called while the factory is paused
(see `setPaused`). Retry once the deployer resumes it.

## error NotDeployer

`deprecate` was called by an address other than the factory deployer.
