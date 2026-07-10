---
title: IRenderer
---

# summary

IRenderer is the interface a contract implements to occupy a collection's
renderer slot, one of the
[four swappable slots](/docs/collections/concepts/four-slots) on the
[Collection](/docs/collections/contracts/collection) core. A
collection's `tokenURI` and `contractURI` delegate to whatever renderer sits
in its renderer slot. The collection address is an explicit parameter on
both functions rather than `msg.sender`, so a single renderer instance
serves every collection that adopts it, an off-chain caller can `eth_call`
it directly for any collection without a transaction, and any contract can
adopt a given renderer as long as it implements
[ICollectionView](/docs/collections/contracts/i-collection-view).

Renderers are onchain views with full EVM read access: a token's seed, its
owner, sibling tokens on the same collection, companion contract state, and
other foreign contracts, plus current block state. That read access is what
makes network-based, live-rendering works expressible instead of limiting a
renderer to data baked in at mint time. See the
[write a renderer guide](/docs/collections/guides/write-a-renderer) for a worked
implementation.

A renderer MAY additionally implement the OPTIONAL `IPreviewRenderer`
extension (`previewURI(collection, tokenId, seed)`), rendering what a token
would look like for a caller-supplied seed with no token required. Detection
is a try/catch `eth_call`, not ERC-165. See
[the injection convention](/docs/collections/reference/injection-convention) for
the `context: "preview"` contract a preview document must inject, and
[write a renderer](/docs/collections/guides/write-a-renderer) for the two
built-in renderers that implement it.

## function tokenURI

view; returns the metadata URI for `tokenId` on `collection`. Called by the
collection's own `tokenURI` when this renderer occupies its renderer slot,
and callable directly off-chain against any collection this renderer
supports. Implementations typically read the token's data through
[ICollectionView](/docs/collections/contracts/i-collection-view) on `collection`, its
seed, Mint Mark, work config, and so on, to build the returned metadata.

## function contractURI

view; returns the collection-level metadata URI for `collection`. Called by
the collection's own `contractURI` when this renderer occupies its renderer
slot. Marketplaces and indexers read this for collection-level display
metadata, separate from any individual token's `tokenURI`.
