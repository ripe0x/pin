---
title: Injection convention
description: How a generative work's code receives its token context, onchain and off, and the determinism rules that make a preview the render.
---

# Injection convention

How a generative work's code receives its token context, onchain and off. This is the load-bearing parity contract of the collection system: the onchain [GenerativeRenderer](/docs/collections/contracts/generative-renderer), the studio previewer, the mint surface, and the artist-site embed must inject the identical object, so a preview is the render.

## The context object

Injected as a plain script, before dependencies and before the artist's code:

```js
window.tokenData = {
  hash: "0x…",        // 32-byte tokenSeed as 0x-prefixed hex (64 chars)
  tokenId: "123",      // decimal string
  collection: "0x…",    // checksum-agnostic lowercase hex address
  chainId: 1,
  version: 1,             // == WorkConfig.injectionVersion
  context: "token"        // why this document is being rendered, see below
};
```

`hash` and `tokenId` deliberately match Art Blocks' `tokenData` shape, so existing AB-style sketches run unmodified. Everything else is additive. Code SHOULD read only documented fields and tolerate additions.

## Execution context

`context` tells the work's code why the document was rendered:

- `"token"`, the canonical render of a real token (`tokenURI`, and any offchain parity render of a minted token). The determinism rules below apply in full; a missing or unknown context MUST be treated as `"token"`.
- `"preview"`, an exploratory what-if render from a throwaway seed (`previewURI` onchain, test seeds in the studio, the mint page's pre-mint explore). Composition MUST be exactly what the same seed would produce as a token, a preview that lies is a bug, but presentation MAY adapt (skip a long intro, for example).
- `"capture"`, an offchain headless render for a static image (thumbnail, OG). Code MAY jump straight to the canonical still (skip animation) and MUST settle on it deterministically.

Previews are also an onchain capability: renderers that can render faithfully from `(tokenId, seed)` alone implement the OPTIONAL `IPreviewRenderer.previewURI(collection, tokenId, seed)` extension. Both [GenerativeRenderer](/docs/collections/contracts/generative-renderer) and the [SVGRenderer](/docs/collections/guides/write-a-renderer) base implement it. Renderers whose output depends on state a preview cannot fake (sibling tokens, companion contracts, hook-recorded mint-time data) simply don't implement it; detection is a try/catch `eth_call`, not ERC-165. A preview document MUST inject `context: "preview"`, and preview metadata carries no provenance attributes, a preview is not a token.

## Determinism rules for pure works



1. All randomness derives from `tokenData.hash` through a seeded PRNG. Never `Math.random()` unseeded, never `crypto.getRandomValues`.
2. No time: no `Date`, no `performance.now()` affecting output. Animation MAY use frame counters; the canonical still is frame-defined.
3. No network: no fetch, no XHR, no websockets, no external assets. Everything renders from the injected context plus bundled dependencies.
4. Resolution independence: identical composition at any canvas size or pixel density.
5. Interaction MAY exist for exploration, but the parameter-free render is the canonical artwork.

## Chain-live and external-live works





## Onchain assembly (GenerativeRenderer)

Body tag order in the assembled HTML:

1. dependencies (`WorkConfig.deps`, each per its `CodeKind`). Dependencies are libraries: they MUST NOT read `tokenData`.
2. the context injection tag (inline `tagContent`, exactly the object above)
3. the artist's code (`WorkConfig.code`, each per its `CodeKind`)
4. gunzip helper (plain script, from onchain storage), LAST, present only when any tag is gzipped. The helper decompresses at its own parse time by scanning the gzip tags that PRECEDE it and replacing each with an executing script tag in document order; placed earlier it would find nothing. Gzipped tags do not execute at parse time, so execution order remains: deps, then (already-parsed) context, then code, with libraries like p5 auto-starting off the late load.

The document is emitted by ScriptyBuilderV2 (`getEncodedHTMLString`) and returned as `data:text/html;base64,…` in the metadata `animation_url`. See [Write a renderer](/docs/collections/guides/write-a-renderer) for how a collection's `renderer` slot points at `GenerativeRenderer` and how `WorkConfig` is set and locked.

## Offchain parity implementations

The studio previewer, mint surface, and artist-page embed build the same document (or an equivalent iframe srcdoc) and MUST:

- inject byte-identical `window.tokenData` (field order irrelevant, values identical; `hash` lowercase hex),
- load the same dependency bytes (from chain, or verified against the onchain hashes),
- never inject additional globals the onchain render lacks, except a provider for chain-live works.

Test seeds in the studio are ordinary `tokenData` objects with synthetic `hash` values and `context: "preview"`; nothing else may differ. Offchain renders of real minted tokens inject `context: "token"`; headless capture tooling injects `context: "capture"`.

## Versioning

`WorkConfig.injectionVersion` pins which revision of this document a work was authored against; the renderer echoes it as `tokenData.version`. Additive changes bump the minor conventions here without a version bump; breaking changes (renamed fields, changed ordering) require a new version and a new renderer, never a mutation of this one.

See [Write a renderer](/docs/collections/guides/write-a-renderer) for implementing or adopting a renderer against this convention, and [GenerativeRenderer](/docs/collections/contracts/generative-renderer) for the generated contract reference of the onchain assembler.

## Seed derivation (the protocol standard)

Every token's canonical entropy is stored once, at mint, on the collection
core, and read via `tokenSeed(tokenId)`:

```solidity
seed = keccak256(abi.encode(block.prevrandao, collectionAddress, tokenId, mintIndex))
```

Each input earns its place: `prevrandao` gives block-level freshness;
`collectionAddress` prevents cross-collection reuse; `tokenId` + `mintIndex`
give per-token and per-instance uniqueness (the index is what re-rolls a
pooled re-mint of the same id). The recipient is deliberately NOT mixed in:
it adds no unpredictability and would bake a minter-identity opinion into
every work.

Properties renderers and archives can rely on:

- **Canonical and renderer-independent**: the seed is a fixed fact of the
  token, derived once in the core — never re-derived by renderers, so
  swapping renderers can never change a token's entropy
- **Pre-mint simulatable**: like all same-block entropy (Art Blocks
  included), the seed can be computed by simulating the mint before sending
  it. Acceptable unpredictability for art; disqualifying for lotteries
- **The substrate, not the ceiling**: an algorithm wanting different seed
  semantics derives its own value from the canonical seed (any pure function
  of it), or records extra mint-time materials (block, recipient, pooled
  order) with a one-line mint hook and reads them in a custom renderer —
  the cost lands only on works that opt in
