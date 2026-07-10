---
title: ICollectionView
---

# summary

ICollectionView is the read surface a collection exposes for its swappable
slots, [renderer](/docs/collections/contracts/i-renderer),
[price strategy](/docs/collections/contracts/i-price-strategy), and any minter, to read
without depending on the full
[Collection](/docs/collections/contracts/collection) ABI. It is not
itself one of the [four swappable slots](/docs/collections/concepts/four-slots); it's
the contract-shaped interface those slots read through.
`Collection` implements it in full. Any other contract that wants
to be adopted by an existing renderer only needs to implement whatever
subset of this interface that renderer actually reads.


## function idMode

view; the collection's token id assignment model, `Sequential` or `Pooled`,
fixed at initialization. See [id modes](/docs/collections/concepts/id-modes) for what
each mode means for id assignment and reuse after burn.


## function config

view; the live collection configuration, the derived lifecycle status
(`Scheduled`, `Open`, or `Closed`), and the minted-ever count. A renderer
derives provenance from these: in Sequential mode the token id IS the mint
order, first = id 1, and final = the status is `Closed` and the id equals
`minted`. See
[Mint Marks and entropy](/docs/collections/concepts/mint-marks-and-entropy).


## function isAdmin

view; whether the account holds an explicit admin grant on the collection
(the owner is an implicit admin). Renderer-land registries (the
GenerativeRenderer work registry, RenderAssets) borrow this as their write
authority, so managing presentation data carries exactly the same authority
as the collection's own setters.

## function name

view; the collection's ERC721 name.

## function owner

view; the collection's current owner, following the standard `Ownable`
`owner()` shape.

## function symbol

view; the collection's ERC721 symbol.


## function tokenSeed

view; the mint-time entropy stamped for `tokenId` during its mint
transaction. Renderers use this seed as the deterministic input for
generative or algorithmic works.

## function totalSupply

view; the collection's current total supply.

