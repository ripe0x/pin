# Token context injection convention (v1)

How a generative work's code receives its token context, onchain and off.
This is the load-bearing parity contract of the collection system: the
onchain `GenerativeRenderer`, the studio previewer, the mint surface, and
the artist-site embed MUST inject the identical object, so a preview is
the render.

## The context object

Injected as a plain script, before dependencies and before the artist's
code:

```js
window.tokenData = {
  hash: "0x…",        // 32-byte tokenSeed as 0x-prefixed hex (64 chars)
  tokenId: "123",     // decimal string
  mintIndex: 7,       // 0-based mint order (number)
  mintBlock: 19876543,
  collection: "0x…",  // checksum-agnostic lowercase hex address
  chainId: 1,
  version: 1          // == WorkConfig.injectionVersion
};
```

`hash` and `tokenId` deliberately match Art Blocks' `tokenData` shape, so
existing AB-style sketches run unmodified. Everything else is additive.
Code SHOULD read only documented fields and tolerate additions.

## Determinism rules for `pure` works

A work declared `Liveness.Pure` promises: same `tokenData`, same output,
forever, anywhere.

1. All randomness derives from `tokenData.hash` through a seeded PRNG.
   Never `Math.random()` unseeded, never `crypto.getRandomValues`.
2. No time: no `Date`, no `performance.now()` affecting output.
   Animation MAY use frame counters; the canonical still is frame-defined.
3. No network: no fetch, no XHR, no websockets, no external assets.
   Everything renders from the injected context + bundled dependencies.
4. Resolution independence: identical composition at any canvas size or
   pixel density.
5. Interaction MAY exist for exploration, but the parameter-free render
   is the canonical artwork.

## Chain-live and external-live works

`Liveness.ChainLive` works MAY read onchain state at render time.
Convention: read through any EIP-1193 provider the host page exposes as
`window.ethereum`, else fall back to a public RPC of the viewer's choice;
never hardcode a single provider as load-bearing. The work MUST render a
coherent fallback state when no provider is reachable. Declared reads
belong in `WorkConfig.renderParams` so tooling and archives know what a
faithful render requires.

`Liveness.ExternalLive` works read declared offchain sources and are
honest about that fragility: the archival form of any live work is
"code plus inputs at time T".

## Onchain assembly (GenerativeRenderer)

Body tag order in the assembled HTML:

1. dependencies (`WorkConfig.deps`, each per its `CodeKind`).
   Dependencies are libraries: they MUST NOT read `tokenData`.
2. the context injection tag (inline `tagContent`, exactly the object
   above)
3. the artist's code (`WorkConfig.code`, each per its `CodeKind`)
4. gunzip helper (plain script, from onchain storage), LAST, present
   only when any tag is gzipped. The helper decompresses at its own
   parse time by scanning the gzip tags that PRECEDE it and replacing
   each with an executing script tag in document order; placed earlier
   it would find nothing. Gzipped tags do not execute at parse time, so
   execution order remains: deps, then (already-parsed) context, then
   code, with libraries like p5 auto-starting off the late load.

The document is emitted by ScriptyBuilderV2 (`getEncodedHTMLString`) and
returned as `data:text/html;base64,…` in the metadata `animation_url`.

## Offchain parity implementations

The studio previewer, mint surface, and artist-page embed build the same
document (or an equivalent iframe srcdoc) and MUST:

- inject byte-identical `window.tokenData` (field order irrelevant,
  values identical; `hash` lowercase hex),
- load the same dependency bytes (from chain, or verified against the
  onchain hashes),
- never inject additional globals the onchain render lacks, except a
  provider for chain-live works.

Test seeds in the studio are ordinary `tokenData` objects with
synthetic `hash` values; nothing else may differ.

## Versioning

`WorkConfig.injectionVersion` pins which revision of this document a
work was authored against; the renderer echoes it as
`tokenData.version`. Additive changes bump the minor conventions here
without a version bump; breaking changes (renamed fields, changed
ordering) require a new version and a new renderer, never a mutation of
this one.
