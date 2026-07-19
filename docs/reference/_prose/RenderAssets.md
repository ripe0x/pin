---
title: RenderAssets
---

# summary

Registry of static display assets for renderers: each collection's cover image,
per-token captures (thumbnails of rendered output), and a capture template
resolved per token id. One immutable, ownerless singleton serves every
collection. The cover and role grants are gated by each collection's owner/admin
authority; the two capture writes may also be made by narrow, admin-granted
capturer keys.

The collection core stores no presentation data: its `tokenURI` defers to the
renderer, and the bundled
[DefaultRenderer](/docs/surface/contracts/default-renderer), plus any
renderer that reads here, resolves its static image from this registry. Captures
are always writable: a capture is a mirror of already-rendered output for
surfaces that cannot run the render, and rewriting one does not change the
token's onchain output. Presentation permanence comes from the collection's
`lockRenderer()` and the renderer's own immutability, not from a capture, which
is why a capturer key can be granted narrowly: the write it can make is a
thumbnail pointer, overwritten by the next write.

## function setCover

access: collection owner or admin (`onlySurfaceAdmin`, else `NotSurfaceAdmin`)

Sets the collection's shared/cover image URI ("" clears it). The bundled
renderers fall back to this for any token without a capture or template. Emits
`CoverSet`.

## function setCapturer

access: collection owner or admin (`onlySurfaceAdmin`, else `NotSurfaceAdmin`)

Grants or revokes a capturer for the collection: a key that may write captures
and the capture template, and nothing else. The grant itself is not
capturer-writable. Emits `CapturerSet`.

## function setCaptureTemplate

access: collection owner, admin, or granted capturer (else `NotCaptureAuthorized`)

Sets the collection's capture URI template ("" clears it). Every `{id}` in the
template resolves to the token id at read time, so one write covers every token
(for example a manifest at `ar://<manifest>/{id}.png`). A per-token capture
overrides the template. To prompt marketplaces to re-fetch, follow with the
collection's ERC-4906 `notifyMetadataUpdate` (owner or admin). Emits
`CaptureTemplateSet`.

## function setCaptures

access: collection owner, admin, or granted capturer (else `NotCaptureAuthorized`)

Sets per-token capture URIs; a single token is a batch of one. Always writable,
since a capture mirrors already-rendered output. To prompt marketplaces to
re-fetch, follow with the collection's ERC-4906 `notifyMetadataUpdate` (owner or
admin). Reverts `LengthMismatch` when the id and URI arrays differ in length.
Emits `CaptureSet` per token.

## function imageFor

The image the bundled renderers serve for a token, resolved in order: the
token's capture if one exists, else the collection's template with `{id}`
replaced by the token id, else the collection cover, else "".

## function coverOf

The collection's shared/cover image URI ("" if none set).

## function templateOf

The collection's capture URI template ("" if none set). Every `{id}` in it
resolves to the token id when `imageFor` reads it.

## function isCapturer

True if the account holds a capturer grant for the collection (owners and
admins do not appear here; their authority comes from the collection itself).

## event CoverSet

Emitted when a collection's cover image changes. Indexed by `collection`.

## event CaptureSet

Emitted per token when captures are set. Indexed by `collection` and
`tokenId`.

## event CaptureTemplateSet

Emitted when a collection's capture template changes. Indexed by
`collection`.

## event CapturerSet

Emitted when a capturer is granted or revoked. Indexed by `collection` and
`account`.

## error NotSurfaceAdmin

A write was attempted by an address that is neither the collection's owner
nor one of its admins.

## error NotCaptureAuthorized

A capture write was attempted by an address that is not the collection's
owner, one of its admins, or a granted capturer.

## error LengthMismatch

`setCaptures` was given id and URI arrays of different lengths.
