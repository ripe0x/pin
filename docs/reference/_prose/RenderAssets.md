---
title: RenderAssets
---

# summary

The renderer-land registry of static display assets: each collection's shared
cover image, per-token captures (thumbnails of rendered output), and a capture
template that resolves per token id. One immutable, ownerless singleton serves
every collection; the cover and role grants are gated by each collection's own
owner/admin authority, while the two capture writes may also be delegated to
narrow, admin-granted capturer keys.

This registry exists so the collection core stores NO presentation data — the
core's `tokenURI` defers wholly to its renderer, and the bundled
[DefaultRenderer](/docs/collections/contracts/default-renderer) (and any
renderer that opts in) reads its static images here. Captures are deliberately
always refreshable: they are convenience mirrors of rendered output for
surfaces that cannot run it, not part of the art. The art's permanence is the
collection's `lockRenderer()` plus whatever immutability the renderer itself
offers (an immutable renderer, or its own one-way lock). That is also why the
capturer role is safe to delegate: the worst a bad capturer can do is point at
a wrong thumbnail, and the next write fixes it.

## function setCover

access: collection owner or admin (`onlyCollectionAdmin`, else `NotCollectionAdmin`)

Sets the collection's shared/cover image URI ("" clears it). The bundled
renderers fall back to this for any token without a capture or template. Emits
`CoverSet`.

## function setCapturer

access: collection owner or admin (`onlyCollectionAdmin`, else `NotCollectionAdmin`)

Grants or revokes a capturer for the collection: a narrow key that may write
captures and the capture template, and nothing else. Lets an artist run
thumbnail automation on a low-privilege hot key, or delegate capture-writing
to a mint surface, without handing over an admin key that could reroute money
or authorize minters. The grant itself is never capturer-writable. Emits
`CapturerSet`.

## function setCaptureTemplate

access: collection owner, admin, or granted capturer (else `NotCaptureAuthorized`)

Sets the collection's capture URI template ("" clears it). Every `{id}` in the
template resolves to the token id at read time, so one small write covers a
whole drop's thumbnails at once — publish a manifest of frames (e.g.
`ar://<manifest>/{id}.png`), point the template at it, done. Explicit per-token
captures still win over the template. To nudge marketplaces to re-fetch,
follow up with the collection's ERC-4906 `notifyMetadataUpdate` (owner/admin
may call it). Emits `CaptureTemplateSet`.

## function setCaptures

access: collection owner, admin, or granted capturer (else `NotCaptureAuthorized`)

Sets per-token capture URIs; a single token is a batch of one. Always
available — a capture mirrors already-rendered output, so refreshing one can
never change the art. To nudge marketplaces to re-fetch, follow up with the
collection's ERC-4906 `notifyMetadataUpdate` (owner/admin may call it).
Reverts `LengthMismatch` when the id and URI arrays differ in length. Emits
`CaptureSet` per token.

## function imageFor

The image the bundled renderers serve for a token, resolved down a ladder:
the token's capture if one exists, else the collection's template with `{id}`
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

## error NotCollectionAdmin

A write was attempted by an address that is neither the collection's owner
nor one of its admins.

## error NotCaptureAuthorized

A capture write was attempted by an address that is not the collection's
owner, one of its admins, or a granted capturer.

## error LengthMismatch

`setCaptures` was given id and URI arrays of different lengths.
