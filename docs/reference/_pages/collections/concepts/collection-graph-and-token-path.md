---
title: The Release Graph and Token Path
description: Directed edges between collections, and per-token forward pointers.
---

# The Release Graph and Token Path

Collections and tokens don't exist in isolation: a generative collection
can be a study for a later one, a token can carry backing that continues
elsewhere, an access-gated drop can point at what it gates. The Collection
System represents these relationships with two graph-shaped structures on
every collection: a collection-level **Release Graph** of typed edges to
other nodes, and a per-token **Token Path**, a forward pointer describing
what comes next for that specific token. Both are pointer layers: they
record and emit the relationship, they do not execute it.

## `Ref`, the shared addressing type

Both structures point at nodes using the same `Ref` struct, a globally
addressable target:

| Field | Type | Meaning |
| --- | --- | --- |
| `chainId` | `uint64` | `1` for Ethereum mainnet |
| `contractAddress` | `address` | A collection, or any other contract |
| `id` | `uint256` | Interpreted per `kind`; `0` for a collection-level node |
| `kind` | `RefKind` | How `id` should be read |

### `RefKind`

| Value | Meaning |
| --- | --- |
| `Collection` | `contractAddress` is a collection itself; `id` is ignored (conventionally `0`) |
| `Token` | `id` is a `tokenId` on `contractAddress`, an ERC721-shaped collection |
| `External` | `id` is interpreted by `contractAddress`'s own scheme (not necessarily ERC721 at all) |

`External` is what lets a `Ref` point at something like a CryptoPunk id on
the original CryptoPunksMarket contract, which is not an ERC721 token, or
any other foreign addressing scheme.

## The Release Graph

A directed, typed, append-only list of edges from one collection to any
other node.

```solidity
function addEdge(EdgeType edgeType, Ref calldata target) external; // owner-only
function edges() external view returns (Edge[] memory);
```

Each `Edge` is `{EdgeType edgeType, Ref target}`. `addEdge` is owner-only
and append-only: there is no remove, only ever more edges. `edges()`
returns the full list for a collection.

### `EdgeType`

| Value | Meaning |
| --- | --- |
| `BelongsTo` | This collection belongs to a broader grouping named by `target` |
| `StudyOf` | This collection is a study for `target` (a smaller, earlier exploration) |
| `PhaseOf` | This collection is one phase of a multi-phase work rooted at `target` |
| `Continues` | This collection continues `target` (a sequel or next chapter) |
| `Source` | `target` is the source material or input this collection derives from |
| `Access` | `target` is gated by, or grants access via, this collection |

A collection's `CollectionKind` (`Standalone`, `Study`, `Phase`, `Access`,
`Source`, `Continuation`) is the same vocabulary applied to the collection
itself as a whole, set once in `CollectionConfig.kind`; `EdgeType` is the
same relationships expressed as edges to specific other nodes.

### Making an edge mutual

An edge is a one-sided claim by the collection that added it: "I am a study
of X" says nothing about whether X agrees. `acknowledgeEdge` lets the
**target** side confirm or revoke that claim, without any central registry:

```solidity
function acknowledgeEdge(EdgeType edgeType, Ref calldata source, bool ack) external; // owner-only
function isEdgeAcknowledged(EdgeType edgeType, Ref calldata source) external view returns (bool);
```

If collection B calls `acknowledgeEdge(StudyOf, refToA, true)`, a reader
can now show the `A --StudyOf--> B` edge as verified mutual rather than
merely claimed. Passing `ack = false` revokes a prior acknowledgment;
calling with the same value twice is a no-op (idempotent).

## The Token Path

A per-token forward pointer: what a specific token points toward next,
distinct from the collection-level Release Graph.

```solidity
function pathOf(uint256 tokenId) external view returns (Path memory);
function setDefaultPath(PathType pathType, Ref calldata target, bytes32 data) external; // owner-only
function setPath(uint256 tokenId, PathType pathType, Ref calldata target, bytes32 data) external; // owner-only
```

Each `Path` is `{PathType pathType, Ref target, bytes32 data}`, where
`data` is an optional auxiliary payload whose meaning depends on
`pathType`. A collection has one `_defaultPath` applied to every token, and
may override it per token with `setPath`. `pathOf(tokenId)` returns the
token-specific override if one was set, otherwise the collection's default.

### `PathType`

| Value | Meaning |
| --- | --- |
| `None` | No forward pointer |
| `Continuation` | Points at what this token continues into |
| `Migration` | Points at where this token migrates to |
| `Claim` | Points at something this token can be used to claim |
| `Reveal` | Points at a reveal target (pre-reveal placeholder pattern) |
| `Burn` | Points at what burning this token produces or unlocks |
| `Custom` | Artist-defined meaning, interpreted by `data` and offchain convention |

The current implementation only stores and emits `Path`/`PathSet`/
`DefaultPathSet`; nothing in the core executes a path automatically. A
companion contract or an offchain process is what actually acts on a
`Claim` or `Migration` path; the collection's role is to make the pointer
readable and provable onchain.

## Example

A generative collection `B` that is a study for a planned collection `A`,
where token `#42` of `B` is meant to migrate into `A`'s token `#7` once `A`
exists:

```solidity
// On B, once A's address is known:
B.addEdge(EdgeType.StudyOf, Ref({chainId: 1, contractAddress: addressOfA, id: 0, kind: RefKind.Collection}));

// A acknowledges the relationship:
A.acknowledgeEdge(EdgeType.StudyOf, Ref({chainId: 1, contractAddress: addressOfB, id: 0, kind: RefKind.Collection}), true);

// B sets token #42's path toward A's token #7:
B.setPath(
    42,
    PathType.Migration,
    Ref({chainId: 1, contractAddress: addressOfA, id: 7, kind: RefKind.Token}),
    bytes32(0)
);
```

A reader can now discover, entirely onchain: that `B` is a study of `A`
(and that `A` confirms it), and that `B`'s token `#42` specifically points
at `A`'s token `#7`.

See [Types](/docs/collections/concepts/types) for the full struct and enum
definitions.
