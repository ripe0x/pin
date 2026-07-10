---
contract: GenerativeRenderer
slug: generative-renderer
deploymentsKey: generativeRenderer
title: GenerativeRenderer
---

# summary

The default renderer for script-based generative collections: a stateless
shared singleton that assembles a complete HTML document per token and
returns it as the `animation_url` of the token's metadata. Like
[DefaultRenderer](/docs/collections/contracts/default-renderer), it takes the
collection address as an explicit parameter and reads everything it needs
back through [ICollectionView](/docs/collections/contracts/i-renderer): one instance
serves every collection that wants a script-based work.

A collection using GenerativeRenderer stores its executable work as a
[work config](/docs/collections/concepts/four-slots): dependency code and the artist's
own code, each a reference to onchain storage. At render time,
GenerativeRenderer reads that work config plus the token's seed and mint
mark, assembles the HTML body through scripty v2
(`IScriptyBuilderV2.getEncodedHTMLString`), and base64-encodes the result
into `data:text/html;base64,...`. The `scriptyBuilder`, `gunzipStore`, and
`gunzipFile` values are set once at construction and never change, so the
same builder and gunzip helper serve every token of every collection this
renderer draws for. The live view is a pure function of chain state: no
server, no pinning service, nothing to keep running for the render to
resolve.

# concepts

### The injected token context

Before the artist's code runs, GenerativeRenderer injects a plain script
setting `window.tokenData`, matching [the injection convention](/docs/collections/reference/injection-convention)
(render-context v1): `hash` (the token's seed as 0x-prefixed hex),
`tokenId`, `collection`, `chainId`, and `version`
(echoing the work's `injectionVersion`). `hash` and `tokenId` deliberately
match the widely-adopted long-form-generative `tokenData` shape, so
existing sketches written against that convention run unmodified against a
PND collection.

Body tag order is fixed and load-bearing: dependencies, then the context
script, then the artist's code, then the gunzip helper last (only present
when any preceding tag is gzip-compressed). The gunzip helper decompresses
at its own parse time by scanning the gzip tags that precede it in the
document and replacing each with an executing script tag, in document
order; placed anywhere earlier it would find nothing to decompress. See
[the injection convention](/docs/collections/reference/injection-convention) for the
full parity contract between this onchain assembly and the offchain studio
previewer, mint surface, and artist-site embed, and
[write a renderer](/docs/collections/guides/write-a-renderer) for building a renderer
against a work config of your own.

## function tokenURI

Assembles the token's HTML document and returns the full metadata JSON as
a `data:application/json;base64,` URI. `name` is the collection name plus
`#tokenId`; `animation_url` is the assembled `data:text/html;base64,...`
document; `image` is included only if the token has artwork set (its own
override, else the collection's shared cover) and is omitted from the JSON
entirely when neither is set. `attributes` carries Mint Order (sequential-id
collections only, where the token id is the mint order) and Seed (the
token's seed as 0x-prefixed hex, read from `tokenSeed`); pooled-mode
collections get the Seed trait only. Reverts if the collection's work config has no
code set (`work.code.length == 0`); a collection must have a work wired
before this renderer can serve it.

## function contractURI

Collection-level metadata as a `data:application/json;base64,` URI: the
collection `name`, plus an `image` field with the collection's shared
`artwork()` when one is set.

## function scriptyBuilder

The immutable [ScriptyBuilderV2](https://github.com/intractable/scripty)
instance this renderer assembles HTML through. Set once at construction;
every token from every collection this renderer serves goes through the
same builder.

## function gunzipStore

The immutable EthFS-style storage contract address holding the gunzip
helper script, emitted as the final body tag whenever any dependency or
code file is gzip-compressed. Fixed at construction.

## function gunzipFile

The file name of the gunzip helper within `gunzipStore`. Set once in the
constructor; Solidity strings can't be declared `immutable`, but there is
no setter, so the value is fixed for the life of the renderer.

## function setWork

access: collection owner or admin (`onlyCollectionAdmin`, else `NotCollectionAdmin`)

Sets or replaces `collection`'s work definition in this renderer's registry —
the code refs, dependencies, integrity hash, injection version, and render
params the renderer assembles at `tokenURI` time. Presentation data lives in
renderer-land: the collection core stores none of this. Authority borrows the
collection's own owner/admin root, so publishing the work carries exactly the
same authority as the collection's setters. Reverts `WorkIsLocked` once
`lockWork(collection)` has run. Emits `WorkSet`.

## function lockWork

access: collection owner or admin (`onlyCollectionAdmin`, else `NotCollectionAdmin`)

One-way: permanently locks `collection`'s work definition so `setWork` can
never change it again. Together with the collection's `lockRenderer()` (pin
the pointer at this immutable contract) this is full presentation permanence
for a generative work. Reverts `WorkIsLocked` if already locked. Emits
`WorkLocked`.

## function workOf

The stored work definition for a collection, as this renderer will assemble
it. Empty (no code refs) until `setWork` runs.

## function workLockedOf

True once `lockWork(collection)` has permanently locked that collection's
work definition.

## function renderAssets

The RenderAssets registry this renderer reads static images from (per-token
capture, else collection cover) for the `image` field beside the live
`animation_url`.

## event WorkSet

Emitted when a collection's work definition is set or replaced, carrying the
new `codeHash`. Indexed by `collection`.

## event WorkLocked

Emitted once when a collection's work definition is permanently locked.
Indexed by `collection`.

## error NotCollectionAdmin

`setWork` or `lockWork` was called by an address that is neither the
collection's owner nor one of its admins.

## error WorkIsLocked

`setWork` or `lockWork` was called after `lockWork`. The work definition is
permanently frozen for that collection.
