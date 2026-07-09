---
title: Attribution
---

# summary

Attribution is generic, immutable, public infrastructure recording the
works-to-artists half of the bilateral attribution handshake. Catalog is the
other half (artists-to-works): an artist calls `Catalog.addContract` to
claim a work as its own. This contract records the reverse direction: a
collection's owner, or the collection itself acting during its own
initialization, declares which artist addresses collaborated on it.

Attribution has no admin, no owner, no upgrade path, no fees, and no pause.
The only privileged role is per-collection: either the collection contract
itself, matching `msg.sender == collection`, or the address the collection's
own `owner()` view resolves to, if it exposes one. A roster is a one-sided
claim exactly like a Catalog pointer is a one-sided claim in the other
direction; only an indexer or UI that reads both halves and computes the
intersection can call an attribution mutually confirmed.

# concepts

### One-sided claims and confirmed attribution

This contract only ever means: the collection's owner, or the collection
itself during its own initialization, asserted that these addresses are this
collection's artists. It does not prove that a listed artist actually
contributed, consented, or is even aware of the listing. Confirmed
attribution is the intersection, computed off-chain:

```
confirmed(collection, artist) :=
    artist IN Attribution.artistsOf(collection)
    AND
    Catalog.isContractRegistered(artist, collection)
```

Neither half proves the other. A collection can list an artist who never
claims it in their Catalog, an unconfirmed credit. An artist can claim a
collection in their Catalog that never lists them here, a self-asserted,
unconfirmed claim from the other side. Attribution does not compute that
intersection onchain: doing so would require reading a specific Catalog
deployment on a specific chain at a specific address, coupling two otherwise
independent singletons. Keeping them decoupled means either can be deployed,
replaced, or omitted without touching the other.

Reverse lookups, which collections list a given artist, are intentionally
not provided here, mirroring Catalog's choice to keep the onchain surface
minimal. Enumerating every collection that names a given artist is an
indexer's job: scan `ArtistsSet` events and build the reverse map off-chain.

### Authorization: self-call or owner()

A roster write for `collection` is authorized when either:

1. `msg.sender == collection` itself, which covers a factory writing the
   roster from inside the collection's own `initialize()`, where the
   collection is calling Attribution about itself, or
2. `msg.sender` is the address `collection.owner()` resolves to, if
   `collection` exposes a working `owner()` view.

Path 2 is evaluated with a raw `staticcall` rather than casting to the
`Ownable` interface type, because plenty of collections, including bespoke
or third-party ones, are not `Ownable` at all. A `staticcall` that reverts,
returns fewer than 32 bytes, or decodes to a word with non-zero bits above
the low 160 is treated as "this collection has no owner we can trust,"
falling through to `NotAuthorized` rather than reverting inside the
authorization check itself. For a non-`Ownable` collection, only the
self-call path can ever authorize a write.

### Replace, not append, and one-way locking

`setArtists` replaces the roster wholesale. Calling it a second time with a
different array discards the previous roster entirely: there is no partial
update, no dedupe against the prior list, and no historical roster kept in
storage. The full history is reconstructable off-chain from `ArtistsSet`
events, which fire on every call with the complete new roster. Duplicate
addresses within a single call are not deduplicated or rejected; the array
is stored exactly as given.

`lockRoster` is one-way per collection: once locked, `setArtists` reverts
`RosterAlreadyLocked` forever for that collection, and there is no unlock
function. Locking with an empty, never-set roster is allowed and
permanently freezes the roster at empty. Calling `lockRoster` again after it
is already locked is a harmless no-op that re-emits `RosterLocked` rather
than reverting.

### Per-chain, deterministic deployment

Each Attribution instance is scoped to the chain it's deployed on; rosters
reference collections on that same chain, and there is no `chainId` field
because the deployment chain is the answer. Instances on different chains
are independent, and there is no mechanism linking an Attribution address to
a Catalog address, on the same chain or across chains.

## function setArtists

access: core-only or owner-only (the caller must be `collection` itself, or
the address `collection.owner()` resolves to; guarded by `NotAuthorized`)

Declares, replacing wholesale, the artist roster for `collection`. Reverts
`InvalidCollection` if `collection` is the zero address, `EmptyArtists` if
`artists` is empty, and `RosterAlreadyLocked` if `lockRoster` was previously
called for this collection. On success, stores `artists` and emits
`ArtistsSet` with the complete new roster.

An empty array is rejected rather than silently accepted, since it would
only confuse an indexer watching `ArtistsSet` for what looks like a
roster-clearing event that never actually happens.

## function lockRoster

access: core-only or owner-only (same authorization as `setArtists`)

Freezes `collection`'s roster one-way: after this call, every future
`setArtists` for `collection` reverts `RosterAlreadyLocked`, and there is no
unlock path. Reverts `InvalidCollection` if `collection` is the zero
address. Idempotent: calling it again after the roster is already locked
re-emits `RosterLocked` without reverting.

## function artistAt

Indexed access to a single roster entry for `collection` at `index`.
Reverts on an out-of-bounds index with the default array-access revert.

## function artistCountOf

The number of artists in `collection`'s roster.

## function artistsOf

The full artist roster for `collection`, in the order set by the most
recent `setArtists` call. For very large rosters, prefer `artistsSlice` to
avoid pulling the entire array in one call.

```bash
cast call {{addr:attribution}} "artistsOf(address)(address[])" <COLLECTION_ADDRESS> \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function artistsSlice

Paginated read of `collection`'s roster: up to `count` artists starting at
`start`. Tolerates out-of-range requests: if `start` is at or past the
roster length, returns an empty array; if `start + count` exceeds the
length, returns only the remaining elements. Useful for frontends and
indexers reading large rosters without paying the gas of a full-array copy.

## function isRosterLocked

Whether `collection`'s roster has been locked via `lockRoster`. Once true,
this can never revert back to false.

## event ArtistsSet

Emitted on every successful `setArtists` call, with `collection` and `actor`
(the authorized caller) indexed, and the complete new `artists` array in the
data. Since `setArtists` replaces rather than appends, each event is a full
snapshot of the roster at that point; an indexer reconstructing history
should treat the latest `ArtistsSet` per collection as authoritative.

## event RosterLocked

Emitted when `lockRoster` succeeds, including on the idempotent no-op path
when the roster was already locked. `collection` is indexed.

## error EmptyArtists

`setArtists` was called with an empty `artists` array. Declare a real
roster or don't call `setArtists` at all.

## error InvalidCollection

The `collection` argument to `setArtists`, `lockRoster`, or an
authorization check was the zero address.

## error NotAuthorized

The caller is neither `collection` itself nor the address a successful
`owner()` staticcall on `collection` resolves to. For a collection with no
working `owner()` view, only a self-call during the collection's own
initialization, or any other self-call the collection chooses to make, can
ever authorize a write.

## error RosterAlreadyLocked

`setArtists` was called for a `collection` whose roster was previously
frozen with `lockRoster`. The lock is one-way; there is no unlock function.
