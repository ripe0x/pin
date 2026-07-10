---
title: RenderAssets
---

# summary

The renderer-land registry of static display assets: each collection's shared
cover image and per-token captures (thumbnails of rendered output). One
immutable, ownerless singleton serves every collection; writes are gated by
each collection's own owner/admin authority, so managing display assets
carries exactly the same authority as the collection's own setters.

This registry exists so the collection core stores NO presentation data — the
core's `tokenURI` defers wholly to its renderer, and the bundled renderers
([DefaultRenderer](/docs/collections/contracts/default-renderer),
[GenerativeRenderer](/docs/collections/contracts/generative-renderer)) read
their static images here. Captures are deliberately always refreshable: they
are convenience mirrors of rendered output for surfaces that cannot run it,
not part of the art. The art's permanence is the collection's `lockRenderer()`
plus whatever immutability the renderer itself offers (e.g. the
GenerativeRenderer's per-collection work lock).

## function setCover

access: collection owner or admin (`onlyCollectionAdmin`, else `NotCollectionAdmin`)

Sets the collection's shared/cover image URI ("" clears it). The bundled
renderers fall back to this for any token without a capture. Emits `CoverSet`.

## function setCaptures

access: collection owner or admin (`onlyCollectionAdmin`, else `NotCollectionAdmin`)

Sets per-token capture URIs; a single token is a batch of one. Always
available — a capture mirrors already-rendered output, so refreshing one can
never change the art. To nudge marketplaces to re-fetch, follow up with the
collection's ERC-4906 `notifyMetadataUpdate` (owner/admin may call it).
Reverts `LengthMismatch` when the id and URI arrays differ in length. Emits
`CaptureSet` per token.

## function imageFor

The image the bundled renderers serve for a token: its capture if one exists,
else the collection cover, else "".

## function captureOf

The raw per-token capture URI ("" if none set), without the cover fallback.

## function coverOf

The collection's shared/cover image URI ("" if none set).

## event CoverSet

Emitted when a collection's cover image changes. Indexed by `collection`.

## event CaptureSet

Emitted per token when captures are set. Indexed by `collection` and
`tokenId`.

## error NotCollectionAdmin

A write was attempted by an address that is neither the collection's owner
nor one of its admins.

## error LengthMismatch

`setCaptures` was given id and URI arrays of different lengths.
