---
title: Catalog
---

# summary

An immutable public registry where an artist address publishes onchain
pointers to its work. A pointer is one of three types: a contract address, a
single token on a contract, or a contiguous inclusive range of token ids on a
contract. Each address writes its own list; there is no owner, admin, upgrade
path, fee, or pause, and the only privileged relation is per-artist operator
approval.

A catalog entry records only that a given address added a given pointer. It
does not prove authorship, provenance, ownership, or creator status, and does
not check that the referenced contract or token exists or behaves as an NFT.
Interpreting pointers, resolving metadata, and reconciling conflicts are the
reader's job; the contract holds no semantics.

Within the Surface System, a collection reads `isContractRegistered(creator,
collection)` for the creator half of its two-sided attribution: a
[collection](/docs/surface/contracts/surface) owner lists a creator, and
that creator claims the collection by calling `addContract(collection)` here
from their own address. The Catalog is a general registry, not specific to
Surface: any address can register any contract or token.

# concepts

### Pointer types

Three independent pointer types, each stored in its own per-artist list and
keyed separately:

- **contract**: an address (`addContract`). Any address is accepted, including
  an EOA; the only check is nonzero
- **token**: a `(contract, tokenId)` pair (`addToken`)
- **token range**: a `(contract, startTokenId, endTokenId)` inclusive range
  (`addTokenRange`); `startTokenId == endTokenId` is a valid one-token range

The types are not deduplicated against each other. A token registered as both
`addToken(c, id)` and `addTokenRange(c, id, id)` is two separate entries in two
separate lists. Overlapping ranges are allowed: identity is the exact
`(contract, start, end)` tuple, so two ranges with different bounds are
distinct even when they overlap. `isTokenRangeRegistered` matches the exact
tuple, not ranges that merely cover it.

### Direct and operator writes

Every mutation has a direct form that writes the caller's own list
(`addContract`) and a `*For` form that writes a named artist's list
(`addContractFor(artist, ...)`). The `*For` form reverts `NotAuthorized` unless
the caller is the artist or an operator the artist approved with `setOperator`.
An operator cannot sub-delegate: calling `setOperator` from an operator address
sets that operator's own slot, not the artist's. Every mutation emits an event
carrying both the `artist` whose list changed and the `actor` (`msg.sender`)
that made the change, so operator attribution is readable from the log alone.

### Unordered storage

Removal is swap-and-pop: removing an entry that is not last moves the last
entry into the freed slot. Order is therefore not stable across writes. A
reader needing a fixed order sorts client-side. Existence and removal are O(1)
through an internal index map, so an unordered list is not a scan.

### Batching with multicall

The contract inherits OpenZeppelin `Multicall`. `multicall(bytes[] data)`
runs several encoded calls in one transaction, each by `delegatecall` to this
contract so `msg.sender` is preserved and the `*For` authorization check
applies inside a batch exactly as outside it. The batch is atomic: the first
inner revert reverts the whole batch. Each inner call still emits its own
event, so an indexer sees one add or remove event per pointer with no
batch-specific decoding.

### Per-chain deterministic deployment

Each Catalog instance is scoped to its deployment chain; pointers reference
contracts on that same chain, and there is no `chainId` field. Deploying at the
same address on multiple chains requires the CREATE2 deterministic-deployment
proxy plus a matching salt, init code, compiler version, optimizer settings,
and source. The contract takes no constructor arguments.

### Live reads

The Catalog is deployed on Ethereum mainnet, so these run against the real
address:

