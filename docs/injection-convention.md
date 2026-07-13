# Token context injection convention (v1)

How a generative work's code receives its token context, onchain and off.
This is the load-bearing parity contract of the collection system: the
onchain assembler (a work's ScriptyRenderer), the studio previewer, the
mint surface, and the artist-site embed MUST inject the identical object, so a preview is
the render.

## The context object

Injected as a plain script, before dependencies and before the artist's
code:

```js
window.tokenData = {
  hash: "0x…",        // 32-byte tokenSeed as 0x-prefixed hex (64 chars)
  tokenId: "123",     // decimal string
  collection: "0x…",  // checksum-agnostic lowercase hex address
  chainId: 1,
  version: 1          // == the renderer's injectionVersion
};
```

`hash` and `tokenId` deliberately match Art Blocks' `tokenData` shape, so
existing AB-style sketches run unmodified. Everything else is additive.
Code SHOULD read only documented fields and tolerate additions.

## Determinism rules for `pure` works


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


Convention: read through any EIP-1193 provider the host page exposes as
`window.ethereum`, else fall back to a public RPC of the viewer's choice;
never hardcode a single provider as load-bearing. The work MUST render a
coherent fallback state when no provider is reachable. Declared reads
should be published with the work — in its renderer's verification views
or its docs — so tooling and archives know what a faithful render
requires.


honest about that fragility: the archival form of any live work is
"code plus inputs at time T".

## Onchain assembly (ScriptyRenderer)

Body tag order in the assembled HTML:

1. dependencies (the renderer's `deps()`, each per its `CodeKind`).
   Dependencies are libraries: they MUST NOT read `tokenData`.
2. the context injection tag (inline `tagContent`, exactly the object
   above)
3. the artist's code (the renderer's `code()`, each per its `CodeKind`)
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

## The canonical capture (additive)

The mirror of `pnd-collection-thumbnails.md` §3.1: every surface that
captures a still of a token (studio at deploy, mint surface at mint, the
backfill tool later, anyone ever) MUST produce the same frame, or the
"anyone can reproduce it" guarantee breaks.

- **Frame.** A single frame taken after a deterministic warm-up: N draw
  frames or M ms of virtual time, declared per work (default: the first
  stable frame the harness detects). Time is virtual and seeded, never
  wall-clock.
- **Size.** Fixed from the work's aspect ratio at `devicePixelRatio = 1`;
  default 1200px on the long edge.
- **Format.** PNG, no alpha; flatten onto the work's declared background.
- **WebGL.** The renderer must be constructed with
  `preserveDrawingBuffer: true` so the canvas is readable at capture
  time; the harness enforces this for `three` and raw WebGL works.
- **Determinism (`pure` works).** The rules above apply in full: seeded
  PRNG only, no time, no network — the same seed yields the same frame,
  which is what makes a capture a reproducible artifact rather than a
  service output.
- **Output identity.** The uploaded PNG bytes are the canonical
  thumbnail; their content address is the pointer. Pure 2D/canvas work is
  close to byte-reproducible across machines; GPU work is not — store the
  address of the frame actually captured, and treat later re-renders as
  visually-equivalent preservation, not a strict byte match.

Capture is presentation, not the work: the frame lands in RenderAssets
(capture, template, or cover), stays refreshable forever, and never
feeds back into the render.

## Versioning

The renderer's `injectionVersion` (fixed in its constructor) pins which
revision of this document a work was authored against; it echoes it as
`tokenData.version`. Additive changes bump the minor conventions here
without a version bump; breaking changes (renamed fields, changed
ordering) require a new version and a new renderer, never a mutation of
this one.

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
  it. Acceptable unpredictability for art; disqualifying for lotteries.
  The sharp version of this: a contract can mint, read its own seed in the
  same transaction, and revert unless it likes the outcome — rarity sniping
  for the cost of gas. For most work this changes nothing (whoever grinds
  still pays list price for a real token). A drop where rarity variance
  carries serious money can close it with a mint hook — an EOA-only gate,
  or a commit-reveal minter module — and that choice belongs to the work,
  not the core
- **The substrate, not the ceiling**: an algorithm wanting different seed
  semantics derives its own value from the canonical seed (any pure function
  of it), or records extra mint-time materials (block, recipient, pooled
  order) with a one-line mint hook and reads them in a custom renderer —
  the cost lands only on works that opt in
