---
contract: DefaultRenderer
slug: default-renderer
deploymentsKey: defaultRenderer
title: DefaultRenderer
---

# summary

The canonical built-in renderer for [Collection](/docs/collections/contracts/collection).
Every collection is wired to it at deploy (`defaultRenderer` in the
factory's `InitParams`) and uses it unless the owner points the renderer
slot somewhere else. It's a shared singleton: one immutable, ownerless
instance serves every collection that wants it. There is no per-collection
state here; `tokenURI` and `contractURI` both take the collection address
explicitly and read everything they need back through
[ICollectionView](/docs/collections/contracts/i-renderer).

DefaultRenderer covers the static-artwork case: one image per token (either
a per-token override or the collection's shared cover), with the token's
[Mint Mark](/docs/collections/concepts/mint-marks-and-entropy) surfaced as provenance
attributes. A collection that wants unique-per-token generative art points
its renderer slot at [GenerativeRenderer](/docs/collections/contracts/generative-renderer)
or a purpose-built [IRenderer](/docs/collections/contracts/i-renderer) instead.

## function tokenURI

Builds the token's metadata JSON and returns it as a
`data:application/json;base64,` URI. The `image` field is the token's own
artwork override (`ICollectionView.tokenArtwork`) if one is set, otherwise
the collection's shared `artwork()`. `attributes` carries the token's Mint
Mark: Mint Order (1-based), Mint Block, Mint Surface (the address that
hosted the mint), Status at Mint (Open, Closing, or Closed), and, when
applicable, a Provenance entry for "First mint of the collection" or "Final
mint of the collection". These are provenance attributes, not rarity
traits; DefaultRenderer draws no trait data from the work itself. The
collection name and any owner-set strings are JSON-escaped per RFC 8259
before being embedded, so an owner-controlled name or artwork URI can never
break the JSON structure.

## function contractURI

Collection-level metadata as a `data:application/json;base64,` URI,
currently just the escaped collection `name`. Consumed by marketplaces that
read ERC-7572 contract-level metadata.
