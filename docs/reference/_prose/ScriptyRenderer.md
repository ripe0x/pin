---
title: ScriptyRenderer
---

# summary

A forkable [IRenderer](/docs/collections/contracts/i-renderer) template for
script-based generative work, assembled onchain through ScriptyBuilderV2. The
system ships no shared generative assembler; a generative work deploys its own
renderer and sets a collection's renderer pointer to it.

The work definition (the onchain code and dependency files, and the
injection-convention version) is fixed in the constructor and has no setter,
owner, or lock, so the renderer's output is a pure function of chain state.
Combined with the collection's `lockRenderer()`, which pins the renderer
pointer at this contract, the token's presentation is fixed with no post-deploy
step.

At `tokenURI` time it reads the token's seed through
[ISurfaceView](/docs/collections/contracts/i-surface-view), injects the
render context (`window.tokenData = { hash, tokenId, collection, chainId,
version, context }`, the `hash`/`tokenId` pair matching the widely-adopted
long-form-generative shape so existing sketches run unmodified), assembles
the dependencies + context + artist code into a complete HTML document, and
returns metadata whose `animation_url` is a `data:text/html;base64,...` URI.
See the
[Injection convention](/docs/collections/reference/injection-convention) for the
exact parity contract every offchain preview must match, and
[Write a renderer](/docs/collections/guides/write-a-renderer) for the fork
points (`_workTraits`, `_image`, `_headTags`) a subclass overrides.

It also implements the optional
[IPreviewRenderer](/docs/collections/contracts/i-preview-renderer) extension:
`previewURI` renders the same document for a caller-supplied seed, `context` set
to `"preview"`, with no token needing to exist, so an integrator can `eth_call`
sample outputs.

## function tokenURI

Builds the token's metadata JSON and returns it as a
`data:application/json;base64,` URI. The `animation_url` is the assembled HTML
document (`data:text/html;base64,...`): the work's dependency files, then the
injected `window.tokenData` context, then the artist's code, plus a gunzip
helper last when any file is gzipped. `attributes` carries the derived
provenance traits (`Mint Order` in Sequential mode, plus `Seed`) followed by any
seed-derived traits the subclass adds through `_workTraits`. An `image` field is
included only when a subclass returns one from `_image`; by default the
`animation_url` is the artwork. The collection name and image URI are
JSON-escaped before embedding.

## function contractURI

Collection-level metadata as a `data:application/json;base64,` URI, currently
just the escaped collection `name`. Consumed by marketplaces that read
contract-level metadata.

## function previewURI

Implements the OPTIONAL
[IPreviewRenderer](/docs/collections/contracts/i-preview-renderer) extension.
Same document assembly as `tokenURI`, with the caller's `seed` in place of the
token's seed and `context: "preview"` injected in place of `"token"`; no token
needs to exist. The returned metadata is not token provenance: the name is
marked as a preview, `attributes` carries the seed only, and no static `image`
is attached (the `animation_url` render is the preview).

## function code

The artist's algorithm as an ordered list of onchain
[code references](/docs/collections/concepts/types) (`CodeRef[]`), each a storage
contract, a file name, and whether the file is plain or gzipped. Constructor-set,
no setter, so this is the code the renderer assembles at `tokenURI` time. Exposed
for verification.

## function deps

The work's library dependencies as an ordered `CodeRef[]` (gzipped p5, three.js,
and the like), emitted before the injected context and the artist code.
Constructor-set and never mutated; exposed for verification.

## function gunzipFile

The file name of the gunzip helper within `gunzipStore`. Emitted as the last
body tag whenever any dependency or code file is gzipped, so it can decompress
the preceding gzip tags at parse time.

## function gunzipStore

The storage contract holding the gunzip helper. Consulted only when a gzipped
file is present; a build with any gzipped dependency or code file requires it to
be non-zero.

## function injectionVersion

The render-context injection-convention version this renderer targets, echoed to
the work as `tokenData.version`. Immutable.

## function renderAssets

The [RenderAssets](/docs/collections/contracts/render-assets) registry this
renderer reads static images from, or zero when unset. When set, the metadata
`image` resolves through the registry order (capture, template, cover) and
`contractURI` carries the cover; when zero, metadata has no `image` and
`animation_url` is the only render. Immutable; a subclass can override `_image`
for a custom source either way.

## function scriptyBuilder

The ScriptyBuilderV2 contract that assembles the HTML document from the tag
list. Immutable.

## error NoCode

Reverts construction when the `code` array is empty: a renderer with no artist
code has nothing to assemble.

## error BuilderRequired

Reverts construction when the ScriptyBuilderV2 address is zero: the renderer would
have nothing to assemble the HTML document with.

## error GunzipStoreRequired

Reverts at construction when any dependency or code file is gzipped but the
gunzip store is not a deployed contract, so the gzip tags could never be
decompressed in the browser. Refused up front rather than discovered at
`tokenURI` time.

## error StoreNotContract

Reverts at construction when a code or dependency file's `store` is not a
deployed contract (carries the address). An EOA store reverts `tokenURI`, and a
renderer then locked into a collection could not recover, so it is rejected at
construction, the same check the core applies to its renderer pointer.