```bash
# Every pointer type for an artist in one call
cast call {{addr:catalog}} \
  "getCatalogOf(address)(address[],(address,uint256)[],(address,uint256,uint256)[])" \
  <ARTIST_ADDRESS> --rpc-url https://ethereum-rpc.publicnode.com

# Whether an artist has registered a contract pointer
cast call {{addr:catalog}} "isContractRegistered(address,address)(bool)" \
  <ARTIST_ADDRESS> <CONTRACT_ADDRESS> \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function addContract

access: permissionless (writes only the caller's own list)

Adds a contract pointer to the caller's catalog. Reverts
`InvalidContractAddress` for the zero address and `ContractAlreadyRegistered`
if the caller already registered it. Emits `ContractAdded`.

## function addContractFor

access: artist or operator (the `artist` argument, or an address it approved via `setOperator`, else `NotAuthorized`)

Adds a contract pointer to `artist`'s catalog. Reverts `InvalidArtist` for a
zero artist, `InvalidContractAddress` for a zero contract, and
`ContractAlreadyRegistered` on a duplicate. Emits `ContractAdded` with `actor`
set to the caller.

## function removeContract

access: permissionless (writes only the caller's own list)

Removes a contract pointer from the caller's catalog. Reverts
`ContractNotRegistered` if the caller has no such pointer. Emits
`ContractRemoved`.

## function removeContractFor

access: artist or operator (the `artist` argument, or an approved operator, else `NotAuthorized`)

Removes a contract pointer from `artist`'s catalog. Reverts `InvalidArtist` for
a zero artist and `ContractNotRegistered` if the pointer does not exist. Emits
`ContractRemoved`.

## function addToken

access: permissionless (writes only the caller's own list)

Adds a single-token pointer `(contract, tokenId)` to the caller's catalog.
Reverts `InvalidContractAddress` for a zero contract and
`TokenAlreadyRegistered` on a duplicate. Emits `TokenAdded`.

## function addTokenFor

access: artist or operator (the `artist` argument, or an approved operator, else `NotAuthorized`)

Adds a single-token pointer to `artist`'s catalog. Reverts `InvalidArtist`,
`InvalidContractAddress`, or `TokenAlreadyRegistered` as above. Emits
`TokenAdded`.

## function removeToken

access: permissionless (writes only the caller's own list)

Removes a single-token pointer from the caller's catalog. Reverts
`TokenNotRegistered` if absent. Emits `TokenRemoved`.

## function removeTokenFor

access: artist or operator (the `artist` argument, or an approved operator, else `NotAuthorized`)

Removes a single-token pointer from `artist`'s catalog. Reverts `InvalidArtist`
or `TokenNotRegistered`. Emits `TokenRemoved`.

## function addTokenRange

access: permissionless (writes only the caller's own list)

Adds a token-range pointer `(contract, startTokenId, endTokenId)` to the
caller's catalog. Reverts `InvalidContractAddress` for a zero contract,
`InvalidTokenRange` when `startTokenId > endTokenId`, and
`TokenRangeAlreadyRegistered` on a duplicate tuple. `startTokenId ==
endTokenId` is a valid one-token range. Emits `TokenRangeAdded`.

## function addTokenRangeFor

access: artist or operator (the `artist` argument, or an approved operator, else `NotAuthorized`)

Adds a token-range pointer to `artist`'s catalog. Reverts `InvalidArtist`,
`InvalidContractAddress`, `InvalidTokenRange`, or
`TokenRangeAlreadyRegistered` as above. Emits `TokenRangeAdded`.

## function removeTokenRange

access: permissionless (writes only the caller's own list)

Removes a token-range pointer from the caller's catalog. Reverts
`InvalidTokenRange` for an inverted range (rejected on the same terms as add)
and `TokenRangeNotRegistered` if the exact tuple is absent. Emits
`TokenRangeRemoved`.

## function removeTokenRangeFor

access: artist or operator (the `artist` argument, or an approved operator, else `NotAuthorized`)

Removes a token-range pointer from `artist`'s catalog. Reverts `InvalidArtist`,
`InvalidTokenRange`, or `TokenRangeNotRegistered`. Emits `TokenRangeRemoved`.

## function setOperator

access: permissionless (sets only the caller's own operator slot)

Approves or revokes `operator` for the caller, controlling
`isOperator[msg.sender][operator]`. An approved operator may call the `*For`
functions on the caller's behalf. There is no `setOperatorFor`, so an operator
cannot sub-delegate. Reverts `InvalidOperator` for the zero address. Always
emits `OperatorSet`, including when the value is unchanged.

## function multicall

access: permissionless (each inner call enforces its own authorization)

Runs several encoded calls in one transaction, each by `delegatecall` to this
contract, so `msg.sender` is preserved and the `*For` authorization applies to
inner calls. Atomic: the first inner revert reverts the whole batch. Returns
each inner call's return data, in order. Each inner call emits its own event.

## function isContractRegistered

Whether `artist` has a contract pointer for `contractAddress`.

## function isTokenRegistered

Whether `artist` has a single-token pointer for `(contractAddress, tokenId)`.

## function isTokenRangeRegistered

Whether `artist` has a token-range pointer for the exact
`(contractAddress, startTokenId, endTokenId)` tuple. Does not report ranges
that merely cover those bounds; coverage is a reader-side computation.

## function isOperator

Whether `artist` has approved `operator` to write its lists through the `*For`
functions.

## function getCatalogOf

Every pointer in `artist`'s catalog in one call: the contract list, the
single-token list, and the token-range list. A zero or empty artist returns
three empty arrays. For a large catalog, prefer the per-type `*Slice` getters
to stay within RPC return-size limits.

## function getCatalogCountsOf

The three list lengths for `artist` (contracts, tokens, token ranges) in one
call. An address with no entries returns `(0, 0, 0)`. Cheaper than
`getCatalogOf` when only sizes are needed.

## function getContracts

Every contract pointer in `artist`'s catalog. Order is not stable; for a large
list prefer `getContractsSlice`.

## function getContractsSlice

Up to `count` contract pointers from `artist`'s list starting at `start`. A
`start` past the end returns an empty array; a `start + count` past the end
returns the remaining elements. For paginated reads without copying the full
list.

## function getContractCount

The number of contract pointers in `artist`'s catalog.

## function getContractAt

The contract pointer at `index` in `artist`'s list. Reverts on an
out-of-bounds index. The list order is not stable across writes.

## function getTokens

Every single-token pointer in `artist`'s catalog, as `(contract, tokenId)`
structs. Order is not stable; for a large list prefer `getTokensSlice`.

## function getTokensSlice

Up to `count` single-token pointers from `artist`'s list starting at `start`,
with the same out-of-range handling as `getContractsSlice`.

## function getTokenCount

The number of single-token pointers in `artist`'s catalog.

## function getTokenAt

The single-token pointer at `index` in `artist`'s list, returned as
`(contractAddress, tokenId)`. Reverts on an out-of-bounds index.

## function getTokenRanges

Every token-range pointer in `artist`'s catalog, as
`(contract, startTokenId, endTokenId)` structs. Order is not stable; for a
large list prefer `getTokenRangesSlice`.

## function getTokenRangesSlice

Up to `count` token-range pointers from `artist`'s list starting at `start`,
with the same out-of-range handling as `getContractsSlice`.

## function getTokenRangeCount

The number of token-range pointers in `artist`'s catalog.

## function getTokenRangeAt

The token-range pointer at `index` in `artist`'s list, returned as
`(contractAddress, startTokenId, endTokenId)`. Reverts on an out-of-bounds
index.

## function getContractKey

The internal storage key for a contract pointer,
`keccak256(abi.encode(contractAddress))`. Exposed for callers that reproduce
the keying offchain.

## function getTokenKey

The internal storage key for a single-token pointer,
`keccak256(abi.encode(contractAddress, tokenId))`.

## function getTokenRangeKey

The internal storage key for a token-range pointer,
`keccak256(abi.encode(contractAddress, startTokenId, endTokenId))`.

## event ContractAdded

Emitted when a contract pointer is added. Indexed by `artist` (whose list
changed), `actor` (`msg.sender`), and `contractAddress`. `actor != artist` on
an operator write.

## event ContractRemoved

Emitted when a contract pointer is removed. Indexed by `artist`, `actor`, and
`contractAddress`.

## event TokenAdded

Emitted when a single-token pointer is added. Indexed by `artist`, `actor`, and
`contractAddress`; `tokenId` is in the data segment (three topic slots are
already used).

## event TokenRemoved

Emitted when a single-token pointer is removed. Indexed by `artist`, `actor`,
and `contractAddress`, with `tokenId` in the data.

## event TokenRangeAdded

Emitted when a token-range pointer is added. Indexed by `artist`, `actor`, and
`contractAddress`, with `startTokenId` and `endTokenId` in the data.

## event TokenRangeRemoved

Emitted when a token-range pointer is removed. Indexed by `artist`, `actor`,
and `contractAddress`, with `startTokenId` and `endTokenId` in the data.

## event OperatorSet

Emitted on every `setOperator` call, including a no-op that sets the current
value. Indexed by `artist` and `operator`, with the new `approved` flag.

## error NotAuthorized

A `*For` function was called by an address that is neither the named `artist`
nor an operator the artist approved.

## error InvalidArtist

A `*For` function was given the zero address as `artist`.

## error InvalidContractAddress

A pointer's contract address was the zero address.

## error InvalidOperator

`setOperator` was given the zero address as `operator`.

## error InvalidTokenRange

A token-range add or remove had `startTokenId > endTokenId`. Both paths reject
the same inverted tuple.

## error ContractAlreadyRegistered

`addContract`/`addContractFor` targeted a contract pointer already in the
artist's catalog.

## error ContractNotRegistered

`removeContract`/`removeContractFor` targeted a contract pointer not in the
artist's catalog.

## error TokenAlreadyRegistered

`addToken`/`addTokenFor` targeted a single-token pointer already in the
artist's catalog.

## error TokenNotRegistered

`removeToken`/`removeTokenFor` targeted a single-token pointer not in the
artist's catalog.

## error TokenRangeAlreadyRegistered

`addTokenRange`/`addTokenRangeFor` targeted a range tuple already in the
artist's catalog. Identity is the exact `(contract, start, end)` tuple.

## error TokenRangeNotRegistered

`removeTokenRange`/`removeTokenRangeFor` targeted a range tuple not in the
artist's catalog.

## error FailedCall

Inherited from OpenZeppelin `Multicall`/`Address`. An inner `multicall`
delegatecall reverted without a reason to bubble up.

## error AddressEmptyCode

Inherited from OpenZeppelin `Address`. A low-level call in the inherited
utilities targeted an address with no code. Not reachable through this
contract's own functions, since `multicall` delegatecalls to this contract.
