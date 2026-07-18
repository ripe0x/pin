---
contract: DefaultRenderer
slug: default-renderer
deploymentsKey: defaultRenderer
title: DefaultRenderer
---

# summary

The canonical built-in renderer for [Surface](/docs/collections/contracts/surface).
Every collection is wired to it at deploy (`defaultRenderer` in the
factory's `InitParams`) and uses it unless the owner points the renderer
slot somewhere else. It's a shared singleton: one immutable, ownerless
instance serves every collection that wants it. There is no per-collection
state here; `tokenURI` and `contractURI` both take the collection address
explicitly and read everything they need back through
[ISurfaceView](/docs/collections/contracts/i-surface-view).

DefaultRenderer covers the static-artwork case: one image per token (either
a per-token override or the collection's shared cover), with the token's
[Mint Mark](/docs/collections/concepts/mint-marks-and-entropy) surfaced as
derived provenance attributes for sequential-id collections. A collection
that wants unique-per-token generative art points its renderer slot at a
purpose-built [IRenderer](/docs/collections/contracts/i-renderer) the artist
deploys (a bring-your-own generative renderer) instead.

## function tokenURI

Builds the token's metadata JSON and returns it as a
`data:application/json;base64,` URI. The `image` field comes from
[RenderAssets](/docs/collections/contracts/render-assets): the token's own
capture if one is set, otherwise the collection's shared cover.
`attributes` is fully derived, nothing per-token is stored beyond the seed.
For sequential-id collections the token id is the mint order (ids assigned
1, 2, 3..., never reused), so the renderer emits a numeric `Mint Order`
trait equal to the token id, a `Provenance` trait "First mint of the
collection" on token 1, and a `Provenance` trait "Final mint of the
collection" on the highest id once the collection reads Closed. Pooled ids
are not mint order, so pooled-mode collections get an empty `attributes`
array; a pooled work wanting mint-time traits records its own data via a
mint hook and reads it in a custom renderer. These are provenance
attributes, not rarity traits; DefaultRenderer draws no trait data from the
work itself. The collection name and the image URI are JSON-escaped per
RFC 8259 before being embedded, so an owner-controlled name or artwork URI
can never break the JSON structure.

## function contractURI

Collection-level metadata as a `data:application/json;base64,` URI,
currently just the escaped collection `name`. Consumed by marketplaces that
read ERC-7572 contract-level metadata.

## function renderAssets

The RenderAssets registry this renderer serves static images from: the
per-token capture if one exists, else the collection cover. The collection
core stores no presentation data.

## error AssetsRequired

Reverts construction when the RenderAssets address is zero: the renderer has no
registry to read images from.
