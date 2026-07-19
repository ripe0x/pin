---
title: ISurfaceView
---

# summary

ISurfaceView is the read surface a collection exposes for its
[renderer](/docs/collections/contracts/i-renderer), a
[price strategy](/docs/collections/contracts/i-price-strategy), and any minter to read
without depending on the full
[Surface](/docs/collections/contracts/surface) ABI. It is not itself a
[swappable slot](/docs/collections/concepts/four-slots); it's the
contract-shaped interface those modules read through.
`Surface` implements it in full. Any other contract that wants
to be adopted by an existing renderer only needs to implement whatever
subset of this interface that renderer actually reads.


## function idMode

view; the collection's token id assignment model, `Sequential` or `Pooled`,
fixed at initialization. See [id modes](/docs/collections/concepts/id-modes) for what
each mode means for id assignment and reuse after burn.


## function config

view; the live collection configuration and the minted-ever count. A
renderer derives provenance from these: in Sequential mode the token id IS
the mint order, first = id 1, and final = the cap is set and full and the id
equals the cap (`cap != 0 && minted == cap && tokenId == cap`). There is no
lifecycle status on the token. See
[seed and provenance](/docs/collections/concepts/mint-marks-and-entropy).


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

