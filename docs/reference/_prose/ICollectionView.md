---
title: ICollectionView
---

# summary

ICollectionView is the read surface a collection exposes for its swappable
slots, [renderer](/docs/collections/contracts/i-renderer),
[price strategy](/docs/collections/contracts/i-price-strategy), and any minter, to read
without depending on the full
[SovereignCollection](/docs/collections/contracts/sovereign-collection) ABI. It is not
itself one of the [four swappable slots](/docs/collections/concepts/four-slots); it's
the contract-shaped interface those slots read through.
`SovereignCollection` implements it in full. Any other contract that wants
to be adopted by an existing renderer only needs to implement whatever
subset of this interface that renderer actually reads.

## function artwork

view; the collection's shared or cover artwork URI, used when no per-token
override is set via `tokenArtwork`.

## function idMode

view; the collection's token id assignment model, `Sequential` or `Pooled`,
fixed at initialization. See [id modes](/docs/collections/concepts/id-modes) for what
each mode means for id assignment and reuse after burn.

## function isWorkLocked

view; whether the collection's work configuration has been permanently
frozen. A locked work's `workConfig` can never change again.

## function mintMarkOf

view; the derived Mint Mark for `tokenId`, the provenance record capturing
mint order, mint block, collection status at mint time, originating
surface, and whether the token was first or final. See
[Mint Marks and entropy](/docs/collections/concepts/mint-marks-and-entropy) for how the
mark is derived.

## function name

view; the collection's ERC721 name.

## function owner

view; the collection's current owner, following the standard `Ownable`
`owner()` shape.

## function symbol

view; the collection's ERC721 symbol.

## function tokenArtwork

view; the per-token artwork override for `tokenId`, or an empty string if
none is set, in which case a renderer should fall back to `artwork()`.

## function tokenSeed

view; the mint-time entropy stamped for `tokenId` during its mint
transaction. Renderers use this seed as the deterministic input for
generative or algorithmic works.

## function totalSupply

view; the collection's current total supply.

## function workConfig

view; what the work is, executably: onchain code references, dependency
files, an off-chain code URI with an integrity hash, a declared
[liveness](/docs/collections/concepts/types) level, the injection convention version,
and renderer-interpreted render parameters. Empty for works whose renderer
contract is itself the algorithm, for example a Solidity SVG work with
nothing to inject.
