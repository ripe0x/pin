# ArtistRecordRegistry

Immutable, public-infrastructure registry where an artist address can
publish on-chain pointers that belong in its public artist record. The
contract has no admin, no owner, no upgrade path, no fees, no pause,
and no protocol logic. Anyone may deploy it. Anyone may read from it.
Anyone may write into their own record.

## What a record is

A record is an unordered set of pointers belonging to a single artist
address. There are three pointer types:

- **Contract pointer** — `address contractAddress`
- **Token pointer** — `(address contractAddress, uint256 tokenId)`
- **Token-range pointer** — `(address contractAddress, uint256 startTokenId, uint256 endTokenId)` (inclusive bounds; `start == end` is allowed)

Identity for each type is the full tuple. Two ranges with different
bounds are independent entries even if they overlap. Overlapping
ranges are allowed; the contract does not collapse or deduplicate
them.

## What a record means

The registry only means:

> *This artist address added this pointer to its public artist record.*

It does **not** prove authorship, provenance, token type,
authenticity, ownership, creator status, or endorsement. It does
**not** verify that the referenced contract exists, behaves as an NFT,
implements any token standard, or has ever minted the referenced
token id. Pointers can be added for any address and any token id —
including addresses that are EOAs, contracts that do not exist yet,
and token ids that may never be minted.

Downstream indexers and UIs are responsible for interpreting these
pointers: checking interfaces, resolving metadata, scoring confidence,
surfacing conflicts. The contract stays small on purpose; semantics
live off-chain.

## Operator delegation

The only privileged role is per-artist. An artist may approve any
address as an operator via `setOperator(operator, true)`. An operator
may then call the `*For` variants (`addContractFor`, `removeTokenFor`,
etc.) to mutate that artist's pointers.

Operators **cannot** sub-delegate. Calling `setOperator` from an
operator address sets the operator's *own* operator slot, not the
artist's — because authorization is scoped to `msg.sender`.

`OperatorSet` is emitted on every call, including idempotent ones, so
downstream consumers get a uniform audit trail.

## Batching via multicall

The registry inherits OpenZeppelin's `Multicall`. An artist (or an
approved operator) can submit any mix of pointer operations in a single
transaction via `multicall(bytes[] calls)`, where each `bytes` is the
ABI-encoded call to one of the registry's own functions.

This collapses what would otherwise be one wallet signature and one
intrinsic-gas charge *per pointer* into one of each for the whole batch.
For an artist declaring N contracts during initial setup, that is roughly
21k × (N − 1) gas saved on top of N − 1 fewer signing prompts.

Each inner call still emits its own event — indexers see one
`ContractAdded` / `TokenAdded` / `TokenRangeAdded` per pointer, regardless
of whether the call arrived stand-alone or inside a batch.

The batch is atomic: any inner revert (duplicate pointer, unauthorized
`*For` call, malformed range) reverts the whole transaction. Plan
batches so any expected reverts are resolved off-chain before submitting.

Authorization rules are unchanged. Inner calls execute via `delegatecall`
from the registry to itself, so `msg.sender` is preserved as the original
external caller; `*For` variants apply the same operator check inside a
batch as they do outside it.

## What is intentionally out of scope

**Key rotation and identity grouping.** This contract records pointers
added by a specific address. It does not track wallet migrations,
group multiple addresses under a single identity, or define a notion
of successor. Artists, platforms, wallets, and indexers may establish
continuity off-chain — through signatures, public statements, ENS
records, social verification, or other context. Aggregating records
across addresses is an off-chain concern.

**Semantic verification.** No token-standard checks, no balance
checks, no creator-role checks, no metadata resolution.

**Ordering.** Removal uses swap-and-pop, which moves the tail entry
into the freed slot. Order across reads is not stable. Consumers that
need a specific order should sort off-chain.

**Coverage queries on ranges.** `isTokenRangeRegistered` reports an
exact tuple match. A token id falling *inside* a registered range is
not reported as registered. Coverage logic belongs in indexers.

## Reading

Two access patterns are provided for each pointer type:

- **Full reads:** `getContracts`, `getTokens`, `getTokenRanges` return
  the entire list for a given artist. Convenient for small records;
  for large records the gas cost of copying storage to memory grows
  linearly.
- **Slice reads:** `getContractsSlice`, `getTokensSlice`,
  `getTokenRangesSlice` return up to `count` entries starting at
  `start`. Out-of-range requests degrade gracefully — `start >= length`
  returns an empty array, and `start + count > length` returns only
  the remaining entries. Useful for paginated frontends and indexers.

Existence checks (`isContractRegistered`, `isTokenRegistered`,
`isTokenRangeRegistered`) and counts (`getContractCount`,
`getTokenCount`, `getTokenRangeCount`) are also available, plus
indexed accessors (`getContractAt`, `getTokenAt`, `getTokenRangeAt`).

## Per-chain, deterministic deployment

Each registry instance is scoped to the chain it is deployed on.
Pointers reference contracts on the same chain — there is no
`chainId` field, because the deployment chain is the answer. Records
on different chains are independent.

To land the registry at the **same address on every chain**, deploy
through the canonical CREATE2 deterministic-deployment proxy
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`) with a chosen salt.
Identical addresses across chains require **all** of:

1. Same deployer (the CREATE2 proxy is identical on every chain it has
   been deployed to)
2. Same salt
3. Same init code hash (i.e. the exact same compiled bytecode)
4. Same Solidity compiler version
5. Same optimizer settings (including `runs`)
6. Same source code

Because the constructor takes no arguments, the init code hash is a
pure function of the compiled bytecode, which in turn depends on
items 4–6. Pinning the toolchain matters — salt alone is not enough.

## Events

| Event | When |
| --- | --- |
| `ContractAdded(artist, contractAddress)` | Contract pointer added |
| `ContractRemoved(artist, contractAddress)` | Contract pointer removed |
| `TokenAdded(artist, contractAddress, tokenId)` | Token pointer added |
| `TokenRemoved(artist, contractAddress, tokenId)` | Token pointer removed |
| `TokenRangeAdded(artist, contractAddress, startTokenId, endTokenId)` | Range pointer added |
| `TokenRangeRemoved(artist, contractAddress, startTokenId, endTokenId)` | Range pointer removed |
| `OperatorSet(artist, operator, approved)` | Operator approved or revoked |

## Errors

| Error | Cause |
| --- | --- |
| `NotAuthorized` | Caller is neither the artist nor an approved operator on a `*For` call |
| `InvalidArtist` | Artist parameter on a `*For` call was `address(0)` |
| `InvalidContractAddress` | Pointer's contract address was `address(0)` |
| `InvalidOperator` | Operator argument to `setOperator` was `address(0)` |
| `InvalidTokenRange` | Token range had `startTokenId > endTokenId` (raised on both add and remove) |
| `ContractAlreadyRegistered` / `ContractNotRegistered` | Duplicate add / missing remove for contract pointers |
| `TokenAlreadyRegistered` / `TokenNotRegistered` | Duplicate add / missing remove for token pointers |
| `TokenRangeAlreadyRegistered` / `TokenRangeNotRegistered` | Duplicate add / missing remove for range pointers |
